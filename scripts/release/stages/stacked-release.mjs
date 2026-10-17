/**
 * Narrow support for one explicitly declared predecessor on staging.
 *
 * Nothing is inferred from timestamps or migration names. The predecessor's manifest, immutable release state and
 * four schema captures must all agree before its expected schema can be accepted as the successor's base. Production
 * remains ordered: a successor cannot even precheck production until the predecessor is RELEASE_COMPLETE.
 */
import { createHash } from "node:crypto";
import { loadReleaseManifest, manifestFile } from "../lib/manifest.mjs";
import { CheckFailed, HumanActionRequired, releaseStates } from "../lib/report.mjs";
import { environments } from "../lib/target.mjs";
import { acceptCapture, compareSchemas, differenceLine } from "../drift/compare.mjs";

const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const sorted = (items) => [...items].sort();
const versions = (manifest) => manifest.migrations.map((item) => item.file.slice(0, 14)).sort();
const rehearsed = (manifest) => manifest.migrations.map(({ file, sha256 }) => ({ file, sha256 }));
const sameRehearsal = (a, b) => a.length === b.length && a.every((item, index) => item.file === b[index].file && item.sha256 === b[index].sha256);
const rank = (state) => releaseStates.indexOf(state);
const delta = (after, before) => sorted(after.filter((version) => !before.includes(version)));
const differences = (first, second, names) => compareSchemas(first, second).differences.slice(0, 10).map((item) => differenceLine(item, names));
const manifestHash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

export function loadDeclaredPredecessor(root, successor) {
  if (!successor.predecessorRelease) return null;
  const loaded = loadReleaseManifest(root, successor.predecessorRelease);
  if (loaded.manifest.predecessorRelease) throw new CheckFailed("Stacked release chains longer than one predecessor are not supported.", {
    stage: "predecessor", details: [`${successor.predecessorRelease} declares ${loaded.manifest.predecessorRelease}`],
  });
  return loaded;
}

/** Load and cryptographically/schema-wise validate the predecessor evidence already saved by its own release. */
export function loadPredecessorEvidence({ root, state, git, successor }) {
  const declared = loadDeclaredPredecessor(root, successor);
  if (!declared) return null;
  const release = successor.predecessorRelease;
  const saved = state.load(release, "release-state")?.data ?? null;
  const problems = [];
  if (!successor.migrations.length) problems.push("a stacked successor must declare at least one migration of its own");
  if (!saved) problems.push("the predecessor has no release state");
  else {
    if (saved.releaseId !== release) problems.push("the predecessor state names another release");
    if (saved.manifestHash !== declared.hash) problems.push("the predecessor manifest hash differs from its saved state");
    if (saved.sourceCommit !== declared.manifest.sourceCommit) problems.push("the predecessor source commit differs from its saved state");
    if (rank(saved.state) < rank("STAGING_VERIFIED")) problems.push(`the predecessor state is ${saved.state ?? "empty"}, before STAGING_VERIFIED`);
  }
  const verified = saved?.history?.filter((entry) => entry.state === "STAGING_VERIFIED" && entry.result === "PASS").at(-1) ?? null;
  if (!verified) problems.push("the predecessor has no passing STAGING_VERIFIED record");
  else {
    if (verified.environment !== "staging") problems.push("the predecessor was not verified on staging");
    if (git.commit(verified.commit) !== verified.commit) problems.push("the predecessor's verified commit does not exist in this repository");
    else if (!git.isAncestor(declared.manifest.sourceCommit, verified.commit)) problems.push("the predecessor's verified commit does not descend from its source commit");
    else {
      const extra = git.changedFiles(declared.manifest.sourceCommit, verified.commit).filter((file) => file !== manifestFile(release));
      if (extra.length) problems.push(`the predecessor's verified commit changes files after its source commit: ${extra.slice(0, 5).join(", ")}`);
      const committedManifest = git.fileAt(verified.commit, manifestFile(release));
      if (!committedManifest || manifestHash(committedManifest) !== declared.hash) problems.push("the predecessor manifest at its verified commit does not match the declared manifest hash");
    }
  }

  const load = (name) => {
    const item = state.load(release, name);
    if (!item) { problems.push(`the predecessor is missing ${name}`); return null; }
    try { return acceptCapture(item.data, `${release}/${name}`); }
    catch (error) { problems.push(error.message); return null; }
  };
  const base = load("schema-base"), expected = load("schema-expected"), staging = load("schema-staging"), production = load("schema-production");
  if (base && expected && staging && production) {
    const migrations = rehearsed(declared.manifest), predecessorVersions = versions(declared.manifest);
    if (!sameRehearsal(expected.meta.rehearsed, migrations)) problems.push("the predecessor's expected capture was rehearsed with different migrations or hashes");
    if (base.meta.rehearsed.length || staging.meta.rehearsed.length || production.meta.rehearsed.length) problems.push("a non-expected predecessor capture claims to be a rehearsal result");
    if (verified && staging.meta.gitCommit !== verified.commit) problems.push("the predecessor's staging capture is not from its verified commit");
    if (base.meta.ref !== environments.staging.ref || expected.meta.ref !== environments.staging.ref || staging.meta.ref !== environments.staging.ref)
      problems.push("the predecessor's staging captures target another project");
    if (production.meta.ref !== environments.production.ref) problems.push("the predecessor's production capture targets another project");
    if (!compareSchemas(expected, staging).ok) problems.push("the predecessor's verified staging schema is not its rehearsed expected schema");
    if (!compareSchemas(base, production).ok) problems.push("the predecessor's saved production schema is not its rehearsed base schema");
    if (!same(sorted(base.appliedMigrations), sorted(expected.appliedMigrations))) problems.push("the predecessor rehearsal changed migration history");
    if (!same(sorted(base.appliedMigrations), sorted(production.appliedMigrations))) problems.push("production's predecessor history is not the predecessor base history");
    if (!same(delta(staging.appliedMigrations, production.appliedMigrations), predecessorVersions) || delta(production.appliedMigrations, staging.appliedMigrations).length)
      problems.push("the predecessor migrations are not exactly the extra migrations applied on staging");
  }
  if (problems.length) throw new CheckFailed("The declared predecessor cannot be trusted.", { stage: "predecessor", details: problems.slice(0, 20) });
  return { release, manifest: declared.manifest, manifestHash: declared.hash, state: saved, verified, base, expected, staging, production, versions: versions(declared.manifest) };
}

/** Step D: production plus exactly the predecessor must equal the successor's rehearsed base. */
export function judgeStackedBase({ predecessor, base, production, successor }) {
  if (!predecessor) return { ok: false, problems: ["no predecessor was declared"] };
  const problems = [];
  const expectedVsBase = differences(predecessor.expected, base, ["predecessor expected", "successor base"]);
  const predecessorBaseVsProd = differences(predecessor.base, production, ["predecessor base", "production"]);
  if (expectedVsBase.length) problems.push("the successor base is not exactly the predecessor expected schema", ...expectedVsBase);
  if (predecessorBaseVsProd.length) problems.push("production is not exactly the predecessor base schema", ...predecessorBaseVsProd);
  if (!same(sorted(base.appliedMigrations), sorted(predecessor.staging.appliedMigrations))) problems.push("the successor base migration history differs from the predecessor's verified staging history");
  if (!same(sorted(production.appliedMigrations), sorted(predecessor.production.appliedMigrations))) problems.push("production migration history differs from the predecessor's saved production history");
  if (!same(delta(base.appliedMigrations, production.appliedMigrations), predecessor.versions) || delta(production.appliedMigrations, base.appliedMigrations).length)
    problems.push("staging minus production is not exactly the predecessor migrations");
  const own = versions(successor);
  if (own.some((version) => base.appliedMigrations.includes(version) || production.appliedMigrations.includes(version))) problems.push("a successor migration is already present before its apply");
  return { ok: problems.length === 0, problems };
}

/** Step J: retain the stacked base proof and require only the successor's measured change on top. */
export function judgeStackedExpected({ predecessor, base, expected, staging, production, successor }) {
  const baseVerdict = judgeStackedBase({ predecessor, base, production, successor });
  const problems = [...baseVerdict.problems];
  const expectedVsStaging = differences(expected, staging, ["successor expected", "staging"]);
  if (expectedVsStaging.length) problems.push("staging is not exactly the successor expected schema", ...expectedVsStaging);
  if (!sameRehearsal(expected.meta.rehearsed, rehearsed(successor))) problems.push("the successor expected capture was rehearsed with different migrations or hashes");
  if (!same(sorted(expected.appliedMigrations), sorted(base.appliedMigrations))) problems.push("the successor rehearsal changed migration history");
  const all = sorted([...predecessor.versions, ...versions(successor)]);
  if (!same(delta(staging.appliedMigrations, production.appliedMigrations), all) || delta(production.appliedMigrations, staging.appliedMigrations).length)
    problems.push("staging minus production is not exactly predecessor plus successor migrations");
  return { ok: problems.length === 0, problems, explained: compareSchemas(base, expected).differences };
}

/** Production stays strictly ordered even though staging may be stacked. */
export function predecessorProductionProblems({ root, state, git, successor }) {
  const predecessor = loadPredecessorEvidence({ root, state, git, successor });
  if (!predecessor) return [];
  const complete = predecessor.state.state === "RELEASE_COMPLETE" && predecessor.state.history.some((entry) => entry.state === "RELEASE_COMPLETE" && entry.result === "PASS" && entry.environment === "production");
  return complete ? [] : [`predecessor ${predecessor.release} is ${predecessor.state.state ?? "empty"}, not RELEASE_COMPLETE in production`];
}

export function requirePredecessorProductionComplete(context) {
  const problems = predecessorProductionProblems(context);
  if (problems.length) throw new HumanActionRequired("The predecessor must complete production before this release can continue there.", { stage: "predecessor", details: problems });
}
