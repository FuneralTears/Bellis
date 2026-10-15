/**
 * Release tooling: `bellis:staging --release <id> --reuse-rehearsal <folder>`. For one case only: the release's
 * migrations are already applied on staging and this release's state has no rehearsal of its own (its earlier state
 * was moved aside, for example because the source commit changed without touching any migration). An earlier
 * rehearsal of the same release, kept in <folder> of the releases directory, is reused only if all of this holds:
 *
 *   1. the earlier state is of this same release (inside the files, not only by folder name) and its rehearsal
 *      finished (REHEARSED, PASS);
 *   2. its base and expected captures are there, complete and valid, of staging, of this release, from one commit;
 *   3. the migrations it rehearsed are exactly the manifest's, in the same order, with the same SHA-256;
 *   4. the commit it was rehearsed at descends from the manifest's main base and is an ancestor of HEAD, and no
 *      migration file changed between that commit and HEAD;
 *   5. (checked by the caller) all of the release is applied on staging and nothing is pending or unknown;
 *   6. staging, captured now, is an EXACT MATCH of the earlier expected schema.
 *
 * Anything else fails closed: nothing is reused, nothing is saved, and there is no way around it. What was reused is
 * written down in the release's state (rehearsal-reuse) and in the report. Nothing here writes to a database.
 */
import { createHash } from "node:crypto";
import { acceptCapture, compareSchemas } from "../drift/compare.mjs";
import { releaseStates } from "../lib/report.mjs";
import { stateName } from "./release-state.mjs";

export const reuseRecordName = "rehearsal-reuse";
const folderPattern = /^[a-z0-9][a-z0-9._-]{1,60}$/;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** A fingerprint of a schema capture: every object id with its hash, category by category. */
export const schemaHash = (capture) => sha256(JSON.stringify(Object.keys(capture.objects).sort().map((category) => [category, capture.objects[category].map((item) => [item.id, item.hash])])));

/** The three files of an earlier state, read as they are, with the release written inside each one. */
export function readEarlierRehearsal(state, folder) {
  if (!folderPattern.test(String(folder ?? ""))) return null;
  return { folder, releaseState: state.read(folder, stateName), base: state.read(folder, "schema-base"), expected: state.read(folder, "schema-expected") };
}

/**
 * Whether the earlier rehearsal can stand for this release. `stagingNow` is staging's schema captured in this run.
 * Returns { ok, problems, record }: the record is what goes into the release's state when it is ok.
 */
export function judgeRehearsalReuse({ release, manifest, head, git, earlier, stagingNow, now = () => new Date() }) {
  const problems = []; const fail = (text) => { problems.push(text); return { ok: false, problems, record: null }; };
  if (!earlier) return fail("the earlier state is not a release folder name");
  if (earlier.folder === release) return fail("the earlier state has to be another folder than this release's own");
  const { releaseState, base, expected } = earlier;
  if (!releaseState) return fail(`${earlier.folder}: has no release state`);
  if (releaseState.release !== release || releaseState.data?.releaseId !== release) return fail(`${earlier.folder}: is the state of another release`);
  const history = Array.isArray(releaseState.data?.history) ? releaseState.data.history : [];
  const rehearsed = history.find((entry) => entry?.state === "REHEARSED" && entry?.result === "PASS" && !entry?.rerun);
  if (!rehearsed || releaseStates.indexOf(releaseState.data?.state) < releaseStates.indexOf("REHEARSED")) return fail(`${earlier.folder}: its rehearsal did not finish`);
  if (!base) return fail(`${earlier.folder}: the base capture of the rehearsal is missing`);
  if (!expected) return fail(`${earlier.folder}: the expected capture of the rehearsal is missing`);
  if (base.release !== release || expected.release !== release) return fail(`${earlier.folder}: the captures belong to another release`);
  const captures = {};
  for (const [name, document] of [["base", base], ["expected", expected]]) {
    try { captures[name] = acceptCapture(document.data, `${earlier.folder}/schema-${name}`); } catch { return fail(`${earlier.folder}: the ${name} capture is incomplete or not valid`); }
    const meta = captures[name].meta;
    if (meta.label !== name || meta.environment !== "staging" || meta.release !== release) return fail(`${earlier.folder}: the ${name} capture is not the ${name} of this release on staging`);
  }
  const commit = captures.expected.meta.gitCommit;
  if (!commit || captures.base.meta.gitCommit !== commit) return fail(`${earlier.folder}: base and expected were not captured at one known commit`);
  // The same migrations, in the same order, with the same hashes.
  const wanted = manifest.migrations.map((item) => `${item.file}:${item.sha256}`), had = captures.expected.meta.rehearsed.map((item) => `${item.file}:${item.sha256}`);
  if (!wanted.length) return fail("this release has no migrations: there is nothing to reuse");
  if (wanted.length !== had.length || wanted.some((item, index) => item !== had[index])) {
    for (let index = 0; index < Math.max(wanted.length, had.length); index++) if (wanted[index] !== had[index]) problems.push(`rehearsed ${had[index] ?? "nothing"}, the release has ${wanted[index] ?? "nothing"}`);
    return fail("the rehearsed migrations are not exactly the release's (names, order and SHA-256)");
  }
  // Where it was rehearsed: on the way from the main base to HEAD, with no migration changed since.
  if (!git.isAncestor(manifest.expectedMainBase, commit)) return fail(`the rehearsal's commit ${commit.slice(0, 7)} does not descend from the release's main base`);
  if (!git.isAncestor(commit, head)) return fail(`the rehearsal's commit ${commit.slice(0, 7)} is not an ancestor of HEAD`);
  let changed;
  try { changed = git.changedFiles(commit, head).filter((path) => path.startsWith("supabase/migrations/")); } catch { return fail("the changes since the rehearsal could not be read"); }
  if (changed.length) return fail(`migrations changed since the rehearsal: ${changed.slice(0, 5).join(", ")}`);
  // Staging today is exactly what the rehearsal said it would be.
  const exact = compareSchemas(captures.expected, stagingNow);
  if (!exact.ok) { problems.push(...exact.differences.slice(0, 10).map((item) => `${item.change} ${item.category} ${item.id}`)); return fail(`staging is not an exact match of the rehearsal's expected schema (${exact.differences.length} difference(s))`); }
  return { ok: true, problems, base: captures.base, expected: captures.expected, record: {
    mode: "reused", source: earlier.folder, sourceRelease: release, sourceCommit: releaseState.data.sourceCommit ?? null, rehearsalCommit: commit,
    rehearsedAt: rehearsed.at ?? captures.expected.meta.capturedAt, migrationHashes: manifest.migrations.map((item) => ({ file: item.file, sha256: item.sha256 })),
    schemaBaseHash: schemaHash(captures.base), schemaExpectedHash: schemaHash(captures.expected), stagingMatch: "EXACT MATCH",
    verifiedAt: now().toISOString(), actor: "tooling" } };
}
