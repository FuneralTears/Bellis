/**
 * Release tooling: `bellis:staging`. Takes a release to staging, and only to staging.
 *
 *   A  preconditions   the static checks always; the local ones unless this commit and manifest already passed them
 *   B  current state   the migration history of staging: nothing applied that is not here, and what is pending is
 *                      exactly the release (none of it applied, or all of it: anything in between stops everything)
 *   C  snapshot pre    counts and fingerprints of staging's data
 *   E  rehearsal       the release's migrations in one transaction on staging that is rolled back: base and expected
 *   D  production      production's schema, read-only, has to be exactly base
 *   F  smokes          the manifest's groups, with the migrations inside each smoke's transaction
 *   G  dry run         `db push --dry-run` has to list exactly the release's migrations
 *   H  apply           the target, the history and the hashes are checked again, the write guard is passed, then
 *                      `db push`
 *   I  history         everything applied, nothing pending, nothing unknown
 *   K  smokes          the same groups, without pending migrations
 *   L  snapshot post   identical to pre; a difference stops the release for a person to review
 *   M  residue         no synthetic user, workspace or slug left
 *   J  expected drift  staging is exactly expected, production (read again) is still exactly base
 *   N  Preview         never automated: a person confirms it with --confirm-preview, when the manifest asks for it
 *
 * Every block runs inside withTarget, so the CLI is back on staging, confirmed, whatever happens. Production is only
 * ever read. A release without migrations has no rehearsal and no apply: staging and production have to match
 * exactly instead.
 *
 * Running it again: before the apply it starts over; after the apply it does not apply again and goes on with the
 * checks, but only if this release was rehearsed (its state and its captures are there); with part of the release
 * applied it stops. --reuse-rehearsal <folder> is the one explicit way to resume an applied release whose state lost
 * its rehearsal: an earlier rehearsal of the same release is reused only after every check of rehearsal-reuse.mjs.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { short } from "../lib/git.mjs";
import { CheckFailed, HumanActionRequired, PreconditionError, checkSections, createReport, redact } from "../lib/report.mjs";
import { assertWritable, withTarget } from "../lib/target.mjs";
import { captureSchema } from "../drift/capture.mjs";
import { acceptCapture, compareSchemas, differenceLine as driftLine } from "../drift/compare.mjs";
import { explainExpected, rehearse } from "../drift/migration-diff.mjs";
import { resolvePending, runSmokes } from "../smoke/runner.mjs";
import { loadConfig } from "../snapshot/build-sql.mjs";
import { captureSnapshot } from "../snapshot/capture.mjs";
import { acceptSnapshot, compareSnapshots, differenceLine as snapshotLine } from "../snapshot/compare.mjs";
import { localChecks, staticChecks } from "./check.mjs";
import { compareHistory, migrationHistory, residue } from "./database.mjs";
import { openReleaseState } from "./release-state.mjs";
import { judgeRehearsalReuse, readEarlierRehearsal, reuseRecordName } from "./rehearsal-reuse.mjs";

const localFiles = (root) => readdirSync(join(root, "supabase", "migrations")).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const total = (capture) => Object.values(capture.counts).reduce((sum, value) => sum + value, 0);

/**
 * Data changes a release is allowed to make. None, today: any difference between the snapshots stops the release
 * for a person. When a release needs one it will be declared explicitly and checked here, never assumed.
 */
export function judgeDataChanges(comparison) {
  return comparison.ok ? { ok: true } : { ok: false, reason: "data changes are never accepted automatically: a person has to review them" };
}

/**
 * How far the release has got on staging: "empty" (it has no migrations), "apply" (none of them applied yet),
 * "all" (all of them applied already) or "partial".
 */
export function releaseMode(applied, files) {
  if (!files.length) return "empty";
  const done = files.filter((file) => applied.includes(file.slice(0, 14))).length;
  return done === 0 ? "apply" : done === files.length ? "all" : "partial";
}

export async function runStaging({ root, git, supabase, environment = process.env, home, release, report, runLocal, commands, signals, state, now = () => new Date(), reuseRehearsal = null }) {
  // A. Preconditions. The static checks run every time; the slow local ones once per commit and manifest.
  const found = staticChecks({ root, git, release, report });
  if (!found.ok) throw new CheckFailed("The release does not pass its checks. Nothing was sent to Supabase.", { stage: "check" });
  const { manifest, hash, head, smokeManifest, smokes } = found;
  const files = manifest.migrations.map((item) => item.file);
  const progress = openReleaseState(state, release, { manifest, manifestHash: hash, now });
  try {
    const checkedHere = progress.history.some((entry) => entry.state === "CHECKED" && entry.commit === head && entry.result === "PASS");
    const releaseLines = report.get("RELEASE").lines;
    if (checkedHere) report.set("RELEASE", "INFO", [...releaseLines, "local checks: passed before for this commit and manifest, not run again"]);
    else {
      // The local checks write to a report of their own; this one gets one line per check.
      const local = createReport("check", { sections: checkSections });
      const ok = await localChecks({ root, git, supabase, environment, home, report: local, manifest, commands, runLocal });
      const summary = ["TOOLING", "TESTS", "TYPESCRIPT", "LINT", "BUILD"].map((name) => `${name.toLowerCase()} ${local.get(name).status}`).join(", ");
      report.set("RELEASE", ok ? "INFO" : "FAIL", [...releaseLines, `local checks: ${summary}`, ...(ok ? [] : ["TOOLING", "TESTS", "TYPESCRIPT", "LINT", "BUILD"].filter((name) => local.get(name).status !== "PASS").flatMap((name) => local.get(name).lines.map((item) => `${name.toLowerCase()}: ${item}`)))]);
      if (!ok) throw new CheckFailed("A local check failed. Nothing was sent to Supabase.", { stage: "check" });
    }
    progress.advance("CHECKED", { commit: head, detail: checkedHere ? "local checks reused: same commit and manifest" : "bellis:check passed" });
    return await toStaging({ root, git, supabase, environment, release, report, signals, state, now, manifest, head, files, smokeManifest, smokes, progress, reuseRehearsal });
  } catch (error) {
    progress.note(error?.stage ?? "staging", { commit: head, environment: "staging", result: "FAIL", detail: redact(error?.message ?? String(error), 200) });
    throw error;
  }
}

async function toStaging({ root, git, supabase, environment, release, report, signals, state, now, manifest, head, files, smokeManifest, smokes, progress, reuseRehearsal }) {
  const target = { environment, signals };
  const record = (to, detail, where = "staging") => progress.advance(to, { commit: head, environment: where, detail });
  const save = (name, data) => state.save(release, name, data);
  const load = (name, accept) => { const saved = state.load(release, name); return saved ? accept(saved.data, name) : null; };
  const pending = () => resolvePending(root, files, { release });
  const smokeCount = { passed: 0, total: 0 }; const smokeLines = [];
  const runGroup = (withMigrations, label) => {
    const outcome = runSmokes({ root, supabase, manifest: smokeManifest, smokes, pending: withMigrations, environment });
    smokeCount.passed += outcome.counts.passed; smokeCount.total += outcome.counts.total;
    smokeLines.push(`${label}: ${outcome.counts.passed}/${outcome.counts.total} PASS, self-test ${outcome.selfTests.filter((item) => item.ok).length}/${outcome.selfTests.length}${outcome.rollbackVerified ? ", rollbacks verified" : ""}`);
    report.set("SMOKES", outcome.ok ? "PASS" : "FAIL", [...smokeLines, ...outcome.results.filter((item) => item.status !== "PASS").slice(0, 10).map((item) => `${item.status} ${item.id}: ${item.reason ?? ""}`)]);
    if (!outcome.ok) throw new CheckFailed(`The smokes failed (${label}).`, { stage: "smokes" });
  };
  const readProduction = async () => (await withTarget(supabase, "production", async () => captureSchema({ supabase, target: "production", release, label: "production", gitCommit: head, environment }), target)).result;

  // B, C, E: staging, before anything is written.
  const { base, expected, mode } = (await withTarget(supabase, "staging", async (on) => {
    const applied = migrationHistory(supabase); const { pending: waiting, remoteOnly } = compareHistory(applied, localFiles(root));
    report.set("MIGRATIONS", "INFO", [`staging has ${applied.length} migration(s) applied`, `pending on staging: ${waiting.length ? waiting.join(", ") : "none"}`, `release: ${files.length ? files.join(", ") : "no migrations"}`]);
    if (remoteOnly.length) throw new CheckFailed("Staging has migrations that are not in this repository.", { stage: "migration history", details: remoteOnly.map((version) => `applied on staging, not here: ${version}`) });
    const mode = releaseMode(applied, files);
    if (mode === "partial") throw new CheckFailed("Only part of the release is applied on staging. A person has to look at it before anything else runs.", { stage: "migration history", details: files.map((file) => `${file}: ${applied.includes(file.slice(0, 14)) ? "applied" : "not applied"}`) });
    const others = waiting.filter((file) => !files.includes(file));
    if (others.length) throw new CheckFailed("Staging has pending migrations that are not part of this release.", { stage: "migration history", details: others.map((file) => `pending, not in the release: ${file}`) });
    if (mode === "apply" && !same(waiting, files)) throw new CheckFailed("What is pending on staging is not exactly the release.", { stage: "migration history", details: [`pending: ${waiting.join(", ") || "none"}`, `release: ${files.join(", ")}`] });
    if (reuseRehearsal && mode !== "all") throw new PreconditionError("--reuse-rehearsal is only for a release whose migrations are all applied on staging already. Nothing was reused.", { stage: "rehearsal reuse" });

    if (mode === "all") {
      // Already applied: nothing is applied again, and no rehearsal is made up after the fact.
      const base = load("schema-base", acceptCapture), expected = load("schema-expected", acceptCapture);
      if (!progress.reached("REHEARSED") || !base || !expected || !same(expected.meta.rehearsed.map((item) => item.file), files)) {
        if (!reuseRehearsal) throw new HumanActionRequired("The release's migrations are already applied on staging, and there is no rehearsal of this release to check them against.", { stage: "rehearsal", details: ["it cannot be rehearsed after the fact: a person has to decide how to verify it"] });
        return reuse(on, waiting);
      }
      const reused = state.load(release, reuseRecordName)?.data;
      if (!load("snapshot-staging-pre", acceptSnapshot)) throw new HumanActionRequired("The release is applied on staging but its data snapshot from before is missing.", { stage: "snapshot" });
      report.set("REHEARSAL", "PASS", reused ? [`REUSED earlier: the rehearsal of ${reused.source} (${reused.rehearsedAt}), verified ${reused.verifiedAt}; not run again`] : [`rehearsed before the apply (${expected.meta.capturedAt}); not run again`]);
      return { base, expected, mode };
    }
    const pre = captureSnapshot({ supabase, config: loadConfig(root), target: "staging", release, label: "staging-pre", commit: head, environment });
    save("snapshot-staging-pre", pre);
    report.set("SNAPSHOT", "INFO", [`pre: ${pre.tables.length} table(s), ${pre.tables.reduce((sum, item) => sum + item.count, 0)} row(s)`]);
    if (mode === "empty") {
      const base = captureSchema({ supabase, target: "staging", release, label: "base", gitCommit: head, environment }); save("schema-base", base);
      report.set("REHEARSAL", "NOT NEEDED", ["the release has no migrations"]);
      return { base, expected: null, mode };
    }
    on.assertOnTarget();
    const { base, expected, changes } = rehearse({ supabase, pending: pending(), release, gitCommit: head, environment });
    save("schema-base", base); save("schema-expected", expected);
    report.set("REHEARSAL", "PASS", [`the release changes ${changes.differences.length} object(s), measured in a transaction that was rolled back`, ...changes.differences.slice(0, 15).map((item) => driftLine(item, ["before", "after"]))]);
    record("REHEARSED", `${changes.differences.length} object(s) change`);
    return { base, expected, mode };
  }, target)).result;

  /**
   * --reuse-rehearsal: every condition of rehearsal-reuse.mjs, checked against staging captured now (read only). Only
   * then are the earlier base and expected kept as this release's, with a record of where they came from; the data
   * snapshot "before" is taken now, before the smokes, so the snapshot after still has to be identical.
   */
  function reuse(on, waiting) {
    if (waiting.length) throw new CheckFailed("Staging has pending migrations: an earlier rehearsal cannot be reused.", { stage: "rehearsal reuse", details: waiting.map((file) => `pending: ${file}`) });
    const earlier = readEarlierRehearsal(state, reuseRehearsal);
    const stagingNow = captureSchema({ supabase, target: "staging", release, label: "staging-reuse", gitCommit: head, environment });
    const verdict = judgeRehearsalReuse({ release, manifest, head, git, earlier, stagingNow, now });
    if (!verdict.ok) { report.set("REHEARSAL", "FAIL", [`the rehearsal of ${redact(String(reuseRehearsal), 80)} cannot be reused`, ...verdict.problems]); throw new CheckFailed("The earlier rehearsal cannot be reused. Nothing was reused or saved.", { stage: "rehearsal reuse", details: verdict.problems }); }
    on.assertOnTarget();
    save("schema-base", verdict.base); save("schema-expected", verdict.expected); save(reuseRecordName, verdict.record);
    const pre = captureSnapshot({ supabase, config: loadConfig(root), target: "staging", release, label: "staging-pre", commit: head, environment });
    save("snapshot-staging-pre", pre);
    record("REHEARSED", `REUSED the rehearsal of ${verdict.record.source} (${verdict.record.rehearsalCommit.slice(0, 7)}): same migrations and SHA-256, staging an exact match of its expected schema`);
    report.set("REHEARSAL", "PASS", [`REUSED: the rehearsal of ${verdict.record.source}, made at ${verdict.record.rehearsalCommit.slice(0, 7)} (${verdict.record.rehearsedAt}); not run again`,
      ...verdict.record.migrationHashes.map((item) => `${item.file}: sha256 ${item.sha256.slice(0, 12)}, the same as rehearsed`),
      `staging now: EXACT MATCH of the rehearsal's expected schema (${verdict.record.schemaExpectedHash.slice(0, 12)})`,
      "the rehearsal's commit descends from the main base and is an ancestor of HEAD; no migration changed since",
      `data snapshot before taken now: ${pre.tables.length} table(s)`]);
    return { base: verdict.base, expected: verdict.expected, mode: "all" };
  }

  // D. Production, read-only: it has to be exactly what the release starts from.
  const productionBefore = await readProduction(); save("schema-production", productionBefore);
  const startsFrom = compareSchemas(base, productionBefore);
  if (!startsFrom.ok) { report.set("EXPECTED DRIFT", "FAIL", ["production is not the schema the release starts from", ...startsFrom.differences.slice(0, 15).map((item) => driftLine(item, ["staging base", "production"]))]); throw new CheckFailed("Production does not match the base of the release.", { stage: "drift base" }); }

  // F, G, H, I, K, L, M: staging.
  const stagingAfter = (await withTarget(supabase, "staging", async (on) => {
    if (mode === "apply") runGroup(pending(), "with the pending migrations");
    const dry = supabase.push({ dryRun: true });
    if (!dry.ok) { report.set("DRY RUN", "FAIL", [dry.reason]); throw new CheckFailed("The dry run could not be read. Nothing was applied.", { stage: "dry run" }); }
    const wanted = mode === "apply" ? files : [];
    if (!same(dry.migrations, wanted) || dry.seeds || dry.roles) { report.set("DRY RUN", "FAIL", [`would apply: ${dry.migrations.join(", ") || "nothing"}`, `expected: ${wanted.join(", ") || "nothing"}`, dry.seeds || dry.roles ? "it would also push seeds or roles" : null]); throw new CheckFailed("The dry run does not list exactly the release's migrations. Nothing was applied.", { stage: "dry run" }); }
    report.set("DRY RUN", "PASS", [wanted.length ? `lists exactly: ${wanted.join(", ")}` : "nothing to apply"]);

    if (mode === "apply") {
      // H. Right before the write: the target, the history and the files, once more, and the write guard.
      on.assertOnTarget(); assertWritable(supabase, "staging", { environment, operation: "applying migrations" });
      const again = compareHistory(migrationHistory(supabase), localFiles(root));
      if (!same(again.pending, files) || again.remoteOnly.length) throw new CheckFailed("Staging changed while the release was being prepared. Nothing was applied.", { stage: "apply" });
      pending();
      on.assertOnTarget(); assertWritable(supabase, "staging", { environment, operation: "applying migrations" });
      const pushed = supabase.push({ dryRun: false, writeConfirmed: true });
      if (!pushed.ok) { report.set("STAGING APPLY", "FAIL", [pushed.reason, "staging may be partly migrated: look at it before running anything else"]); throw new CheckFailed("Applying the migrations failed.", { stage: "apply" }); }
      record("STAGING_APPLIED", `applied ${files.join(", ")}`);
      report.set("STAGING APPLY", "PASS", [`applied: ${files.join(", ")}`]);
    } else if (mode === "all") {
      if (!progress.reached("STAGING_APPLIED")) record("STAGING_APPLIED", "found applied on staging: resumed after the apply");
      report.set("STAGING APPLY", "NOT NEEDED", ["already applied before this run; not applied again"]);
    } else report.set("STAGING APPLY", "NOT NEEDED", ["the release has no migrations"]);

    // I. The history after the release.
    const after = compareHistory(migrationHistory(supabase), localFiles(root));
    if (after.pending.length || after.remoteOnly.length) report.set("MIGRATIONS", "FAIL", [`pending on staging after the release: ${after.pending.join(", ") || "none"}`, `applied on staging, not here: ${after.remoteOnly.join(", ") || "none"}`]);
    if (after.pending.length || after.remoteOnly.length) throw new CheckFailed("Staging's migration history is not what it should be after the release.", { stage: "history", details: [`pending: ${after.pending.join(", ") || "none"}`, `unknown: ${after.remoteOnly.join(", ") || "none"}`] });
    report.set("MIGRATIONS", "PASS", [files.length ? `release applied on staging: ${files.join(", ")}` : "the release has no migrations", "nothing pending on staging, nothing applied that is not in this repository"]);

    const schema = captureSchema({ supabase, target: "staging", release, label: "staging", gitCommit: head, environment }); save("schema-staging", schema);
    runGroup([], "after the release");
    const pre = load("snapshot-staging-pre", acceptSnapshot);
    const post = captureSnapshot({ supabase, config: loadConfig(root), target: "staging", release, label: "staging-post", commit: head, environment }); save("snapshot-staging-post", post);
    const data = compareSnapshots(pre, post); const judged = judgeDataChanges(data);
    if (!judged.ok) { report.set("SNAPSHOT", "DIFFERENT", [data.comparable ? `${data.different.length} table(s) differ` : "not comparable", ...data.problems, ...data.different.slice(0, 15).map(snapshotLine), judged.reason]); throw new CheckFailed("The data on staging changed. A person has to review it.", { stage: "snapshot" }); }
    report.set("SNAPSHOT", "IDENTICAL", [`pre and post: ${data.rows.length} table(s), same counts and fingerprints`]);
    const left = residue(supabase);
    if (left.total) { report.set("RESIDUE", "FOUND", Object.entries(left.counts).filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`)); throw new CheckFailed("The smokes left something behind on staging.", { stage: "residue" }); }
    report.set("RESIDUE", "NONE", ["0 synthetic users, 0 synthetic workspaces, 0 smoke slugs"]);
    return schema;
  }, target)).result;

  // J. Production read again: still exactly the base. Staging: exactly what was rehearsed (or, with no migrations, production).
  const productionAfter = await readProduction(); save("schema-production", productionAfter);
  if (files.length) {
    const seen = explainExpected({ base, expected, staging: stagingAfter, production: productionAfter, pending: pending() });
    if (!seen.ok) { report.set("EXPECTED DRIFT", "FAIL", [...seen.problems, ...seen.drift.slice(0, 10).map((item) => `DRIFT ${driftLine(item, ["base", "production"])}`), ...seen.unexplained.slice(0, 10).map((item) => `UNEXPLAINED ${driftLine(item, ["expected", "staging"])}`)]); throw new CheckFailed("The schemas are not what the rehearsal said they would be.", { stage: "expected drift" }); }
    report.set("EXPECTED DRIFT", "PASS", ["staging is exactly what was rehearsed; production is still exactly the base", `${seen.explained.length} object(s) differ between them, all of them the release`]);
  } else {
    const exact = compareSchemas(stagingAfter, productionAfter);
    if (!exact.ok) { report.set("EXPECTED DRIFT", "FAIL", exact.differences.slice(0, 15).map((item) => driftLine(item, ["staging", "production"]))); throw new CheckFailed("Staging and production do not match, and the release has no migrations to explain it.", { stage: "drift" }); }
    report.set("EXPECTED DRIFT", "PASS", [`EXACT MATCH: staging and production, ${total(stagingAfter)} object(s)`]);
  }
  record("STAGING_VERIFIED", `smokes ${smokeCount.passed}/${smokeCount.total}, snapshot identical, no residue`);

  // N. The Preview: looked at by a person, or not needed.
  if (!manifest.previewRequired) { record("STAGING_COMPLETE", "the manifest says the Preview does not need a person"); report.set("PREVIEW", "N/A", ["previewRequired is false in the manifest"]); }
  else if (progress.reached("STAGING_COMPLETE")) report.set("PREVIEW", "PASS", ["confirmed earlier by a person (not verified by this tool)"]);
  else { record("PREVIEW_PENDING", "waiting for a person to look at the Preview", "vercel"); report.set("PREVIEW", "HUMAN VERIFICATION REQUIRED", [`look at the Vercel Preview of ${short(head)}, then run: npm run bellis:staging -- --release ${release} --confirm-preview ${release}`]); }
  return { state: progress.state, smokes: smokeCount };
}

/**
 * --confirm-preview: a person says they looked at the Preview. It writes nothing but the release's state, needs the
 * release to be waiting for exactly that at this same commit, and needs the release id typed again.
 */
export function confirmPreview({ root, git, release, typed, report, state, now = () => new Date() }) {
  const found = staticChecks({ root, git, release, report });
  if (!found.ok) throw new CheckFailed("The release does not pass its checks.", { stage: "check" });
  if (typed !== release) throw new PreconditionError(`To confirm, type the release id again: --confirm-preview ${release}`);
  const progress = openReleaseState(state, release, { manifest: found.manifest, manifestHash: found.hash, now });
  if (progress.state !== "PREVIEW_PENDING") throw new PreconditionError(`Release ${release} is not waiting for its Preview (it is at ${progress.state ?? "nothing"}).`);
  const verified = [...progress.history].reverse().find((entry) => entry.state === "STAGING_VERIFIED");
  if (verified?.commit !== found.head) throw new PreconditionError("The repository is not at the commit that was verified on staging.");
  progress.advance("STAGING_COMPLETE", { commit: found.head, environment: "vercel", detail: "a person confirmed the Preview; this tool did not verify it" });
  report.set("PREVIEW", "PASS", ["confirmed by a person (not verified by this tool)"]);
}
