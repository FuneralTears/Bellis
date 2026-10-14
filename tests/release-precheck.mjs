/**
 * The backup validator, `bellis:backup-check` and `bellis:prod-precheck`, against a scratch repository, scratch
 * backup files, a fake pg_restore (the table of contents is made from the release's schema captures) and the fake
 * Supabase CLI. Nothing here reaches Supabase or reads a real backup.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { archiveEntries, expectedEntries, parseBackupName, parseToc, validateBackup } from "../scripts/release/backup/validate.mjs";
import { isReadOnlySql, readOnly, WriteRefused } from "../scripts/release/lib/guard.mjs";
import { EXIT } from "../scripts/release/lib/report.mjs";
import { historySql } from "../scripts/release/stages/database.mjs";
import { releaseCli, releaseMigration, releaseProject, schemaAnswer } from "./fixtures/release-project.mjs";
import { forbidden, refs, scratch } from "./fixtures/release-harness.mjs";
import { backups, base, capture, toc } from "./fixtures/release-backups.mjs";
const withRelease = () => capture(schemaAnswer({ migrated: true, extraTable: true }));

const quiet = { on() {}, off() {} };
const check = (t, schema, options = {}, extra = {}) => { const made = backups(t, options); return validateBackup({ schema, release: "h2-9", file: made.files[schema], base: base(), expected: extra.expected ?? null, listToc: made.listToc, ...extra }); };
const assertClean = (text) => { for (const secret of forbidden) assert.ok(!text.includes(secret), `leaked: ${secret}`); };

test("names: release, schema and time, or nothing", () => {
  const parsed = parseBackupName("bellis-prod-private-20261014-0930-pre-h2-8c.dump");
  assert.equal(parsed.schema, "private"); assert.equal(parsed.release, "h2-8c"); assert.equal(parsed.time.getHours(), 9); assert.equal(parsed.time.getMinutes(), 30);
  for (const name of ["bellis-prod-public-h2-8b-pre-release.dump", "bellis-prod-auth-20261014-0930-pre-h2-8c.dump", "bellis-prod-public-20261314-0930-pre-h2-8c.dump", "bellis-prod-public-20261014-0930-pre-../x.dump", "bellis-staging-public-20261014-0930-pre-h2-8c.dump"]) assert.equal(parseBackupName(name), null, name);
});

test("table of contents: parsed the way pg_restore prints it, and compared with what the capture says", () => {
  const text = toc("public", ["TABLE patients", "TABLE DATA patients", "FUNCTION admin_overview", "FK CONSTRAINT patients patients_workspace_fkey", "POLICY patients patients_read"]);
  const parsed = parseToc(text);
  assert.equal(parsed.format, "CUSTOM"); assert.ok(parsed.createdAt instanceof Date); assert.equal(parsed.dumpedBy, "18.6");
  assert.deepEqual(parsed.entries[0], { type: "SCHEMA", schema: "-", name: "public" });
  assert.deepEqual(parsed.entries.find((entry) => entry.type === "FUNCTION"), { type: "FUNCTION", schema: "public", name: "admin_overview()" });
  assert.deepEqual([...archiveEntries(parsed, "public")].sort(), ["FK CONSTRAINT patients patients_workspace_fkey", "FUNCTION admin_overview", "POLICY patients patients_read", "TABLE DATA patients", "TABLE patients"]);
  const keys = [...expectedEntries(base(), "public")].sort();
  assert.deepEqual(keys, ["CONSTRAINT patients patients_pkey", "FUNCTION admin_overview", "POLICY patients patients_read", "ROW SECURITY patients", "TABLE DATA patients", "TABLE patients"], "an index that backs a constraint is the constraint");
  assert.deepEqual([...expectedEntries(base(), "private")].sort(), ["CONSTRAINT bellis_admins bellis_admins_pkey", "FUNCTION is_bellis_admin", "ROW SECURITY bellis_admins", "TABLE DATA bellis_admins", "TABLE bellis_admins"]);
});

test("public and private: valid backups pass", (t) => {
  for (const schema of ["public", "private"]) { const result = check(t, schema); assert.equal(result.status, "PASS", JSON.stringify(result.problems)); assert.match(result.notes.join(), /none missing, nothing extra/); assert.match(result.metadata.sha256, /^[0-9a-f]{64}$/); }
});

test("missing, empty, stale, from the future, or not a custom archive", (t) => {
  assert.equal(validateBackup({ schema: "private", release: "h2-9", file: null, base: base(), listToc: () => ({ code: 0, stdout: "" }) }).status, "REQUIRED");
  assert.equal(validateBackup({ schema: "private", release: "h2-9", file: join(scratch(t), "nope.dump"), base: base(), listToc: () => ({ code: 0, stdout: "" }) }).status, "REQUIRED");
  let result = check(t, "public", { size: 0 }); assert.equal(result.status, "FAIL"); assert.match(result.problems[0], /empty/);
  const old = new Date(Date.now() - 30 * 3_600_000);
  result = check(t, "public", { created: old }); assert.equal(result.status, "FAIL"); assert.match(result.problems.join(), /hours old; at most 24/);
  result = check(t, "public", {}, { maxAgeHours: 48 }); assert.equal(result.status, "PASS", "the age limit can be set");
  result = check(t, "public", { change: { public: { created: new Date(Date.now() + 3 * 3_600_000) } } }); assert.match(result.problems.join(), /made in the future/);
  result = check(t, "public", { change: { public: { options: { format: "TAR" } } } }); assert.match(result.problems.join(), /not custom/);
  result = check(t, "public", { change: { public: { created: new Date(Date.now() - 5 * 3_600_000) } } }); assert.match(result.problems.join(), /time in its name does not match/);
});

test("a damaged archive, a wrong name and a file in the repository fail", (t) => {
  const made = backups(t); const name = made.files.public.split(/[\\/]/).pop();
  assert.match(validateBackup({ schema: "public", release: "h2-9", file: made.files.public, base: base(), listToc: () => ({ code: 1, stdout: "" }) }).problems[0], /damaged/);
  assert.equal(validateBackup({ schema: "public", release: "h2-9", file: made.files.public, base: base(), listToc: () => ({ code: 1, stdout: "", missing: true }) }).problems[0], "pg_restore was not found (set BELLIS_PG_RESTORE)");
  let result = check(t, "public", { release: "h2-7" }); assert.equal(result.status, "FAIL"); assert.match(result.problems.join(), /the name is for release h2-7, not h2-9/);
  result = validateBackup({ schema: "private", release: "h2-9", file: made.files.public, base: base(), listToc: made.listToc }); assert.match(result.problems.join(), /the name says public, this is the private backup/);
  const legacy = backups(t, { change: { public: { name: "bellis-prod-public-h2-8b-pre-release.dump" } } });
  assert.match(validateBackup({ schema: "public", release: "h2-9", file: legacy.files.public, base: base(), listToc: legacy.listToc }).problems.join(), /the name is not bellis-prod-public-YYYYMMDD-HHMM-pre-h2-9\.dump/);
  const repo = scratch(t); writeFileSync(join(repo, name), "x");
  assert.match(validateBackup({ schema: "public", release: "h2-9", file: join(repo, name), base: base(), root: repo, listToc: made.listToc }).problems[0], /inside the repository/);
});

test("other schemas, a missing object and an object only the release creates fail", (t) => {
  let result = check(t, "public", { change: { public: { options: { extraLines: ["900; 1259 9 TABLE auth users supabase_auth_admin", "901; 2615 9 SCHEMA - storage postgres"] } } } });
  assert.equal(result.status, "FAIL"); assert.match(result.problems.join(), /it holds other schemas: auth, storage/);
  result = check(t, "public", { change: { public: { drop: ["TABLE DATA patients"] } } }); assert.match(result.problems.join(), /1 object\(s\) production has are missing: TABLE DATA patients/);
  result = check(t, "private", { change: { private: { drop: ["FUNCTION is_bellis_admin"] } } }); assert.match(result.problems.join(), /missing: FUNCTION is_bellis_admin/);
  result = check(t, "public", { change: { public: { add: ["TABLE scratch", "TABLE DATA scratch"] } } }, { expected: withRelease() });
  assert.equal(result.status, "FAIL"); assert.match(result.problems.join(), /that only the release's migrations create are already in it: .*TABLE scratch.* — it was made after the release/);
  result = check(t, "public", { change: { public: { add: ["TABLE mystery"] } } }); assert.match(result.problems.join(), /1 object\(s\) production does not have: TABLE mystery/);
  result = check(t, "public", {}, { base: null }); assert.equal(result.status, "HUMAN"); assert.match(result.problems.join(), /no capture of production's schema/);
});

test("size: compared with the previous backup of the same schema, a question for a person when far off", (t) => {
  const dir = scratch(t, "bellis-backups-"); const previous = join(dir, "bellis-prod-public-h2-8b-pre-release.dump"); writeFileSync(previous, Buffer.alloc(10_000, 1));
  utimesSync(previous, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  let result = check(t, "public", { dir, size: 9_000 }); assert.equal(result.status, "PASS"); assert.match(result.notes.join(), /90% of bellis-prod-public-h2-8b-pre-release\.dump/);
  result = check(t, "public", { dir: scratch(t, "b-"), size: 5 }); assert.equal(result.status, "PASS", "nothing to compare with: the contents decide"); assert.match(result.notes.join(), /no previous public backup/);
  const small = scratch(t, "b-"); writeFileSync(join(small, "bellis-prod-public-old.dump"), Buffer.alloc(10_000)); utimesSync(join(small, "bellis-prod-public-old.dump"), new Date(0), new Date(0));
  result = check(t, "public", { dir: small, size: 7_000 }); assert.equal(result.status, "HUMAN"); assert.match(result.problems[0], /70% of the previous public backup/);
  const large = scratch(t, "b-"); writeFileSync(join(large, "bellis-prod-public-old.dump"), Buffer.alloc(1_000)); utimesSync(join(large, "bellis-prod-public-old.dump"), new Date(0), new Date(0));
  result = check(t, "public", { dir: large, size: 3_000 }); assert.equal(result.status, "HUMAN");
  const other = scratch(t, "b-"); writeFileSync(join(other, "bellis-prod-private-old.dump"), Buffer.alloc(100_000)); utimesSync(join(other, "bellis-prod-private-old.dump"), new Date(0), new Date(0));
  assert.equal(check(t, "public", { dir: other, size: 5 }).status, "PASS", "a backup of another schema is not comparable");
});

test("the read-only guard: only a read-only transaction and dry runs get through", (t) => {
  assert.equal(isReadOnlySql(historySql), true);
  for (const sql of ["begin;\ninsert into public.patients values (1);\nrollback;\n", "select 1;", "begin transaction read only;\nselect 1;\ncommit;\n", "begin read only;\nselect 1;\n", "insert into x values (1);"]) assert.equal(isReadOnlySql(sql), false, sql);
  const calls = []; const fake = { source: "x", linkedRef: () => refs.production, link: () => ({ ok: true }), projects: () => ({ ok: true, projects: [] }), version: () => ({ ok: true }), query: () => { calls.push("query"); return { ok: true, rows: [] }; }, push: (options) => { calls.push(`push ${options.dryRun}`); return { ok: true, migrations: [] }; } };
  const guarded = readOnly(fake, { operation: "prod-precheck" }); const dir = scratch(t);
  writeFileSync(join(dir, "write.sql"), "begin;\nupdate public.workspaces set plan_code = 'pro';\nrollback;\n"); writeFileSync(join(dir, "read.sql"), historySql);
  assert.throws(() => guarded.query(join(dir, "write.sql")), (error) => error instanceof WriteRefused && /only a read-only transaction/.test(error.message));
  assert.throws(() => guarded.push({ dryRun: false, writeConfirmed: true }), (error) => error instanceof WriteRefused && /only run as a dry run/.test(error.message));
  assert.throws(() => guarded.push({}), WriteRefused); assert.throws(() => guarded.query(join(dir, "missing.sql")), WriteRefused);
  assert.deepEqual(calls, [], "nothing reached the CLI");
  guarded.query(join(dir, "read.sql")); guarded.push({ dryRun: true }); assert.deepEqual(calls, ["query", "push true"]);
});

/** A release taken through staging with the fake CLI, with production still on the base. */
async function stagedRelease(t, { migrations } = {}) {
  const made = releaseProject(t, migrations ? { migrations } : {});
  const files = migrations ?? [releaseMigration];
  const cli = releaseCli(t, files.length ? {} : { pending: [], schemaAfterPush: undefined });
  const run = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(run.code, EXIT.PASS, run.output);
  cli.set({ appliedByRef: { [refs.production]: ["20261017090000"] }, pushableByRef: { [refs.production]: files, [refs.staging]: [] } });
  return { made, cli };
}
const releaseFolder = (made) => join(made.home, "Bellis-Releases", "h2-9");
const savedCapture = (made, name) => JSON.parse(readFileSync(join(releaseFolder(made), `${name}.json`), "utf8")).data;
/** The two backups of the staged release, made from its own captures, in the backups folder of its home. */
function releaseBackups(made, options = {}) {
  const dir = join(made.home, "Bellis-Backups"); mkdirSync(dir, { recursive: true });
  return backups({ after() {} }, { dir, captureOf: () => savedCapture(made, "schema-base"), ...options });
}
async function invoke(t, argv, { made, cli, listToc = () => ({ code: 1, stdout: "" }), now } = {}) {
  let output = ""; const before = cli.calls().length;
  const code = await main(argv, { root: made.root, environment: cli.environment, home: made.home, write: (text) => { output += text; }, supabase: cli.supabase, git: made.git, signals: quiet, listToc, now, runLocal: () => ({ ok: true, summary: "fine" }) });
  return { code, output, calls: cli.calls().slice(before) };
}
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
const statusOf = (output, name) => sectionOf(output, name).split("\n")[1];
const stateOf = (made) => JSON.parse(readFileSync(join(releaseFolder(made), "release-state.json"), "utf8")).data.state;
function assertSafeEnd(made, cli, out) {
  const finalTarget = out.output.startsWith("{") ? JSON.parse(out.output).sections["CLI FINAL TARGET"].status : statusOf(out.output, "CLI FINAL TARGET");
  assert.equal(cli.linkedFile(), refs.staging, "the CLI ends on staging"); assert.equal(finalTarget, "STAGING");
  assert.equal(cli.state().pushes, 1, "the only write ever made is staging's apply"); assert.notEqual(cli.state().pushedOn, refs.production);
  assertClean(out.output); for (const file of readdirSync(releaseFolder(made))) assertClean(readFileSync(join(releaseFolder(made), file), "utf8"));
}

test("backup-check: both backups pass, the result is kept, and Supabase is not touched", async (t) => {
  const { made, cli } = await stagedRelease(t); const files = releaseBackups(made);
  const out = await invoke(t, ["backup-check", "--release", "h2-9"], { made, cli, listToc: files.listToc });
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(statusOf(out.output, "BACKUP PUBLIC"), "PASS"); assert.equal(statusOf(out.output, "BACKUP PRIVATE"), "PASS");
  assert.deepEqual(out.calls, []); const saved = JSON.parse(readFileSync(join(releaseFolder(made), "backup-check.json"), "utf8")).data;
  assert.equal(saved.backups.public.status, "PASS"); assert.match(saved.backups.private.metadata.sha256, /^[0-9a-f]{64}$/);
  const explicit = await invoke(t, ["backup-check", "--release", "h2-9", "--private", join(made.home, "nope.dump")], { made, cli, listToc: files.listToc });
  assert.equal(explicit.code, EXIT.HUMAN_ACTION_REQUIRED); assert.equal(statusOf(explicit.output, "BACKUP PRIVATE"), "REQUIRED"); assert.equal(statusOf(explicit.output, "BACKUP PUBLIC"), "PASS");
});

test("prod-precheck: everything read-only passes, and the release is ready for two hours", async (t) => {
  const { made, cli } = await stagedRelease(t); const files = releaseBackups(made);
  const out = await invoke(t, ["prod-precheck", "--release", "h2-9"], { made, cli, listToc: files.listToc });
  assert.equal(out.code, EXIT.PASS, out.output);
  const expected = { "STAGING STATE": "STAGING_COMPLETE", "BACKUP PUBLIC": "PASS", "BACKUP PRIVATE": "PASS", "PROD TARGET": "PASS", "PROD MIGRATIONS": "PASS", "PROD DRIFT": "MATCH", "PROD SNAPSHOT": "PASS", "PROD DRY RUN": "PASS", "DATA INTEGRITY": "PASS", "PRECHECK EXPIRY": "INFO", "CLI FINAL TARGET": "STAGING", STATE: "PROD_PRECHECK_COMPLETE", "SAFE TO APPLY PROD?": "YES" };
  for (const [section, status] of Object.entries(expected)) assert.equal(statusOf(out.output, section), status, section);
  assert.match(sectionOf(out.output, "PROD MIGRATIONS"), /pending: 20261020090000_add_flag\.sql/); assert.match(sectionOf(out.output, "PROD DRY RUN"), /lists exactly: 20261020090000_add_flag\.sql/);
  assert.ok(out.calls.includes("link production") && !out.calls.includes("db push --yes"), "production was linked and read, never written");
  const saved = JSON.parse(readFileSync(join(releaseFolder(made), "prod-precheck.json"), "utf8")).data;
  assert.equal(Date.parse(saved.precheckExpiresAt) - Date.parse(saved.precheckCompletedAt), 2 * 3_600_000);
  assert.equal(saved.prodRef, refs.production); assert.deepEqual(saved.dryRun, [releaseMigration]); assert.match(saved.migrationSet, /^[0-9a-f]{64}$/); assert.match(saved.snapshotHash, /^[0-9a-f]{64}$/);
  assert.ok(saved.backups.public.file.startsWith("bellis-prod-public-")); assert.ok(existsSync(join(releaseFolder(made), "snapshot-prod-pre.json")));
  assert.equal(stateOf(made), "PROD_PRECHECK_COMPLETE"); assertSafeEnd(made, cli, out);
});

test("prod-precheck: a release without migrations needs nothing pending and an exact match", async (t) => {
  const { made, cli } = await stagedRelease(t, { migrations: [] }); const files = releaseBackups(made);
  const out = await invoke(t, ["prod-precheck", "--release", "h2-9"], { made, cli, listToc: files.listToc });
  assert.equal(out.code, EXIT.PASS, out.output); assert.match(sectionOf(out.output, "PROD DRY RUN"), /nothing pending/); assert.match(sectionOf(out.output, "PROD DRIFT"), /EXACT MATCH/);
});

test("prod-precheck stops before Supabase without staging done or without backups", async (t) => {
  const made = releaseProject(t); const cli = releaseCli(t);
  let out = await invoke(t, ["prod-precheck", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED); assert.equal(statusOf(out.output, "STAGING STATE"), "HUMAN"); assert.deepEqual(out.calls, []); assert.equal(statusOf(out.output, "SAFE TO APPLY PROD?"), "NO");
  const staged = await stagedRelease(t);
  out = await invoke(t, ["prod-precheck", "--release", "h2-9"], staged);
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, out.output); assert.equal(statusOf(out.output, "BACKUP PUBLIC"), "REQUIRED"); assert.equal(statusOf(out.output, "BACKUP PRIVATE"), "REQUIRED");
  assert.deepEqual(out.calls, [], "nothing was linked or read: not even staging"); assert.match(out.output, /## RESULT\nHUMAN ACTION REQUIRED\n/);
  const onlyPublic = releaseBackups(staged.made); const privateFile = onlyPublic.files.private;
  out = await invoke(t, ["prod-precheck", "--release", "h2-9", "--private", join(staged.made.home, "missing.dump")], { ...staged, listToc: onlyPublic.listToc });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED); assert.equal(statusOf(out.output, "BACKUP PUBLIC"), "PASS"); assert.equal(statusOf(out.output, "BACKUP PRIVATE"), "REQUIRED"); assert.deepEqual(out.calls, []);
  void privateFile; assert.equal(existsSync(join(releaseFolder(staged.made), "prod-precheck.json")), false); assert.equal(stateOf(staged.made), "STAGING_COMPLETE");
});

test("prod-precheck fails closed on production: target, history, drift, snapshot, dry run, data changing", async (t) => {
  const cases = [
    ["an ambiguous list of projects", { marks: "both" }, EXIT.TARGET_NOT_CONFIRMED, null],
    ["a migration on production that is not here", { appliedByRef: { [refs.production]: ["20261017090000", "20260101000000"] } }, EXIT.CHECK_FAILED, "PROD MIGRATIONS"],
    ["more pending on production than the release", { appliedByRef: { [refs.production]: [] } }, EXIT.CHECK_FAILED, "PROD MIGRATIONS"],
    ["the release already applied on production", { appliedByRef: { [refs.production]: ["20261017090000", "20261020090000"] } }, EXIT.CHECK_FAILED, "PROD MIGRATIONS"],
    ["production drifted from the base", { schemaByRef: { [refs.production]: schemaAnswer({ extraTable: true }) } }, EXIT.CHECK_FAILED, "PROD DRIFT"],
    ["the snapshot cannot be taken", { snapshot: "garbage" }, EXIT.CHECK_FAILED, "PROD SNAPSHOT"],
    ["a dry run with an extra migration", { dryRunExtra: ["20261021090000_second.sql"] }, EXIT.CHECK_FAILED, "PROD DRY RUN"],
    ["data changing during the precheck", { dbAfterDryRun: { "public.patients": { columns: ["id", "first_name"], primaryKey: ["id"], rows: [{ id: "p1", first_name: "Ana" }] }, "auth.users": { columns: ["id"], primaryKey: ["id"], rows: [{ id: "u1" }] } } }, EXIT.CHECK_FAILED, "DATA INTEGRITY"],
  ];
  for (const [name, behaviour, code, section] of cases) {
    const { made, cli } = await stagedRelease(t); const files = releaseBackups(made); cli.set(behaviour);
    const out = await invoke(t, ["prod-precheck", "--release", "h2-9"], { made, cli, listToc: files.listToc });
    assert.equal(out.code, code, `${name}\n${out.output}`);
    if (section) assert.ok(["FAIL", "DRIFT"].includes(statusOf(out.output, section)), `${name}: ${section} is ${statusOf(out.output, section)}`);
    assert.equal(statusOf(out.output, "SAFE TO APPLY PROD?"), "NO", name);
    assert.equal(existsSync(join(releaseFolder(made), "prod-precheck.json")), false, `${name}: no precheck state`); assert.equal(stateOf(made), "STAGING_COMPLETE", name);
    if (code !== EXIT.TARGET_NOT_CONFIRMED) assertSafeEnd(made, cli, out); else assertClean(out.output);
  }
});

test("prod-precheck: reuse within two hours, a full run after it expires or when the commit changed", async (t) => {
  const { made, cli } = await stagedRelease(t); const files = releaseBackups(made);
  assert.equal((await invoke(t, ["prod-precheck", "--release", "h2-9"], { made, cli, listToc: files.listToc })).code, EXIT.PASS);
  const inAnHour = () => new Date(Date.now() + 3_600_000);
  let out = await invoke(t, ["prod-precheck", "--release", "h2-9", "--reuse"], { made, cli, listToc: files.listToc, now: inAnHour });
  assert.equal(out.code, EXIT.PASS, out.output); assert.match(sectionOf(out.output, "PRECHECK EXPIRY"), /reused: commit, manifest, migrations and backup files are the same/); assert.deepEqual(out.calls, [], "reused: Supabase is not touched");
  out = await invoke(t, ["prod-precheck", "--release", "h2-9", "--reuse"], { made, cli, listToc: files.listToc, now: () => new Date(Date.now() + 3 * 3_600_000) });
  assert.equal(out.code, EXIT.PASS, out.output); assert.match(out.output, /not reused: it expired at/); assert.ok(out.calls.includes("link production"), "a full precheck ran");
  const path = join(releaseFolder(made), "prod-precheck.json"); const saved = JSON.parse(readFileSync(path, "utf8")); saved.data.head = "0".repeat(40); writeFileSync(path, JSON.stringify(saved));
  out = await invoke(t, ["prod-precheck", "--release", "h2-9", "--reuse"], { made, cli, listToc: files.listToc, now: inAnHour });
  assert.equal(out.code, EXIT.PASS); assert.match(out.output, /not reused: the commit, the manifest or the migrations changed/); assert.ok(out.calls.includes("link production"));
  // A backup replaced since: not reused either.
  writeFileSync(files.files.private, Buffer.alloc(4100, 9));
  out = await invoke(t, ["prod-precheck", "--release", "h2-9", "--reuse"], { made, cli, listToc: files.listToc, now: inAnHour });
  assert.match(out.output, /not reused: the backups of private changed/);
});

test("no secret reaches the report or the release's folder", async (t) => {
  const { made, cli } = await stagedRelease(t); const files = releaseBackups(made, { change: { public: { options: { dbname: "postgres://postgres:hunter2-secret@db.x.supabase.co:5432/postgres" } } } }); cli.set({ schemaMode: "leak-error" });
  const out = await invoke(t, ["prod-precheck", "--release", "h2-9", "--json"], { made, cli, listToc: files.listToc });
  assert.equal(out.code, EXIT.CHECK_FAILED); JSON.parse(out.output); assertSafeEnd(made, cli, out);
});
