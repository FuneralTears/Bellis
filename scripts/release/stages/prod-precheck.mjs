/**
 * Release tooling: `bellis:backup-check` and `bellis:prod-precheck`. Production is read, never written.
 *
 * prod-precheck, in this order:
 *   A  the release: manifest, git, migrations (static checks), and the release has to be STAGING_COMPLETE
 *   B  the backups of public and private (local files only). One missing is exit 4, before Supabase is touched.
 *      staging, read: still exactly what the rehearsal said (or, with no migrations, the base)
 *   C  production, read: target confirmed two ways (withTarget), and from here on only through a read-only CLI
 *   D  its migration history: nothing unknown, pending exactly the release
 *   E  its schema: exactly the base the release was rehearsed on; with staging, exactly what the release explains
 *   F  a data snapshot of production (snapshot-prod-pre)
 *   G  `db push --dry-run`: exactly the release's migrations, or nothing
 *   H  a second snapshot after the dry run: identical, or a person reviews it
 *   I  PROD_PRECHECK_COMPLETE, with what was checked; it expires after 2 hours
 * The state is only written when everything passed. Every step that touches Supabase runs through `readOnly`, so a
 * write (a real push, SQL that is not a read-only transaction) is refused before the CLI runs.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { short } from "../lib/git.mjs";
import { readOnly } from "../lib/guard.mjs";
import { loadReleaseManifest } from "../lib/manifest.mjs";
import { CheckFailed, HumanActionRequired, checkSections, createReport, redact } from "../lib/report.mjs";
import { environments, withTarget } from "../lib/target.mjs";
import { backupLines, backupsDir, validateBackups } from "../backup/validate.mjs";
import { captureSchema } from "../drift/capture.mjs";
import { acceptCapture, compareSchemas, differenceLine as driftLine } from "../drift/compare.mjs";
import { explainExpected } from "../drift/migration-diff.mjs";
import { resolvePending } from "../smoke/runner.mjs";
import { loadConfig } from "../snapshot/build-sql.mjs";
import { captureSnapshot } from "../snapshot/capture.mjs";
import { compareSnapshots, differenceLine as snapshotLine } from "../snapshot/compare.mjs";
import { staticChecks } from "./check.mjs";
import { compareHistory, migrationHistory } from "./database.mjs";
import { openReleaseState } from "./release-state.mjs";
import { requirePredecessorProductionComplete } from "./stacked-release.mjs";

export const precheckLifetimeHours = 2;
export const precheckName = "prod-precheck";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** One hash for the release's migrations: their names and contents, in order. */
export const migrationSetHash = (migrations) => sha256(JSON.stringify(migrations.map((item) => [item.file, item.sha256])));
const schemaHash = (capture) => sha256(JSON.stringify(Object.keys(capture.objects).sort().map((category) => [category, capture.objects[category].map((item) => [item.id, item.hash])])));
const snapshotHash = (snapshot) => sha256(JSON.stringify(snapshot.tables.map((item) => [item.table, item.count, item.fingerprint ?? null])));
const localFiles = (root) => readdirSync(join(root, "supabase", "migrations")).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const statusOfBackup = { PASS: "PASS", REQUIRED: "REQUIRED", HUMAN: "HUMAN", FAIL: "FAIL" };

/** The captures of the release that say what production has (base) and will have (expected). */
function releaseCaptures(state, release, manifest) {
  const load = (name) => { const saved = state.load(release, name); return saved ? acceptCapture(saved.data, name) : null; };
  const base = load("schema-base"); const expected = manifest.migrations.length ? load("schema-expected") : null;
  return { base, expected };
}

/** Checks both backups and fills BACKUP PUBLIC and BACKUP PRIVATE. Returns the results; throws when one is not PASS. */
export function checkBackups({ root, release, manifest, state, report, environment, home, paths, listToc, now, maxAgeHours }) {
  const { base, expected } = releaseCaptures(state, release, manifest);
  if (!base || (manifest.migrations.length && !expected)) {
    for (const section of ["BACKUP PUBLIC", "BACKUP PRIVATE"]) report.set(section, "HUMAN", ["there is no capture of production's schema for this release: run bellis:staging first"]);
    throw new HumanActionRequired("The backups cannot be checked: the release has no schema capture to check them against.", { stage: "backups" });
  }
  const results = validateBackups({ release, base, expected, root, dir: backupsDir(environment, home), paths, listToc, now, maxAgeHours });
  for (const [schema, check] of Object.entries(results)) report.set(`BACKUP ${schema.toUpperCase()}`, statusOfBackup[check.status], backupLines(check));
  const statuses = Object.values(results).map((check) => check.status);
  if (statuses.includes("FAIL")) throw new CheckFailed("A backup does not pass.", { stage: "backups" });
  if (statuses.some((status) => status !== "PASS")) throw new HumanActionRequired("A backup is missing or needs a person to look at it. Nothing was sent to Supabase.", { stage: "backups",
    details: Object.values(results).filter((check) => check.status !== "PASS").map((check) => `${check.schema}: ${check.status}${check.problems[0] ? ` (${redact(check.problems[0], 160)})` : ""}`) });
  return results;
}

/** `bellis:backup-check`: the two backups, local files only. The result is kept in the release's folder. */
export function runBackupCheck({ root, release, report, state, environment, home, paths, listToc, now = () => new Date(), maxAgeHours }) {
  const { manifest, hash } = loadReleaseManifest(root, release);
  report.set("RELEASE", "INFO", [`${release}: manifest sha256 ${hash.slice(0, 12)}, ${manifest.migrations.length} migration(s)`, `backups in ${backupsDir(environment, home)}`]);
  let results = null;
  try { results = checkBackups({ root, release, manifest, state, report, environment, home, paths, listToc, now, maxAgeHours }); }
  finally {
    const saved = Object.fromEntries(["public", "private"].map((schema) => { const check = results?.[schema]; const section = report.get(`BACKUP ${schema.toUpperCase()}`); return [schema, check ? { status: check.status, metadata: check.metadata } : { status: section?.status ?? "N/A" }]; }));
    state.save(release, "backup-check", { checkedAt: now().toISOString(), manifestHash: hash, backups: saved });
  }
  return results;
}

/** Whether a saved precheck can be reused now: same commit, manifest and migrations, not expired, files unchanged. */
export function reusablePrecheck(saved, { head, manifestHash, migrationSet, now }) {
  if (!saved) return { ok: false, reason: "there is no precheck to reuse" };
  if (saved.head !== head || saved.manifestHash !== manifestHash || saved.migrationSet !== migrationSet) return { ok: false, reason: "the commit, the manifest or the migrations changed since it was made" };
  if (Date.parse(saved.precheckExpiresAt) <= now().getTime()) return { ok: false, reason: `it expired at ${saved.precheckExpiresAt}` };
  return { ok: true };
}

export async function runPrecheck({ root, git, supabase, environment = process.env, home, release, report, state, listToc, signals, paths = {}, reuse = false, now = () => new Date(), maxAgeHours }) {
  // A. The release, locally. Its static checks write to a report of their own; this one gets a summary.
  const local = createReport("check", { sections: checkSections });
  const found = staticChecks({ root, git, release, report: local });
  const summary = ["GIT", "MIGRATIONS", "SMOKES"].map((name) => `${name.toLowerCase()} ${local.get(name).status}`).join(", ");
  report.set("RELEASE", found.ok ? "INFO" : "FAIL", [...local.get("RELEASE").lines, `checks: ${summary}`, ...(found.ok ? [] : ["GIT", "MIGRATIONS", "SMOKES"].flatMap((name) => local.get(name).lines.filter((line) => /FAIL|differs|not /.test(line))))]);
  if (!found.ok) throw new CheckFailed("The release does not pass its checks. Nothing was sent to Supabase.", { stage: "release" });
  const { manifest, hash, head } = found; const files = manifest.migrations.map((item) => item.file); const migrationSet = migrationSetHash(manifest.migrations);
  const progress = openReleaseState(state, release, { manifest, manifestHash: hash, now });
  requirePredecessorProductionComplete({ root, state, git, successor: manifest });
  const verified = progress.history.some((entry) => entry.state === "STAGING_VERIFIED" && entry.result === "PASS");
  if (!progress.reached("STAGING_COMPLETE") || !verified) { report.set("STAGING STATE", "HUMAN", [`the release is at ${progress.state ?? "nothing"}; it has to be STAGING_COMPLETE (bellis:staging)`]); throw new HumanActionRequired("The release has not completed staging.", { stage: "staging state" }); }
  report.set("STAGING STATE", "STAGING_COMPLETE", [`verified on staging at ${short([...progress.history].reverse().find((entry) => entry.state === "STAGING_VERIFIED").commit)}`]);

  // Reuse: only a precheck of this same commit, manifest and migrations that has not expired, with its backups unchanged.
  const saved = state.load(release, precheckName)?.data ?? null;
  if (reuse) {
    const reusable = reusablePrecheck(saved, { head, manifestHash: hash, migrationSet, now });
    const missingFiles = reusable.ok ? Object.values(saved.backups).filter((item) => !existsSync(join(backupsDir(environment, home), item.file))).map((item) => item.file) : [];
    if (reusable.ok && !missingFiles.length && supabase.linkedRef() === environments.staging.ref) {
      const results = checkBackups({ root, release, manifest, state, report, environment, home, paths, listToc, now, maxAgeHours });
      const changed = Object.entries(results).filter(([schema, check]) => check.metadata?.sha256 !== saved.backups[schema]?.sha256).map(([schema]) => schema);
      if (!changed.length) {
        for (const [section, line] of [["PROD TARGET", `checked at ${saved.precheckCompletedAt}`], ["PROD MIGRATIONS", `pending: ${saved.pending.join(", ") || "none"}`], ["PROD SNAPSHOT", `snapshot-prod-pre (${saved.snapshotHash.slice(0, 12)})`], ["PROD DRY RUN", `listed: ${saved.dryRun.join(", ") || "nothing"}`], ["DATA INTEGRITY", "identical before and after the dry run"]]) report.set(section, "PASS", [line, "reused, not checked again"]);
        report.set("PROD DRIFT", "MATCH", ["reused, not checked again"]);
        report.set("PRECHECK EXPIRY", "INFO", [`completed ${saved.precheckCompletedAt}`, `expires ${saved.precheckExpiresAt}`, "reused: commit, manifest, migrations and backup files are the same"]);
        report.set("SAFE TO APPLY PROD?", "YES", ["until the precheck expires"]);
        return { reused: true };
      }
      report.set("PRECHECK EXPIRY", "INFO", [`not reused: the backups of ${changed.join(", ")} changed`]);
    } else report.set("PRECHECK EXPIRY", "INFO", [`not reused: ${!reusable.ok ? reusable.reason : missingFiles.length ? `backup files are gone: ${missingFiles.join(", ")}` : "the CLI is not on staging"}; a full precheck runs`]);
  }

  // B. Backups, before Supabase is touched at all.
  const backups = checkBackups({ root, release, manifest, state, report, environment, home, paths, listToc, now, maxAgeHours });
  const { base, expected } = releaseCaptures(state, release, manifest);
  const cli = readOnly(supabase, { operation: "prod-precheck" }); const target = { environment, signals };

  // Staging, read: it has to be what the release left it as.
  const stagingNow = (await withTarget(cli, "staging", async () => captureSchema({ supabase: cli, target: "staging", release, label: "staging-precheck", gitCommit: head, environment }), target)).result;

  // C to H. Production, read-only.
  const seen = (await withTarget(cli, "production", async (on) => {
    report.set("PROD TARGET", "PASS", [`${environments.production.label} (${environments.production.ref}), linked and confirmed with the account's list of projects`, "read-only from here on: writes are refused before they run"]);
    const applied = migrationHistory(cli); const { pending, remoteOnly } = compareHistory(applied, localFiles(root));
    const historyLines = [`remote: ${applied.length} applied (latest ${applied.at(-1) ?? "none"})`, `local: ${localFiles(root).length}`, `pending: ${pending.join(", ") || "none"}`, `release: ${files.join(", ") || "no migrations"}`];
    if (remoteOnly.length || !same(pending, files)) { report.set("PROD MIGRATIONS", "FAIL", [...historyLines, remoteOnly.length ? `applied on production, not here: ${remoteOnly.join(", ")}` : null, !same(pending, files) ? "what is pending on production is not exactly the release" : null]); throw new CheckFailed("Production's migration history does not match the release.", { stage: "prod migrations" }); }
    report.set("PROD MIGRATIONS", "PASS", historyLines);
    const schema = captureSchema({ supabase: cli, target: "production", release, label: "production-precheck", gitCommit: head, environment });
    on.assertOnTarget();
    const config = loadConfig(root);
    let before;
    try { before = captureSnapshot({ supabase: cli, config, target: "production", release, label: "prod-pre", commit: head, environment }); }
    catch (error) { report.set("PROD SNAPSHOT", "FAIL", [redact(error.message, 200), ...(error.details ?? []).slice(0, 5)]); throw error; }
    report.set("PROD SNAPSHOT", "PASS", [`${before.tables.length} table(s), ${before.tables.reduce((sum, item) => sum + item.count, 0)} row(s), read-only`]);
    const dry = cli.push({ dryRun: true });
    if (!dry.ok || !same(dry.migrations, files) || dry.seeds || dry.roles) { report.set("PROD DRY RUN", "FAIL", [dry.ok ? `would apply: ${dry.migrations.join(", ") || "nothing"}` : dry.reason, `expected: ${files.join(", ") || "nothing"}`, dry.seeds || dry.roles ? "it would also push seeds or roles" : null]); throw new CheckFailed("The dry run on production does not list exactly the release's migrations.", { stage: "prod dry run" }); }
    report.set("PROD DRY RUN", "PASS", [files.length ? `lists exactly: ${files.join(", ")}` : "nothing pending"]);
    const after = captureSnapshot({ supabase: cli, config, target: "production", release, label: "prod-pre-check", commit: head, environment });
    on.assertOnTarget();
    return { schema, before, after, pending, dry };
  }, target)).result;

  // E. The schema: exactly the base, and with staging exactly what the release explains.
  const fromBase = compareSchemas(base, seen.schema);
  if (files.length) {
    const explained = explainExpected({ base, expected, staging: stagingNow, production: seen.schema, pending: resolvePending(root, files, { release }) });
    if (!explained.ok || !fromBase.ok) { report.set("PROD DRIFT", "DRIFT", [...explained.problems, ...explained.drift.slice(0, 10).map((item) => `DRIFT ${driftLine(item, ["base", "production"])}`), ...explained.unexplained.slice(0, 10).map((item) => `UNEXPLAINED ${driftLine(item, ["expected", "staging"])}`)]); throw new CheckFailed("Production or staging is not what the release was rehearsed on.", { stage: "prod drift" }); }
    report.set("PROD DRIFT", "MATCH", ["production is exactly the base the release was rehearsed on", `staging is exactly what was rehearsed: ${explained.explained.length} object(s) differ, all of them the release`]);
  } else {
    const exact = compareSchemas(stagingNow, seen.schema);
    if (!exact.ok || !fromBase.ok) { report.set("PROD DRIFT", "DRIFT", [...exact.differences, ...fromBase.differences].slice(0, 15).map((item) => driftLine(item, ["staging", "production"]))); throw new CheckFailed("Staging and production do not match, and the release has no migrations to explain it.", { stage: "prod drift" }); }
    report.set("PROD DRIFT", "MATCH", [`EXACT MATCH: staging, production and the release's base, ${Object.values(seen.schema.counts).reduce((sum, value) => sum + value, 0)} object(s)`]);
  }
  // H. Nothing changed while the precheck looked: not by the dry run, not by anything else.
  const still = compareSnapshots(seen.before, seen.after);
  if (!still.ok) { report.set("DATA INTEGRITY", "FAIL", [...still.problems, ...still.different.slice(0, 10).map(snapshotLine), "data changed during the precheck: a person has to review it; it is never accepted automatically"]); throw new CheckFailed("Production's data changed during the precheck.", { stage: "data integrity" }); }
  report.set("DATA INTEGRITY", "PASS", ["the data of production is identical before and after the dry run", "no change attributable to the tooling: events, audits, automation runs included"]);

  // I. Ready, for two hours, for exactly this commit, manifest, migrations and backups.
  const completedAt = now(); const expiresAt = new Date(completedAt.getTime() + precheckLifetimeHours * 3_600_000);
  state.save(release, "snapshot-prod-pre", seen.before); state.save(release, "schema-production-precheck", seen.schema);
  state.save(release, precheckName, { release, sourceCommit: manifest.sourceCommit, head, manifestHash: hash, migrationSet, migrations: manifest.migrations, prodRef: environments.production.ref,
    precheckCompletedAt: completedAt.toISOString(), precheckExpiresAt: expiresAt.toISOString(), backups: Object.fromEntries(Object.entries(backups).map(([schema, check]) => [schema, check.metadata])),
    schemaHash: schemaHash(seen.schema), stagingSchemaHash: schemaHash(stagingNow), snapshotHash: snapshotHash(seen.before), pending: seen.pending, dryRun: seen.dry.migrations });
  progress.advance("PROD_PRECHECK_COMPLETE", { commit: head, environment: "production", detail: `read-only precheck passed; expires ${expiresAt.toISOString()}` });
  report.set("PRECHECK EXPIRY", "INFO", [...(report.get("PRECHECK EXPIRY").lines ?? []), `completed ${completedAt.toISOString()}`, `expires ${expiresAt.toISOString()} (${precheckLifetimeHours} hours)`, "prod-release will need the same commit, manifest and migrations, before it expires"]);
  report.set("SAFE TO APPLY PROD?", "YES", ["until the precheck expires"]);
  return { reused: false };
}
