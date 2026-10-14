/**
 * Data snapshots of the release tooling: the configuration, the fingerprint, what a snapshot may contain, taking
 * one and comparing two. The database is the fake CLI's (tests/fixtures/fake-supabase.mjs): rows held in a JSON
 * file. Nothing here reaches Supabase.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../scripts/release/cli.mjs";
import { createGit } from "../scripts/release/lib/git.mjs";
import { CheckFailed, EXIT, PreconditionError, TargetNotConfirmed } from "../scripts/release/lib/report.mjs";
import { statements, validateSmokeSql } from "../scripts/release/smoke/sql.mjs";
import { buildSnapshotSql, configHash, configProblems, fingerprintRows, loadConfig, statsSql } from "../scripts/release/snapshot/build-sql.mjs";
import { buildSnapshot, captureSnapshot, snapshotProblems } from "../scripts/release/snapshot/capture.mjs";
import { acceptSnapshot, compareSnapshots, differenceLine, readSnapshotFile } from "../scripts/release/snapshot/compare.mjs";
import { fakeCli, forbidden, gitRepo, refs, scratch } from "./fixtures/release-harness.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const copy = (value) => JSON.parse(JSON.stringify(value));
const config = () => ({ version: 1, schemas: ["public", "private"], tables: [
  { table: "public.patients", mode: "fingerprint", key: ["id"] },
  { table: "public.members", mode: "fingerprint", key: ["workspace_id", "user_id"] },
  { table: "private.accounts", mode: "fingerprint", key: ["workspace_id"], exclude: [{ column: "token_expires_at", reason: "rewritten by each automatic token refresh" }] },
  { table: "auth.users", mode: "count" }],
  ignored: [{ table: "public.request_limits", reason: "rate-limit counters written by any visitor" }] });
/** Rows full of things a snapshot must never carry. */
const pii = ["Ana", "Zulema Quiroga", "ana@example.com", "zulema@example.com", "+54 11 5555-0101", "Paciente con ansiedad", "APP_USR-token-123", "auth-secret-hash"];
const database = () => ({
  "public.patients": { columns: ["id", "first_name", "email", "phone", "note"], primaryKey: ["id"], rows: [
    { id: "p1", first_name: "Ana", email: "ana@example.com", phone: "+54 11 5555-0101", note: "Paciente con ansiedad" }, { id: "p2", first_name: "Zulema Quiroga", email: "zulema@example.com", phone: null, note: null }] },
  "public.members": { columns: ["workspace_id", "user_id", "role"], primaryKey: ["workspace_id", "user_id"], rows: [{ workspace_id: "w1", user_id: "u1", role: "owner" }, { workspace_id: "w1", user_id: "u2", role: "admin" }] },
  "private.accounts": { columns: ["workspace_id", "status", "access", "token_expires_at"], primaryKey: ["workspace_id"], rows: [{ workspace_id: "w1", status: "connected", access: "APP_USR-token-123", token_expires_at: "2026-11-01" }] },
  "auth.users": { columns: ["id", "email", "encrypted_password"], primaryKey: ["id"], rows: [{ id: "u1", email: "ana@example.com", encrypted_password: "auth-secret-hash" }, { id: "u2", email: "zulema@example.com", encrypted_password: "auth-secret-hash" }] },
  "public.request_limits": { columns: ["fingerprint", "attempts"], primaryKey: [], rows: [{ fingerprint: "x", attempts: 3 }] },
});
const cliWith = (t, { db = database(), settings = config(), ...behaviour } = {}) => fakeCli(t, { db, snapshotConfig: settings, ...behaviour });
const take = (t, { cli = cliWith(t), settings = config(), label = "pre", target = "staging" } = {}) => captureSnapshot({ supabase: cli.supabase, config: settings, target, release: "h2-9", label, commit: "a".repeat(40),
  environment: cli.environment, now: () => new Date("2026-10-13T12:00:05.123Z"), temporary: scratch(t, "bellis-tmp-") });
const entryOf = (snapshot, table) => snapshot.tables.find((item) => item.table === table);
const assertClean = (value) => { const text = typeof value === "string" ? value : JSON.stringify(value); for (const secret of [...forbidden, ...pii]) assert.ok(!text.includes(secret), `leaked: ${secret}`); };
const refusedBy = (pattern) => (error) => error instanceof CheckFailed && pattern.test([error.message, ...error.details].join(" | "));

test("the real configuration is valid and covers what a release has to watch", () => {
  const real = loadConfig(repository); const names = real.tables.map((entry) => entry.table);
  for (const table of ["public.workspaces", "public.workspace_members", "public.patients", "public.appointments", "public.payments", "public.patient_notes", "public.patient_activities", "public.patient_follow_ups", "public.automation_rules",
    "public.automation_runs", "public.internal_notifications", "public.plan_upgrade_requests", "public.product_events", "public.audit_events", "private.bellis_admins", "private.mercado_pago_accounts", "auth.users"]) assert.ok(names.includes(table), table);
  assert.deepEqual(real.tables.find((entry) => entry.table === "auth.users"), { table: "auth.users", mode: "count", why: real.tables.find((entry) => entry.table === "auth.users").why });
  assert.deepEqual(real.tables.filter((entry) => entry.table.startsWith("auth.") || entry.table.startsWith("vault.")).map((entry) => entry.mode), ["count"]);
  // Nothing is left out by default: only Mercado Pago's refresh bookkeeping, each column with its reason.
  const excluded = real.tables.flatMap((entry) => (entry.exclude ?? []).map((item) => `${entry.table}.${item.column}`));
  assert.deepEqual(excluded, ["private.mercado_pago_accounts.token_expires_at", "private.mercado_pago_accounts.refresh_locked_until", "private.mercado_pago_accounts.updated_at"]);
  for (const entry of real.tables) if (entry.mode === "fingerprint") assert.ok(entry.key.length >= 1, entry.table);
  for (const entry of real.tables.slice(names.indexOf("auth.users") + 1)) assert.ok(entry.why?.length > 20, `${entry.table} is beyond the minimum and says why`);
  for (const item of real.ignored) assert.ok(item.reason.length > 20);
});

test("configuration: a valid one has no problems", () => { assert.deepEqual(configProblems(config()), []); });

test("configuration: duplicates, missing keys and bad exclusions are errors", () => {
  const broken = (change, pattern) => { const settings = config(); change(settings); assert.match(configProblems(settings).join(" | "), pattern); };
  broken((c) => c.tables.push({ table: "public.patients", mode: "fingerprint", key: ["id"] }), /public\.patients: listed twice/);
  broken((c) => { delete c.tables[0].key; }, /public\.patients: has no key/);
  broken((c) => { c.tables[0].key = []; }, /public\.patients: has no key/);
  broken((c) => { c.tables[1].key = ["workspace_id", "workspace_id"]; }, /a key column is repeated/);
  broken((c) => { c.tables[0].key = ["id; drop table x"]; }, /a key column is not a valid name/);
  broken((c) => { c.tables[2].exclude = [{ column: "Token Expires", reason: "rewritten by each refresh" }]; }, /an excluded column is not a valid name/);
  broken((c) => { c.tables[2].exclude = [{ column: "token_expires_at" }]; }, /token_expires_at is excluded without a reason/);
  broken((c) => { c.tables[2].exclude = [{ column: "token_expires_at", reason: "volatile" }]; }, /excluded without a reason/);
  broken((c) => { c.tables[2].exclude.push({ column: "token_expires_at", reason: "rewritten by each refresh" }); }, /excluded twice/);
  broken((c) => { c.tables[2].exclude = [{ column: "workspace_id", reason: "rewritten by each refresh" }]; }, /part of the key and cannot be excluded/);
  broken((c) => { c.tables[2].exclude = "token_expires_at"; }, /"exclude" is a list/);
  broken((c) => { c.tables[3] = { table: "auth.users", mode: "fingerprint", key: ["id"] }; }, /tables of auth can only be counted/);
  broken((c) => { c.tables[3].key = ["id"]; }, /only counted has no key/);
  broken((c) => { c.tables[0].table = "patients"; }, /named schema\.table/);
  broken((c) => { c.tables[0].table = 'public."x"; drop table y'; }, /named schema\.table/);
  broken((c) => { c.tables[0].mode = "rows"; }, /the mode is fingerprint or count/);
  broken((c) => { c.ignored.push({ table: "public.patients", reason: "because it is too noisy today" }); }, /listed and ignored at the same time/);
  broken((c) => { c.ignored[0].reason = ""; }, /ignored without a reason/);
  broken((c) => { delete c.version; }, /no version/); broken((c) => { c.schemas = []; }, /which schemas/);
  assert.deepEqual(configProblems({}), ["the configuration has no list of tables"]);
  assert.throws(() => buildSnapshotSql({ ...config(), tables: [{ table: "public.patients", mode: "fingerprint" }] }), CheckFailed);
});

test("configuration on disk: an invalid one stops everything", (t) => {
  const root = scratch(t); mkdirSync(join(root, "scripts", "release", "snapshot"), { recursive: true });
  assert.throws(() => loadConfig(root), PreconditionError);
  const settings = config(); settings.tables.push(copy(settings.tables[0])); writeFileSync(join(root, "scripts", "release", "snapshot", "tables.json"), JSON.stringify(settings));
  assert.throws(() => loadConfig(root), refusedBy(/public\.patients: listed twice/));
});

test("fingerprint: the same rows in any order give the same one", () => {
  const rows = [{ id: 1, name: "a", at: "2026-01-01" }, { id: 2, name: "b", at: null }, { id: 3, name: "c", at: "2026-01-03" }];
  const base = fingerprintRows(rows);
  assert.match(base, /^[0-9a-f]{64}$/); assert.equal(fingerprintRows(rows), base, "deterministic");
  assert.equal(fingerprintRows([rows[2], rows[0], rows[1]]), base); assert.equal(fingerprintRows([...rows].reverse()), base);
  assert.equal(fingerprintRows(rows.map((row) => ({ at: row.at, name: row.name, id: row.id }))), base, "nor on the order of the columns");
});

test("fingerprint: one field, one row or one key changed gives another one", () => {
  const rows = [{ id: 1, name: "a", seen: "x" }, { id: 2, name: "b", seen: "y" }]; const base = fingerprintRows(rows);
  assert.notEqual(fingerprintRows([{ id: 1, name: "a", seen: "x" }, { id: 2, name: "B", seen: "y" }]), base);
  assert.notEqual(fingerprintRows([{ id: 1, name: "a", seen: "x" }, { id: 2, name: null, seen: "y" }]), base);
  assert.notEqual(fingerprintRows([{ id: 1, name: "a", seen: "x" }, { id: 9, name: "b", seen: "y" }]), base);
  assert.notEqual(fingerprintRows([rows[0]]), base); assert.notEqual(fingerprintRows([...rows, { id: 3, name: "c", seen: "z" }]), base); assert.notEqual(fingerprintRows([rows[0], rows[0]]), base);
  assert.notEqual(fingerprintRows([{ id: 1, name: "b", seen: "x" }, { id: 2, name: "a", seen: "y" }]), base, "values swapped between rows is a change");
  assert.notEqual(fingerprintRows([]), fingerprintRows([{}]));
});

test("fingerprint: a change only in an excluded column gives the same one", () => {
  const rows = [{ id: 1, name: "a", seen: "x" }, { id: 2, name: "b", seen: "y" }]; const exclude = ["seen"];
  const base = fingerprintRows(rows, { exclude });
  assert.equal(fingerprintRows([{ id: 1, name: "a", seen: "LATER" }, { id: 2, name: "b", seen: null }], { exclude }), base);
  assert.notEqual(fingerprintRows([{ id: 1, name: "A", seen: "x" }, { id: 2, name: "b", seen: "y" }], { exclude }), base, "the rest still counts");
  assert.notEqual(fingerprintRows(rows), base, "and without the exclusion that column counts too");
});

test("the SQL: one read-only transaction that is rolled back, with every table and nothing else", () => {
  const sql = buildSnapshotSql(config());
  assert.equal(buildSnapshotSql(config()), sql, "the same configuration gives the same SQL");
  assert.equal(validateSmokeSql(sql).ok, true); const list = statements(sql);
  assert.equal(list[0].tokens.map((token) => token.value).join(" "), "begin transaction isolation level repeatable read read only");
  assert.deepEqual(list.map((statement) => statement.tokens[0].value), ["begin", "set", "select", "rollback"]);
  assert.match(sql, /set local time zone 'UTC';/);
  for (const table of ['"public"."patients" t', '"public"."members" t', '"private"."accounts" t', 'from "auth"."users"']) assert.ok(sql.includes(table), table);
  assert.ok(sql.includes(`to_jsonb(t) - array['token_expires_at']::text[]`)); assert.ok(sql.includes("to_jsonb(t) - array[]::text[]"));
  assert.ok(sql.includes(`jsonb_build_array(t."workspace_id", t."user_id")::text as key_text`)); assert.ok(sql.includes(`(t."workspace_id" is not null and t."user_id" is not null) as key_ok`));
  assert.ok(sql.includes(`((select jsonb_build_object('table', 'auth.users', 'count', (select count(*) from "auth"."users"))))`), "auth.users is a count and nothing else");
  assert.equal(sql.split('"auth"."users"').length, 2, "auth.users appears once: in its count, never as rows turned into JSON");
  assert.doesNotMatch(sql, /string_agg/, "nothing is concatenated across rows");
  const words = statements(sql).flatMap((statement) => statement.tokens).filter((token) => token.type === "word").map((token) => token.value);
  for (const verb of ["insert", "update", "delete", "truncate", "alter", "drop", "create", "grant", "copy", "call", "do"]) assert.equal(words.includes(verb), false, verb);
  assert.match(statsSql("x t", { key: ["id"], exclude: [] }), /count\(distinct key_text\) as key_distinct/);
  const real = buildSnapshotSql(loadConfig(repository)); assert.equal(validateSmokeSql(real).ok, true); assert.match(statements(real)[0].tokens.map((token) => token.value).join(" "), /read only$/);
});

test("capture: counts, fingerprints and metadata, and nothing that came from a row", (t) => {
  const cli = cliWith(t); const snapshot = take(t, { cli });
  assert.deepEqual(snapshotProblems(snapshot), []);
  assert.deepEqual(snapshot.meta, { tool: "h2.8c", configVersion: 1, configHash: configHash(config()), release: "h2-9", label: "pre", environment: "staging", ref: refs.staging, commit: "a".repeat(40),
    capturedAt: "2026-10-13T12:00:05Z", databaseTime: "2026-10-13T12:00:00Z" });
  assert.deepEqual(snapshot.tables.map((entry) => [entry.table, entry.mode, entry.count]), [["public.patients", "fingerprint", 2], ["public.members", "fingerprint", 2], ["private.accounts", "fingerprint", 1], ["auth.users", "count", 2]]);
  assert.deepEqual(Object.keys(entryOf(snapshot, "auth.users")), ["table", "mode", "count"], "auth.users is a count and nothing more");
  assert.deepEqual(entryOf(snapshot, "private.accounts").excluded, ["token_expires_at"]); assert.deepEqual(entryOf(snapshot, "public.members").key, ["workspace_id", "user_id"]);
  assert.match(entryOf(snapshot, "public.patients").fingerprint, /^[0-9a-f]{64}$/); assert.equal(entryOf(snapshot, "public.patients").columns, 5);
  assert.deepEqual(snapshot.ignored, ["public.request_limits"]); assert.deepEqual(snapshot.warnings, []);
  assertClean(snapshot);
  assert.deepEqual(cli.calls(), ["projects list", "db query"], "confirmed with the account, then one query; never a link");
  assert.match(statements(cli.state().queries[0])[0].tokens.map((token) => token.value).join(" "), /read only$/);
});

test("capture: order does not matter, a changed field does, an excluded column does not", (t) => {
  const before = take(t);
  const shuffled = database(); for (const table of Object.values(shuffled)) table.rows.reverse();
  assert.deepEqual(take(t, { cli: cliWith(t, { db: shuffled }) }).tables, before.tables);
  const refreshed = database(); refreshed["private.accounts"].rows[0].token_expires_at = "2027-01-01";
  assert.deepEqual(take(t, { cli: cliWith(t, { db: refreshed }) }).tables, before.tables);
  const edited = database(); edited["public.patients"].rows[1].phone = "+54 11 5555-0202";
  const after = take(t, { cli: cliWith(t, { db: edited }), label: "post" }); const seen = compareSnapshots(before, after);
  assert.equal(seen.ok, false); assert.deepEqual(seen.different.map((row) => [row.table, row.status]), [["public.patients", "fingerprint"]]); assertClean([after, seen]);
});

test("capture: warnings for a table nobody listed and for a key that is not the primary key", (t) => {
  const db = database(); db["public.new_table"] = { columns: ["id"], primaryKey: ["id"], rows: [] }; db["public.members"].primaryKey = []; db["private.accounts"].primaryKey = ["id"]; db["storage.objects"] = { columns: ["id"], primaryKey: ["id"], rows: [] };
  assert.deepEqual(take(t, { cli: cliWith(t, { db }) }).warnings, [{ code: "no_primary_key", table: "public.members" }, { code: "key_is_not_primary_key", table: "private.accounts" }, { code: "uncovered_table", table: "public.new_table" }]);
});

test("capture fails closed: a missing table, a fingerprint that could not be computed, a key that does not identify a row", (t) => {
  const failing = (change, pattern, behaviour = {}) => { const db = database(); const settings = config(); change(db, settings); const cli = cliWith(t, { db, settings, ...behaviour }); assert.throws(() => take(t, { cli, settings }), refusedBy(pattern)); return cli; };
  failing((db) => { delete db["public.members"]; }, /SQL error 42P01: relation/);
  failing(() => {}, /public\.patients: the fingerprint could not be computed/, { snapshot: "null-fingerprint" });
  failing(() => {}, /failed its own check in the database/, { snapshot: "self-test-broken" });
  failing(() => {}, /could not be read from the database.*could not be read/, { snapshot: "garbage" });
  failing((db) => { db["public.patients"].rows.push(copy(db["public.patients"].rows[0])); }, /public\.patients: the key does not identify a row/);
  failing((db) => { db["public.members"].rows[0].user_id = null; }, /public\.members: the key is empty in some rows/);
  failing((db, settings) => { settings.tables[2].exclude.push({ column: "no_such_column", reason: "rewritten by each automatic refresh" }); }, /private\.accounts: the excluded column no_such_column does not exist/);
  failing((db, settings) => { settings.tables[0].key = ["uuid"]; }, /public\.patients: the key column uuid does not exist/);
  failing((db) => { db["public.patients"].columns = ["id", "First Name"]; }, /public\.patients: its columns could not be read/);
  const leaky = failing(() => {}, /public\.patients: the answer has a field that was not asked for/, { snapshot: "pii" });
  assert.equal(leaky.linkedFile(), refs.staging);
  assert.throws(() => take(t, { settings: { ...config(), tables: [] } }), refusedBy(/lists no tables/));
  assert.throws(() => captureSnapshot({ supabase: cliWith(t).supabase, config: config(), label: "Pre Release" }), refusedBy(/needs a label/));
});

test("capture: an error from the database says what failed without showing what it printed", (t) => {
  const cli = cliWith(t, { snapshot: "leak-error" });
  assert.throws(() => take(t, { cli }), (error) => { assertClean([error.message, error.details]); return error instanceof CheckFailed && /SQL error P0001: failed to connect to \[connection string\]/.test(error.details.join()); });
});

test("capture: the CLI has to be on the environment asked for already, and it is never linked", (t) => {
  for (const behaviour of [{ marks: "both" }, { marks: "none" }, { failProjects: true }, { linked: null }, { linked: refs.production }]) {
    const cli = cliWith(t, behaviour); assert.throws(() => take(t, { cli }), TargetNotConfirmed, JSON.stringify(behaviour));
    assert.equal((cli.state().queries ?? []).length, 0); assert.equal(cli.calls().some((call) => call.startsWith("link")), false);
  }
  const onStaging = cliWith(t); assert.throws(() => take(t, { cli: onStaging, target: "production" }), TargetNotConfirmed); assert.equal(onStaging.linkedFile(), refs.staging);
  const override = cliWith(t); override.environment.SUPABASE_PROJECT_ID = refs.production; assert.throws(() => take(t, { cli: override }), TargetNotConfirmed);
  // On production, when someone left the CLI there on purpose: the same read-only transaction, and it stays there.
  const onProduction = cliWith(t, { linked: refs.production }); const snapshot = take(t, { cli: onProduction, target: "production" });
  assert.equal(snapshot.meta.environment, "production"); assert.equal(snapshot.meta.ref, refs.production); assert.deepEqual(onProduction.calls(), ["projects list", "db query"]);
  assert.match(statements(onProduction.state().queries[0])[0].tokens.map((token) => token.value).join(" "), /read only$/); assert.equal(onProduction.linkedFile(), refs.production);
});

test("what a snapshot may contain: a field or a value that is not counts, hashes or names is refused", (t) => {
  const good = take(t); assert.deepEqual(snapshotProblems(good), []);
  const broken = (change, pattern) => { const document = copy(good); change(document); const problems = snapshotProblems(document); assert.match(problems.join(" | "), pattern); assertClean(problems); return problems; };
  broken((d) => { d.tables[0].email = "ana@example.com"; }, /tables\[0\]: unexpected field \(email\)/);
  broken((d) => { d.tables[0].rows = [{ first_name: "Ana" }]; }, /tables\[0\]: unexpected field \(rows\)/);
  broken((d) => { d.tables[3].fingerprint = "a".repeat(64); }, /tables\[3\]: unexpected field \(fingerprint\)/);
  broken((d) => { d.sample = { note: "Paciente con ansiedad" }; }, /snapshot: unexpected field \(sample\)/);
  broken((d) => { d.meta.operator = "ana@example.com"; }, /meta: unexpected field \(operator\)/);
  broken((d) => { d.meta["ana@example.com"] = 1; }, /meta: unexpected field \(name not shown\)/);
  broken((d) => { d.meta.label = "ana@example.com"; }, /meta\.label: is not a label/);
  broken((d) => { d.meta.release = "Paciente con ansiedad"; }, /meta\.release: is not a release id/);
  broken((d) => { d.tables[0].fingerprint = "ana@example.com"; }, /tables\[0\]\.fingerprint: is not a hash/);
  broken((d) => { d.tables[0].table = "Zulema Quiroga"; }, /tables\[0\]\.table: is not a table name/);
  broken((d) => { d.tables[0].key = ["ana@example.com"]; }, /tables\[0\]\.key\[0\]: is not a column name/);
  broken((d) => { d.tables[2].excluded = ["APP_USR-token-123"]; }, /tables\[2\]\.excluded\[0\]: is not a column name/);
  broken((d) => { d.tables[0].count = "2 (Ana, Zulema Quiroga)"; }, /tables\[0\]\.count: is not a count/);
  broken((d) => { d.warnings = [{ code: "uncovered_table", table: "public.x", detail: "Ana" }]; }, /warnings\[0\]: unexpected field \(detail\)/);
  broken((d) => { d.warnings = [{ code: "Paciente con ansiedad", table: "public.x" }]; }, /warnings\[0\]\.code: is not a known warning/);
  broken((d) => { d.warnings = ["ana@example.com"]; }, /warnings\[0\]: is not a warning/);
  broken((d) => { d.ignored = ["ana@example.com"]; }, /ignored\[0\]: is not a table name/);
  broken((d) => { d.meta.ref = refs.production; }, /meta\.environment: is not staging or production with its own ref/);
  broken((d) => { d.version = 2; }, /version: is not a version/); broken((d) => { d.tables = []; }, /tables: is missing or empty/); broken((d) => { d.tables.push(copy(d.tables[0])); }, /is listed twice/);
  assert.deepEqual(snapshotProblems(null), ["the snapshot is not a document"]); assert.deepEqual(snapshotProblems([]), ["the snapshot is not a document"]);
  assert.throws(() => acceptSnapshot({ ...copy(good), sample: { email: "ana@example.com" } }, "first"), (error) => { assertClean([error.message, error.details]); return refusedBy(/The first snapshot is not valid/)(error); });
  assert.throws(() => buildSnapshot({ tables: [], uncovered: [], self_test: { base: "x" } }, config(), { label: "pre", environment: "staging" }), refusedBy(/failed its own check/));
});

test("compare: two snapshots of the same data are identical", (t) => {
  const seen = compareSnapshots(take(t), take(t, { label: "post" }));
  assert.equal(seen.ok, true); assert.equal(seen.comparable, true); assert.deepEqual(seen.problems, []); assert.deepEqual(seen.different, []);
  assert.deepEqual(seen.rows.find((row) => row.table === "public.patients"), { table: "public.patients", countBefore: 2, countAfter: 2, countEqual: true, fingerprintEqual: true, status: "same" });
  assert.deepEqual(seen.rows.find((row) => row.table === "auth.users"), { table: "auth.users", countBefore: 2, countAfter: 2, countEqual: true, fingerprintEqual: null, status: "same" });
});

test("compare: a different number of rows fails", (t) => {
  const db = database(); db["public.patients"].rows.push({ id: "p3", first_name: "Nuevo", email: null, phone: null, note: null }); db["auth.users"].rows.pop();
  const seen = compareSnapshots(take(t), take(t, { cli: cliWith(t, { db }), label: "post" }));
  assert.equal(seen.ok, false); assert.deepEqual(seen.different.map((row) => [row.table, row.status, row.countBefore, row.countAfter]), [["public.patients", "count", 2, 3], ["auth.users", "count", 2, 1]]);
  assert.deepEqual(seen.different.map(differenceLine), ["public.patients: the number of rows changed (2 → 3 rows)", "auth.users: the number of rows changed (2 → 1 rows)"]);
});

test("compare: the same number of rows with different content fails", (t) => {
  const db = database(); db["public.members"].rows[1].role = "owner";
  const seen = compareSnapshots(take(t), take(t, { cli: cliWith(t, { db }), label: "post" }));
  assert.equal(seen.ok, false); assert.deepEqual(seen.different.map((row) => [row.table, row.status, row.countEqual, row.fingerprintEqual]), [["public.members", "fingerprint", true, false]]);
  assert.equal(differenceLine(seen.different[0]), "public.members: same number of rows, different content (2 rows)"); assert.doesNotMatch(JSON.stringify(seen.different.map(differenceLine)), /[0-9a-f]{32}/, "no hash is shown");
});

test("compare: a different configuration makes two snapshots not comparable", (t) => {
  const before = take(t);
  const newer = config(); newer.version = 2; let seen = compareSnapshots(before, take(t, { cli: cliWith(t, { settings: newer }), settings: newer, label: "post" }));
  assert.equal(seen.ok, false); assert.equal(seen.comparable, false); assert.deepEqual(seen.problems, ["the configuration version differs (1 and 2)"]);
  const other = config(); other.tables[2].exclude = []; seen = compareSnapshots(before, take(t, { cli: cliWith(t, { settings: other }), settings: other, label: "post" }));
  assert.equal(seen.ok, false); assert.match(seen.problems[0], /the configuration differs/); assert.deepEqual(seen.different.map((row) => [row.table, row.status]), [["private.accounts", "settings"]]);
  const noted = config(); noted.tables[0].why = "a note"; noted.ignored[0].reason = "another way of saying the same thing"; assert.equal(configHash(noted), configHash(config()), "notes are not part of what is compared");
});

test("compare: a table added or removed, changed columns and another environment all fail", (t) => {
  const before = take(t);
  const fewer = config(); fewer.tables.splice(1, 1); let seen = compareSnapshots(before, take(t, { cli: cliWith(t, { settings: fewer }), settings: fewer, label: "post" }));
  assert.deepEqual(seen.different.map((row) => [row.table, row.status]), [["public.members", "removed"]]); assert.equal(differenceLine(seen.different[0]), "public.members: only in the first snapshot");
  seen = compareSnapshots(take(t, { cli: cliWith(t, { settings: fewer }), settings: fewer }), before); assert.deepEqual(seen.different.map((row) => [row.table, row.status]), [["public.members", "added"]]);
  const db = database(); db["public.members"].columns.push("invited_at");
  seen = compareSnapshots(before, take(t, { cli: cliWith(t, { db }), label: "post" })); assert.deepEqual(seen.different.map((row) => [row.table, row.status]), [["public.members", "columns"]]); assert.equal(seen.ok, false);
  seen = compareSnapshots(before, take(t, { cli: cliWith(t, { linked: refs.production }), target: "production", label: "post" }));
  assert.equal(seen.ok, false); assert.equal(seen.comparable, false); assert.deepEqual(seen.problems, ["the two snapshots are of different environments (staging and production)"]);
});

/** A project in a scratch folder with the snapshot configuration, and the `snapshot` command run in-process. */
function project(t, settings = config()) {
  const root = scratch(t, "bellis-snap-"); mkdirSync(join(root, "scripts", "release", "snapshot"), { recursive: true });
  writeFileSync(join(root, "scripts", "release", "snapshot", "tables.json"), JSON.stringify(settings)); return { root, home: scratch(t, "bellis-home-"), git: createGit({ cwd: gitRepo(t).dir }) };
}
async function invoke(t, argv, { cli = cliWith(t), made = project(t), environment } = {}) {
  let output = "";
  const code = await main(argv, { root: made.root, environment: environment ?? cli.environment, home: made.home, write: (text) => { output += text; }, supabase: cli.supabase, git: made.git });
  return { code, output, cli, made };
}
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";

test("command: a snapshot is kept in the release's folder, outside the repository, with no row in it", async (t) => {
  const { code, output, made } = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"]);
  assert.equal(code, EXIT.PASS, output);
  const file = join(made.home, "Bellis-Releases", "h2-9", "snapshot-pre.json"); assert.ok(existsSync(file)); const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.release, "h2-9"); assert.equal(saved.name, "snapshot-pre"); assert.deepEqual(snapshotProblems(saved.data), []); assert.equal(saved.data.meta.environment, "staging"); assert.match(saved.data.meta.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(readSnapshotFile(file), saved.data, "the saved file can be read back as a snapshot");
  assert.match(output, /^ {7}2 {2}public\.patients\n {7}2 {2}public\.members\n {7}1 {2}private\.accounts\n {7}2 {2}auth\.users {2}\(count only\)\n/);
  assert.match(sectionOf(output, "SNAPSHOT"), /^SNAPSHOT\nPASS\n- pre: 4 table\(s\), 3 fingerprinted, 1 counted only\n- rows counted: 7\n- columns left out of fingerprints: private\.accounts\.token_expires_at\n- tables left out on purpose: public\.request_limits\n- saved to /);
  assert.match(sectionOf(output, "TARGET"), /^TARGET\nPASS\n- STAGING \(hbvmcvemrkfovzhlpgys\)/); assert.match(sectionOf(output, "CLI FINAL TARGET"), /^CLI FINAL TARGET\nPASS\n- STAGING/);
  assert.doesNotMatch(output, /[0-9a-f]{64}/, "no fingerprint in what a person reads"); assertClean(output); assertClean(readFileSync(file, "utf8"));
  assert.deepEqual(readdirSync(made.root), ["scripts"], "nothing was written in the repository");
});

test("command: pre, post and compare, by label", async (t) => {
  const made = project(t);
  assert.equal((await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"], { made })).code, EXIT.PASS);
  assert.equal((await invoke(t, ["snapshot", "--release", "h2-9", "--label", "post"], { made })).code, EXIT.PASS);
  const same = await invoke(t, ["snapshot", "--release", "h2-9", "--compare", "pre", "post"], { made });
  assert.equal(same.code, EXIT.PASS, same.output); assert.match(sectionOf(same.output, "SNAPSHOT"), /^SNAPSHOT\nPASS\n- IDENTICAL: 4 table\(s\), same counts and same fingerprints\n- first: pre \(staging, 2026-10-13T12:00:00Z\)\n- second: post /);
  assert.deepEqual(same.cli.calls(), [], "comparing reads two files and nothing else");
  const db = database(); db["public.patients"].rows.pop(); db["public.members"].rows[0].role = "reception";
  assert.equal((await invoke(t, ["snapshot", "--release", "h2-9", "--label", "post-2"], { made, cli: cliWith(t, { db }) })).code, EXIT.PASS);
  const differs = await invoke(t, ["snapshot", "--release", "h2-9", "--compare", "pre", "post-2"], { made });
  assert.equal(differs.code, EXIT.CHECK_FAILED);
  assert.match(differs.output, /^DIFFERENT {2}public\.patients: the number of rows changed \(2 → 1 rows\)\nDIFFERENT {2}public\.members: same number of rows, different content \(2 rows\)\n/);
  assert.match(sectionOf(differs.output, "SNAPSHOT"), /^SNAPSHOT\nFAIL\n- DIFFERENT: 2 of 4 table\(s\)\n[\s\S]*- public\.patients: the number of rows changed \(2 → 1 rows\)\n- public\.members: same number of rows, different content \(2 rows\)/);
  assert.match(differs.output, /- exit 1 \(CHECK_FAILED\)/); assert.doesNotMatch(differs.output, /[0-9a-f]{64}/); assertClean(differs.output);
});

test("command: compare by file, and machine-readable", async (t) => {
  const made = project(t); const out = join(scratch(t), "pre.json");
  assert.equal((await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre", "--output", out], { made })).code, EXIT.PASS); assert.deepEqual(snapshotProblems(JSON.parse(readFileSync(out, "utf8"))), []);
  const db = database(); db["auth.users"].rows.push({ id: "u3", email: "new@example.com", encrypted_password: "x" });
  await invoke(t, ["snapshot", "--release", "h2-9", "--label", "post"], { made, cli: cliWith(t, { db }) });
  const { code, output } = await invoke(t, ["snapshot", "--compare", out, join(made.home, "Bellis-Releases", "h2-9", "snapshot-post.json"), "--ndjson"], { made });
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["table", "table", "table", "table", "compare", "report"]); assert.equal(code, EXIT.CHECK_FAILED);
  assert.deepEqual(events[0], { type: "table", table: "public.patients", countBefore: 2, countAfter: 2, countEqual: true, fingerprintEqual: true, status: "same" });
  assert.deepEqual(events[3], { type: "table", table: "auth.users", countBefore: 2, countAfter: 3, countEqual: false, fingerprintEqual: null, status: "count" });
  assert.deepEqual(events[4], { type: "compare", ok: false, comparable: true, tables: 4, different: 1, problems: [] }); assert.equal(events[5].exitCode, EXIT.CHECK_FAILED); assert.equal(events[5].sections.SNAPSHOT.status, "FAIL");
  assert.doesNotMatch(output, /[0-9a-f]{64}/); assertClean(output);
  const taken = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "again", "--ndjson"], { made }); const lines = taken.output.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((event) => event.type), ["table", "table", "table", "table", "snapshot", "report"]); assert.deepEqual(lines[0], { type: "table", table: "public.patients", mode: "fingerprint", count: 2 });
});

test("command: a file that is not a snapshot, or carries something it must not, is refused", async (t) => {
  const made = project(t); const dir = scratch(t); await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"], { made });
  const good = join(made.home, "Bellis-Releases", "h2-9", "snapshot-pre.json"); const tampered = JSON.parse(readFileSync(good, "utf8")).data; tampered.tables[0].sample = { email: "ana@example.com", note: "Paciente con ansiedad" };
  writeFileSync(join(dir, "tampered.json"), JSON.stringify(tampered)); writeFileSync(join(dir, "other.json"), JSON.stringify({ hello: "world" })); writeFileSync(join(dir, "broken.json"), "{");
  for (const [file, code] of [["tampered.json", EXIT.CHECK_FAILED], ["other.json", EXIT.CHECK_FAILED], ["broken.json", EXIT.PRECONDITION_OR_USAGE], ["missing.json", EXIT.PRECONDITION_OR_USAGE]]) {
    const out = await invoke(t, ["snapshot", "--compare", good, join(dir, file)], { made }); assert.equal(out.code, code, file); assertClean(out.output);
  }
  const out = await invoke(t, ["snapshot", "--compare", good, join(dir, "tampered.json")], { made }); assert.match(out.output, /The second snapshot is not valid, or holds something a snapshot cannot contain\.\n- tables\[0\]: unexpected field \(sample\)/);
  assert.equal((await invoke(t, ["snapshot", "--release", "h2-9", "--compare", "pre", "nope"], { made })).code, EXIT.PRECONDITION_OR_USAGE);
});

test("command: the state folder cannot be inside the repository, and neither can --output", async (t) => {
  const made = project(t); const cli = cliWith(t);
  const inside = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"], { made, cli, environment: { ...cli.environment, BELLIS_RELEASES_DIR: join(made.root, "releases") } });
  assert.equal(inside.code, EXIT.PRECONDITION_OR_USAGE); assert.match(inside.output, /The release state folder cannot be inside the repository/); assert.deepEqual(cli.calls(), [], "nothing was read from the database");
  const output = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre", "--output", join(made.root, "pre.json")], { made });
  assert.equal(output.code, EXIT.PRECONDITION_OR_USAGE); assert.match(output.output, /--output cannot be inside the repository/); assert.deepEqual(output.cli.calls(), []);
  assert.deepEqual(readdirSync(made.root), ["scripts"]); assert.equal(existsSync(join(made.home, "Bellis-Releases")), false);
});

test("command: a label is not overwritten by accident, and the arguments have to make sense", async (t) => {
  const made = project(t);
  assert.equal((await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"], { made })).code, EXIT.PASS);
  const again = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"], { made });
  assert.equal(again.code, EXIT.PRECONDITION_OR_USAGE); assert.match(again.output, /already has a snapshot labelled pre/); assert.deepEqual(again.cli.calls(), []);
  assert.equal((await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre", "--replace"], { made })).code, EXIT.PASS);
  for (const argv of [["snapshot"], ["snapshot", "--label", "pre"], ["snapshot", "--release", "h2-9"], ["snapshot", "--release", "../x", "--label", "pre"], ["snapshot", "--release", "h2-9", "--label", "Pre Release"], ["snapshot", "--release", "h2-9", "--label", "a", "b"],
    ["snapshot", "--release", "h2-9", "--label", "x", "--env", "prod"], ["snapshot", "--compare", "one"], ["snapshot", "--compare", "a", "b", "c"], ["snapshot", "--release", "h2-9", "--compare", "pre", "pre", "--label", "x"], ["snapshot", "--release", "h2-9", "--label", "x", "--force"]]) {
    const out = await invoke(t, argv, { made }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE, argv.join(" ")); assert.deepEqual(out.cli.calls(), [], argv.join(" "));
  }
});

test("command: a target in doubt is exit 3, a failed capture is exit 1, and neither leaves a file or a secret", async (t) => {
  const ambiguous = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"], { cli: cliWith(t, { marks: "both" }) });
  assert.equal(ambiguous.code, EXIT.TARGET_NOT_CONFIRMED); assert.equal(existsSync(join(ambiguous.made.home, "Bellis-Releases", "h2-9", "snapshot-pre.json")), false);
  const elsewhere = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre", "--env", "production"]);
  assert.equal(elsewhere.code, EXIT.TARGET_NOT_CONFIRMED); assert.equal(elsewhere.cli.linkedFile(), refs.staging, "asked for production with the CLI on staging: refused, not linked");
  const production = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre", "--env", "production"], { cli: cliWith(t, { linked: refs.production }) });
  assert.equal(production.code, EXIT.PASS, production.output); assert.match(sectionOf(production.output, "TARGET"), /^TARGET\nPASS\n- PROD \(pinfdbvfzoratsntjgah\)[\s\S]*read-only transaction/);
  assert.match(sectionOf(production.output, "CLI FINAL TARGET"), /^CLI FINAL TARGET\nINFO\n- PROD \(left as it was found\)/); assert.equal(production.cli.linkedFile(), refs.production);
  for (const behaviour of [{ snapshot: "leak-error" }, { snapshot: "pii" }, { snapshot: "null-fingerprint" }, { snapshot: "garbage" }]) {
    const failed = await invoke(t, ["snapshot", "--release", "h2-9", "--label", "pre"], { cli: cliWith(t, behaviour) });
    assert.equal(failed.code, EXIT.CHECK_FAILED, JSON.stringify(behaviour)); assert.equal(existsSync(join(failed.made.home, "Bellis-Releases", "h2-9", "snapshot-pre.json")), false); assertClean(failed.output);
    assert.match(sectionOf(failed.output, "SNAPSHOT"), /^SNAPSHOT\nN\/A/);
  }
});
