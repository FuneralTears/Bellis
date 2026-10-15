/**
 * Release tooling: `bellis:prod-release`. The only command that writes to production.
 *
 * It cannot start by accident. Three things are needed at once, and none of them is kept anywhere:
 *   CONFIRM_PROD_RELEASE=<release-id>@<short commit>   in the environment
 *   a valid precheck (PROD_PRECHECK_COMPLETE, same commit, manifest and migrations, not expired)
 *   the release id typed again, in an interactive terminal
 * The commit is the release commit: the one verified on staging (the source commit plus its manifest), which is what
 * main is moved to.
 *
 * Then, in order. Everything before the apply only reads; if anything changed since the precheck, nothing is written:
 *   locally      manifest, git (clean, branch, source commit, main where expected, fast-forward), state, backups
 *   staging      read: still exactly what the release was rehearsed to be
 *   production   read: history (pending exactly the release), schema (exactly the base), dry run (exactly the
 *                release), data (exactly the precheck's snapshot)
 *   apply        inside withProdWriteAuthorization, right after assertOnTarget and the hashes once more
 *   verify       history, schema (production = staging = expected), smokes (transactions rolled back), data
 *                (identical to the precheck's), residue                                        → PROD_VERIFIED
 *   main         fetched, still where expected on the remote, pushed as a fast-forward            → MAIN_ADVANCED
 *   deployment   found through GitHub, waited for, verified with its alias                       → DEPLOY_PROD_VERIFIED
 *   QA           public pages, without a login                                                    → RELEASE_COMPLETE
 * Once production has been written (or main pushed), any failure is exit 5, and the state says how far it got.
 * Every block runs inside withTarget: the CLI ends on staging whatever happens.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { short } from "../lib/git.mjs";
import { readOnly, withProdWriteAuthorization } from "../lib/guard.mjs";
import { CheckFailed, EXIT, FailureAfterProdWrite, HumanActionRequired, checkSections, createReport, exitCodeFor, redact } from "../lib/report.mjs";
import { assertWritable, environments, withTarget } from "../lib/target.mjs";
import { backupsDir } from "../backup/validate.mjs";
import { cleanOrigin, discoverDeployment, productionAlias, qaPaths, techQa, verifyDeployment } from "../deploy/verify.mjs";
import { captureSchema } from "../drift/capture.mjs";
import { acceptCapture, compareSchemas, differenceLine as driftLine } from "../drift/compare.mjs";
import { resolvePending, runSmokes } from "../smoke/runner.mjs";
import { loadConfig } from "../snapshot/build-sql.mjs";
import { captureSnapshot } from "../snapshot/capture.mjs";
import { acceptSnapshot, compareSnapshots, differenceLine as snapshotLine } from "../snapshot/compare.mjs";
import { staticChecks } from "./check.mjs";
import { compareHistory, migrationHistory, residue } from "./database.mjs";
import { deployStateName } from "./deploy-check.mjs";
import { migrationSetHash, precheckName, reusablePrecheck } from "./prod-precheck.mjs";
import { openReleaseState } from "./release-state.mjs";

export { qaPaths };
export const timing = Object.freeze({ deployTimeoutMs: 15 * 60_000, deployIntervalMs: 15_000, aliasAttempts: 12, aliasIntervalMs: 15_000 });
const localFiles = (root) => readdirSync(join(root, "supabase", "migrations")).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const fileHash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The release id typed again, in an interactive terminal. Null when there is no terminal to ask in. */
export async function askInTerminal(question) {
  if (!process.stdin.isTTY) return null;
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise((resolve) => lines.question(question, (answer) => resolve(answer.trim()))); } finally { lines.close(); }
}

export async function runProdRelease({ root, git, supabase, environment = process.env, home, release, report, state, signals, prompt = askInTerminal, fetchImpl = fetch, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), alias = productionAlias, timings = timing }) {
  // Locally: the release, its state, its precheck, its backups, the approval. Nothing remote yet.
  const local = createReport("check", { sections: checkSections });
  const found = staticChecks({ root, git, release, report: local });
  report.set("RELEASE", found.ok ? "INFO" : "FAIL", [...local.get("RELEASE").lines, `checks: ${["GIT", "MIGRATIONS", "SMOKES"].map((name) => `${name.toLowerCase()} ${local.get(name).status}`).join(", ")}`,
    ...(found.ok ? [] : ["GIT", "MIGRATIONS", "SMOKES"].flatMap((name) => local.get(name).lines.filter((line) => /FAIL|differs|not /.test(line))))]);
  if (!found.ok) throw new CheckFailed("The release does not pass its checks. Nothing was sent anywhere.", { stage: "release" });
  const { manifest, hash, head } = found; const files = manifest.migrations.map((item) => item.file); const migrationSet = migrationSetHash(manifest.migrations);
  const progress = openReleaseState(state, release, { manifest, manifestHash: hash, now });
  const saved = state.load(release, precheckName)?.data ?? null;
  const reusable = reusablePrecheck(saved, { head, manifestHash: hash, migrationSet, now });
  const problems = [];
  if (!progress.reached("STAGING_COMPLETE")) problems.push(`the release is at ${progress.state ?? "nothing"}, not STAGING_COMPLETE`);
  if (progress.state !== "PROD_PRECHECK_COMPLETE") problems.push(progress.reached("PROD_APPLIED") ? `the release already went further on production (${progress.state}): a person has to decide what to do` : "the release has no PROD_PRECHECK_COMPLETE");
  if (manifest.previewRequired) { const preview = state.load(release, deployStateName)?.data?.preview; if (preview?.state !== "DEPLOY_PREVIEW_VERIFIED" || preview.expectedCommit !== head) problems.push("the Preview of this commit has not been verified (DEPLOY_PREVIEW_VERIFIED)"); }
  report.set("PRECHECK", reusable.ok ? "VALID" : saved && /expired/.test(reusable.reason) ? "EXPIRED" : saved ? "FAIL" : "REQUIRED", reusable.ok ? [`completed ${saved.precheckCompletedAt}`, `expires ${saved.precheckExpiresAt}`] : [reusable.reason]);
  if (!reusable.ok) problems.push(`no valid precheck: ${reusable.reason}`);
  if (reusable.ok) for (const [schema, item] of Object.entries(saved.backups)) {
    const file = join(backupsDir(environment, home), item.file);
    if (!existsSync(file)) problems.push(`the ${schema} backup is gone: ${item.file}`); else if (fileHash(file) !== item.sha256) { report.set("PRECHECK", "FAIL", [`the ${schema} backup changed since the precheck`]); throw new CheckFailed(`The ${schema} backup is not the file the precheck checked.`, { stage: "backups" }); }
  }
  const wanted = `${release}@${short(head)}`;
  const approved = environment.CONFIRM_PROD_RELEASE === wanted;
  report.set("HUMAN APPROVAL", approved ? "PASS" : "REQUIRED", [approved ? "CONFIRM_PROD_RELEASE names this release and commit" : `set CONFIRM_PROD_RELEASE=${wanted} for this run only`]);
  if (supabase.linkedRef() !== environments.staging.ref) problems.push("the CLI is not on staging to begin with");
  if (problems.length || !approved) {
    if (problems.length) report.set("STATE", progress.state ?? "N/A", problems);
    throw new HumanActionRequired("The release cannot go to production yet. Nothing was sent anywhere.", { stage: "preconditions", details: [...problems, ...(approved ? [] : [`CONFIRM_PROD_RELEASE is not ${wanted}`])] });
  }
  const typed = await prompt(`Type the release id (${release}) to release it to production: `);
  if (typed !== release) { report.set("HUMAN APPROVAL", "REQUIRED", [typed === null ? "the release id has to be typed in an interactive terminal" : "what was typed is not the release id"]); throw new HumanActionRequired("The release id was not typed. Nothing was sent anywhere.", { stage: "approval" }); }
  report.set("HUMAN APPROVAL", "PASS", ["CONFIRM_PROD_RELEASE and the release id typed again; neither is kept"]);

  const load = (name, accept) => { const item = state.load(release, name); return item ? accept(item.data, name) : null; };
  const base = load("schema-base", acceptCapture); const expected = files.length ? load("schema-expected", acceptCapture) : base;
  const precheckSnapshot = load("snapshot-prod-pre", acceptSnapshot);
  if (!base || !expected || !precheckSnapshot) throw new HumanActionRequired("The captures of the precheck are missing.", { stage: "precheck" });
  const target = { environment, signals }; const config = loadConfig(root);
  let wrote = false; const record = (to, detail, where = "production") => progress.advance(to, { commit: head, environment: where, detail });

  try {
    // Staging, read: still what the rehearsal said.
    const reader = readOnly(supabase, { operation: "prod-release (before the apply)" });
    const stagingNow = (await withTarget(reader, "staging", async () => captureSchema({ supabase: reader, target: "staging", release, label: "staging-release", gitCommit: head, environment }), target)).result;
    const stagingDrift = compareSchemas(expected, stagingNow);
    if (!stagingDrift.ok) { report.set("PROD SCHEMA", "DRIFT", ["staging is no longer what the release was rehearsed to be", ...stagingDrift.differences.slice(0, 10).map((item) => driftLine(item, ["expected", "staging"]))]); throw new CheckFailed("Staging changed since the precheck. Nothing was written.", { stage: "staging" }); }

    // Production: read everything again, then write only if nothing moved.
    const outcome = (await withTarget(supabase, "production", async (on) => {
      report.set("PROD TARGET", "PASS", [`${environments.production.label} (${environments.production.ref}), linked and confirmed with the account's list of projects`]);
      const guarded = readOnly(supabase, { operation: "prod-release (before the apply)" });
      const before = compareHistory(migrationHistory(guarded), localFiles(root));
      const historyLines = [`pending before: ${before.pending.join(", ") || "none"}`, `release: ${files.join(", ") || "no migrations"}`];
      if (before.remoteOnly.length || !same(before.pending, files)) { report.set("PROD MIGRATIONS", "FAIL", [...historyLines, before.remoteOnly.length ? `applied on production, not here: ${before.remoteOnly.join(", ")}` : "what is pending on production is not exactly the release"]); throw new CheckFailed("Production's migrations changed since the precheck. Nothing was written.", { stage: "prod migrations" }); }
      const schemaBefore = captureSchema({ supabase: guarded, target: "production", release, label: "production-release", gitCommit: head, environment });
      const moved = compareSchemas(base, schemaBefore);
      if (!moved.ok) { report.set("PROD SCHEMA", "DRIFT", ["production changed since the precheck", ...moved.differences.slice(0, 10).map((item) => driftLine(item, ["base", "production"]))]); throw new CheckFailed("Production's schema changed since the precheck. Nothing was written.", { stage: "prod schema" }); }
      const dry = guarded.push({ dryRun: true });
      if (!dry.ok || !same(dry.migrations, files) || dry.seeds || dry.roles) { report.set("PROD APPLY", "FAIL", [`the dry run lists ${dry.ok ? dry.migrations.join(", ") || "nothing" : "nothing readable"}, expected ${files.join(", ") || "nothing"}`]); throw new CheckFailed("The dry run is not exactly the release. Nothing was written.", { stage: "prod dry run" }); }
      const dataBefore = captureSnapshot({ supabase: guarded, config, target: "production", release, label: "prod-release-pre", commit: head, environment });
      const changed = compareSnapshots(precheckSnapshot, dataBefore);
      if (!changed.ok) { report.set("PROD SNAPSHOT", "DIFFERENT", ["production's data changed since the precheck", ...changed.different.slice(0, 10).map(snapshotLine)]); throw new CheckFailed("Production's data changed since the precheck. Nothing was written.", { stage: "prod snapshot" }); }

      // The apply: the only write to the database, under an explicit grant.
      if (files.length) {
        await withProdWriteAuthorization({ approved: true, precheckValid: true, onProduction: supabase.linkedRef() === environments.production.ref, operations: ["applying migrations"] }, async (grant) => {
          resolvePending(root, files, { release });
          on.assertOnTarget(); assertWritable(supabase, "production", { environment, operation: "applying migrations", grant });
          wrote = true;
          const pushed = supabase.push({ dryRun: false, writeConfirmed: true });
          if (!pushed.ok) { report.set("PROD APPLY", "FAIL", [pushed.reason]); throw new FailureAfterProdWrite("Applying the migrations to production failed. Production may be partly migrated.", { stage: "prod apply" }); }
        });
        record("PROD_APPLIED", `applied ${files.join(", ")}`);
        report.set("PROD APPLY", "PASS", [`applied: ${files.join(", ")}`]);
      } else report.set("PROD APPLY", "NOT NEEDED", ["the release has no migrations"]);

      // After: history, schema, smokes, data, residue.
      const after = compareHistory(migrationHistory(guarded), localFiles(root));
      if (after.pending.length || after.remoteOnly.length) { report.set("PROD MIGRATIONS", "FAIL", [...historyLines, `pending after: ${after.pending.join(", ") || "none"}`, `unknown: ${after.remoteOnly.join(", ") || "none"}`]); throw new CheckFailed("Production's migration history is not what it should be after the release.", { stage: "prod migrations" }); }
      report.set("PROD MIGRATIONS", "PASS", [...historyLines, "after: nothing pending, nothing unknown"]);
      const schemaAfter = captureSchema({ supabase: guarded, target: "production", release, label: "production-released", gitCommit: head, environment });
      const drift = [...compareSchemas(expected, schemaAfter).differences, ...compareSchemas(stagingNow, schemaAfter).differences];
      if (drift.length) { report.set("PROD SCHEMA", "DRIFT", drift.slice(0, 15).map((item) => driftLine(item, ["expected", "production"]))); throw new CheckFailed("Production is not exactly what the release was rehearsed to be.", { stage: "prod schema" }); }
      report.set("PROD SCHEMA", "MATCH", [`production = staging = expected: ${Object.values(schemaAfter.counts).reduce((sum, value) => sum + value, 0)} object(s)`]);
      const smokes = runSmokes({ root, supabase, manifest: found.smokeManifest, smokes: found.smokes, environment, target: "production", transactionalTestsOnProduction: true });
      report.set("PROD SMOKES", smokes.ok ? "PASS" : "FAIL", [`${smokes.counts.passed}/${smokes.counts.total} PASS, self-test ${smokes.selfTests.filter((item) => item.ok).length}/${smokes.selfTests.length}${smokes.rollbackVerified ? ", rollbacks verified" : ""}`, ...smokes.results.filter((item) => item.status !== "PASS").slice(0, 10).map((item) => `${item.status} ${item.id}: ${item.reason ?? ""}`)]);
      if (!smokes.ok) throw new CheckFailed("The smokes failed on production.", { stage: "prod smokes" });
      const dataAfter = captureSnapshot({ supabase: guarded, config, target: "production", release, label: "prod-release-post", commit: head, environment });
      const data = compareSnapshots(precheckSnapshot, dataAfter); const left = residue(guarded);
      if (!data.ok) { report.set("PROD SNAPSHOT", "DIFFERENT", [...data.different.slice(0, 10).map(snapshotLine), "data changes are never accepted automatically: a person has to review them"]); throw new CheckFailed("Production's data is not what it was before the release.", { stage: "prod snapshot" }); }
      if (left.total) { report.set("PROD SNAPSHOT", "DIFFERENT", Object.entries(left.counts).filter(([, value]) => value).map(([name, value]) => `residue ${name}: ${value}`)); throw new CheckFailed("The smokes left something behind on production.", { stage: "residue" }); }
      report.set("PROD SNAPSHOT", "IDENTICAL", [`identical to the precheck's: ${data.rows.length} table(s)`, "0 synthetic users, 0 synthetic workspaces, 0 smoke slugs"]);
      return { smokes: smokes.counts };
    }, target)).result;
    record("PROD_VERIFIED", `smokes ${outcome.smokes.passed}/${outcome.smokes.total}, schema and data verified`);

    // main: fast-forward to the release commit, only if the remote is still where the manifest says.
    const fetched = git.fetchMain(); const remote = git.remoteMain();
    if (!fetched.ok || remote !== manifest.expectedMainBase) { report.set("MAIN", "FAIL", [remote ? `origin/main is ${short(remote)}, expected ${short(manifest.expectedMainBase)}` : `origin/main could not be read${fetched.ok ? "" : ` (${fetched.reason})`}`, "main was not pushed"]); throw new CheckFailed("origin/main is not where the release expects it. main was not moved.", { stage: "main" }); }
    if (!git.isAncestor(manifest.expectedMainBase, head)) throw new CheckFailed("The release commit does not descend from main. main was not moved.", { stage: "main" });
    wrote = true;
    const pushed = git.pushMain(head);
    if (!pushed.ok) { report.set("MAIN", "FAIL", [pushed.reason, "main was not moved on origin"]); throw new CheckFailed("Pushing main failed.", { stage: "main" }); }
    git.updateLocalMain(head, manifest.expectedMainBase); git.fetchMain();
    report.set("MAIN", "PASS", [`${short(manifest.expectedMainBase)} -> ${short(head)}`, "fast-forward, no merge commit, no force"]);
    record("MAIN_ADVANCED", `main ${short(manifest.expectedMainBase)} -> ${short(head)}`, "github");

    // The deployment of that commit: found, waited for, verified with the alias.
    let found2 = null; const attempts = Math.max(1, Math.ceil(timings.deployTimeoutMs / timings.deployIntervalMs));
    for (let attempt = 1; attempt <= attempts; attempt++) { found2 = await discoverDeployment({ commit: head, environment: "production", fetchImpl }); if (found2.ok || attempt === attempts) break; await sleep(timings.deployIntervalMs); }
    if (!found2.ok) { report.set("DEPLOYMENT", "FAIL", [found2.reason, `main is already at ${short(head)}: verify it with bellis:deploy-check --expected-env production`]); throw new HumanActionRequired("The production deployment could not be found in time. main has already been moved.", { stage: "deployment" }); }
    report.set("DEPLOYMENT", "READY", [found2.url]);
    const want = { commit: head, environment: "production", supabaseRef: environments.production.ref };
    let seen = null;
    // The alias may lag behind for a few tries; nothing else is waited for. An exact URL behind Vercel's login is not
    // a reason to stop reading the alias.
    for (let attempt = 1; attempt <= timings.aliasAttempts; attempt++) {
      seen = await verifyDeployment({ url: found2.url, alias, expected: want, fetchImpl });
      const exactFine = seen.exact?.ok || seen.protected; const wrongProject = seen.alias?.observed && seen.alias.observed.supabaseRef !== want.supabaseRef;
      if (seen.status === "PASS" || seen.status === "PARTIAL" || !exactFine || wrongProject) break;
      if (attempt < timings.aliasAttempts) await sleep(timings.aliasIntervalMs);
    }
    const observed = seen.exact?.observed; const aliasSeen = seen.alias?.observed;
    report.set("PROD VERSION", seen.protected ? "HUMAN VERIFICATION REQUIRED" : seen.exact?.ok ? "PASS" : "FAIL", seen.protected
      ? [`exact deployment ${found2.url} is behind Vercel's login: not read by this tool`, `served through the alias: commit ${aliasSeen?.commit ?? "not observed"}, environment ${aliasSeen?.environment ?? "not observed"}, project ${aliasSeen?.supabaseRef ?? "not observed"}`]
      : [`commit ${observed?.commit ?? "not observed"}`, `environment ${observed?.environment ?? "not observed"}`, `project ${observed?.supabaseRef ?? "not observed"}`, ...(seen.exact?.problems ?? [])]);
    report.set("PROD ALIAS", seen.alias?.ok ? "PASS" : "FAIL", [cleanOrigin(alias) ?? "not an address", `commit ${aliasSeen?.commit ?? "not observed"}`, ...(seen.alias?.problems ?? [])]);
    const deployRecords = state.load(release, deployStateName)?.data ?? {};
    if (seen.status === "PARTIAL") {
      // Recoverable: production and main are done and the alias serves the release; only a person can look at the
      // exact URL. Nothing is written again: the confirmation goes through bellis:deploy-check.
      state.save(release, deployStateName, { ...deployRecords, production: { state: "DEPLOY_PROD_PARTIAL_VERIFIED", mode: "automatic", scope: "alias", actor: "bellis:prod-release", url: found2.url, alias: cleanOrigin(alias), expectedCommit: head, observedCommit: aliasSeen.commit, environment: aliasSeen.environment, supabaseRef: aliasSeen.supabaseRef, deploymentId: aliasSeen.deploymentId, at: now().toISOString() } });
      report.set("TECH QA", "N/A", ["runs after a person confirms the exact deployment"]);
      const pending = new HumanActionRequired("The production alias serves the release, but the exact deployment is behind Vercel's login. A person has to confirm it.", { stage: "deploy verify",
        details: [`open ${found2.url}/api/version in a browser and check commit ${head}, environment production, project ${want.supabaseRef}`, `then: npm run bellis:deploy-check -- --release ${release} --expected-env production --url ${found2.url} --confirm-human ${release}`] });
      pending.recoverable = true; throw pending;
    }
    if (seen.status !== "PASS") throw new CheckFailed("Production does not serve the release.", { stage: "deploy verify", details: seen.problems.slice(0, 10) });
    state.save(release, deployStateName, { ...deployRecords, production: { state: "DEPLOY_PROD_VERIFIED", mode: "automatic", actor: "bellis:prod-release", url: found2.url, alias: cleanOrigin(alias), expectedCommit: head, observedCommit: observed.commit, environment: observed.environment, supabaseRef: observed.supabaseRef, deploymentId: observed.deploymentId, at: now().toISOString() } });
    record("DEPLOY_PROD_VERIFIED", found2.url, "vercel");

    // QA without a login: every page answers, and nothing secret is in any of them.
    const qa = await techQa(cleanOrigin(alias), { fetchImpl });
    if (!qa.ok) { report.set("TECH QA", "FAIL", qa.results.filter((item) => !item.ok).map((item) => `${item.path}: ${item.status}`)); throw new CheckFailed("A page of production does not answer as it should.", { stage: "tech qa" }); }
    report.set("TECH QA", manifest.previewRequired ? "HUMAN QA REQUIRED" : "PASS", [`${qa.results.length} page(s) answered without a login, nothing secret in them`, ...(manifest.previewRequired ? ["the release changes screens behind a login: a person has to look at them in production"] : [])]);
    record("RELEASE_COMPLETE", `released ${short(head)} to production`);
  } catch (error) {
    progress.note(error?.stage ?? "prod-release", { commit: head, environment: "production", result: "FAIL", detail: redact(error?.message ?? String(error), 200) });
    // A recoverable stop (waiting for a person, with nothing left to write) keeps its own exit code.
    if (wrote && exitCodeFor(error) !== EXIT.FAILURE_AFTER_PROD_WRITE && error?.recoverable !== true) throw new FailureAfterProdWrite(`${error?.message ?? error} Production had already been written to.`, { stage: error?.stage ?? "prod-release", details: error?.details ?? [], cause: error });
    throw error;
  }
}
