/**
 * Schema drift: capturing a schema, comparing two, rehearsing a release's migrations and explaining the difference
 * between staging and production. The catalogs are the fake CLI's (tests/fixtures/fake-supabase.mjs): an answer
 * held in a JSON file, shaped like the one scripts/release/drift/schema.sql returns. Nothing here reaches Supabase.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { createGit } from "../scripts/release/lib/git.mjs";
import { CheckFailed, EXIT, HumanActionRequired, PreconditionError, TargetNotConfirmed } from "../scripts/release/lib/report.mjs";
import { sqlHash } from "../scripts/release/smoke/runner.mjs";
import { statements, validateSmokeSql } from "../scripts/release/smoke/sql.mjs";
import { buildCapture, captureProblems, captureSchema, categories, normalizeCode, schemaSql } from "../scripts/release/drift/capture.mjs";
import { acceptCapture, compareSchemas, differenceDetail, differenceLine } from "../scripts/release/drift/compare.mjs";
import { explainExpected, migrationRisks, rehearsalSql, rehearse, releaseMigrations } from "../scripts/release/drift/migration-diff.mjs";
import { fakeCli, forbidden, gitRepo, refs, releaseManifest, scratch } from "./fixtures/release-harness.mjs";

const copy = (value) => JSON.parse(JSON.stringify(value));
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
/** What the catalogs say about a small Bellis: one or two objects of every category. */
const answer = () => ({
  database_time: "2026-10-14T00:00:00Z", server_version: "170011", applied_migrations: ["20261017090000", "20261018090000"], other_cron_jobs: 0,
  schemas: [{ id: "private", owner: "postgres", unknown: false, grants: ["authenticated:USAGE", "postgres:USAGE"] }, { id: "public", owner: "pg_database_owner", unknown: false, grants: ["anon:USAGE", "authenticated:USAGE"] }],
  tables: [
    { id: "public.patients", owner: "postgres", kind: "r", rls: true, rls_forced: false, options: [], grants: ["authenticated:SELECT", "postgres:SELECT"], columns: [
      { name: "id", type: "uuid", not_null: true, default: "gen_random_uuid()", identity: "", generated: "", collation: null, grants: [] },
      { name: "workspace_id", type: "uuid", not_null: true, default: null, identity: "", generated: "", collation: null, grants: [] },
      { name: "first_name", type: "text", not_null: true, default: null, identity: "", generated: "", collation: null, grants: [] }] },
    { id: "public.workspaces", owner: "postgres", kind: "r", rls: true, rls_forced: false, options: [], grants: ["authenticated:SELECT"], columns: [
      { name: "id", type: "uuid", not_null: true, default: "gen_random_uuid()", identity: "", generated: "", collation: null, grants: [] }] }],
  constraints: [{ id: "public.patients.patients_pkey", table: "public.patients", type: "p", definition: "PRIMARY KEY (id)", validated: true, deferrable: false, deferred: false }],
  indexes: [{ id: "public.patients_open_idx", table: "public.patients", definition: "CREATE INDEX patients_open_idx ON public.patients USING btree (workspace_id) WHERE (first_name IS NOT NULL)", unique: false, primary: false, valid: true, predicate: "(first_name IS NOT NULL)", expressions: null }],
  policies: [{ id: "public.patients.patients_member_read", table: "public.patients", command: "r", permissive: true, roles: ["authenticated", "service_role"], using: "private.is_member(workspace_id)", check: null }],
  functions: [
    { id: "private.is_member(p_workspace uuid)", kind: "f", arguments: "p_workspace uuid", result: "boolean", language: "sql", volatility: "s", security_definer: true, leakproof: false, parallel: "u", strict: false,
      config: ["search_path=\"\"", "statement_timeout=5s"], owner: "postgres", body: "\n  select exists (select 1 from public.workspaces w where w.id = p_workspace and w.id is not null)\n", sql_body: null, grants: ["authenticated:EXECUTE", "postgres:EXECUTE"] },
    { id: "private.notify_partner()", kind: "f", arguments: "", result: "void", language: "plpgsql", volatility: "v", security_definer: true, leakproof: false, parallel: "u", strict: false, config: ["search_path=\"\""], owner: "postgres",
      body: `\nbegin\n  perform net.http_post('https://partner.example/hook', headers := '{"Authorization": "Bearer ${jwt}"}');\n  -- the partner's key\n  perform 'postgres://postgres:hunter2-secret@db.example.supabase.co:5432/postgres';\nend;\n`, sql_body: null, grants: ["postgres:EXECUTE"] }],
  views: [{ id: "public.patient_overview", kind: "v", owner: "postgres", definition: " SELECT p.id,\n    p.workspace_id\n   FROM public.patients p;", options: ["security_invoker=true"], grants: ["authenticated:SELECT"] }],
  triggers: [
    { id: "auth.users.on_auth_user_created_bellis", table: "auth.users", function: "private.bootstrap_bellis_user", enabled: "O", type: 5, definition: "CREATE TRIGGER on_auth_user_created_bellis AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION private.bootstrap_bellis_user()" },
    { id: "public.patients.patients_touch", table: "public.patients", function: "private.touch", enabled: "O", type: 19, definition: "CREATE TRIGGER patients_touch BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION private.touch()" }],
  types: [{ id: "public.booking_status", kind: "e", owner: "postgres", values: ["pending_payment", "scheduled", "completed", "cancelled"], base: null, not_null: false, default: null, checks: [], attributes: [] }],
  sequences: [{ id: "public.audit_events_id_seq", owner: "postgres", type: "bigint", start: "1", increment: "1", minimum: "1", maximum: "9223372036854775807", cycle: false, grants: ["postgres:USAGE"] }],
  default_privileges: [{ id: "postgres:public:r", grants: ["anon:SELECT", "authenticated:SELECT"] }],
  extensions: [{ id: "pg_cron", schema: "pg_catalog", info_version: "1.6.4" }],
  cron: [{ id: "bellis-plan-expirations", schedule: "20 * * * *", command: "select private.record_plan_expirations()", active: true, database: "postgres", username: "postgres" }],
});
const capture = (raw = answer(), meta = {}) => buildCapture(raw, { environment: "staging", label: "staging", capturedAt: "2026-10-14T00:00:01Z", ...meta });
const of = (raw, category, id) => raw[category].find((item) => item.id === id);
/** Compares the fixture with a changed copy of it and returns the differences as "CHANGE category id [parts]". */
const differs = (change, base = answer()) => { const changed = copy(base); change(changed); return compareSchemas(capture(base), capture(changed)).differences.map((item) => `${item.change} ${item.category} ${item.id}${item.parts.length ? ` [${item.parts.join(",")}]` : ""}`); };
const assertClean = (value) => { const text = typeof value === "string" ? value : JSON.stringify(value); for (const secret of [...forbidden, jwt]) assert.ok(!text.includes(secret), `leaked: ${secret}`); };

test("capture: every category, one hash per object and per attribute, nothing missing", () => {
  const taken = capture();
  assert.deepEqual(captureProblems(taken), []); assert.deepEqual(Object.keys(taken.objects), Object.keys(categories));
  assert.deepEqual(taken.counts, { schemas: 2, tables: 2, constraints: 1, indexes: 1, policies: 1, functions: 2, views: 1, triggers: 2, types: 1, sequences: 1, default_privileges: 1, extensions: 1, cron: 1 });
  assert.deepEqual(taken.appliedMigrations, ["20261017090000", "20261018090000"]); assert.deepEqual(taken.warnings, []);
  assert.deepEqual(taken.meta, { environment: "staging", ref: refs.staging, capturedAt: "2026-10-14T00:00:01Z", databaseTime: "2026-10-14T00:00:00Z", gitCommit: null, release: null, label: "staging", serverVersion: "170011", rehearsed: [] });
  const fn = taken.objects.functions.find((item) => item.id === "private.is_member(p_workspace uuid)");
  assert.match(fn.hash, /^[0-9a-f]{64}$/); assert.deepEqual(Object.keys(fn.parts).sort(), ["arguments", "body", "config", "grants", "kind", "language", "leakproof", "owner", "parallel", "result", "security_definer", "sql_body", "strict", "volatility"]);
  assert.deepEqual(capture().objects, taken.objects, "deterministic");
  assert.equal(compareSchemas(taken, capture()).ok, true);
  const shuffled = answer(); for (const category of Object.keys(categories)) shuffled[category].reverse();
  assert.equal(compareSchemas(taken, capture(shuffled)).ok, true, "the order objects come back in does not matter");
});

test("capture: the same object twice, a missing category or a nameless object stops it", () => {
  const broken = (change, pattern) => { const raw = answer(); change(raw); assert.throws(() => capture(raw), (error) => error instanceof CheckFailed && pattern.test(error.details.join(" | "))); };
  broken((raw) => raw.functions.push(copy(raw.functions[0])), /functions: private\.is_member\(p_workspace uuid\) appears twice/);
  broken((raw) => raw.tables.push(copy(raw.tables[1])), /tables: public\.workspaces appears twice/);
  broken((raw) => { delete raw.policies; }, /policies: missing from the answer/);
  broken((raw) => raw.indexes.push({ definition: "x" }), /indexes: an object has no usable name/);
  broken((raw) => { raw.applied_migrations = ["2026"]; }, /applied migrations could not be read/);
  assert.throws(() => capture(null), CheckFailed); assert.throws(() => capture([]), CheckFailed);
});

test("columns: reordered, retyped, made nullable or given another default is drift", () => {
  assert.deepEqual(differs((raw) => of(raw, "tables", "public.patients").columns.reverse()), ["CHANGED tables public.patients [columns]"]);
  assert.deepEqual(differs((raw) => { of(raw, "tables", "public.patients").columns[2].type = "character varying(80)"; }), ["CHANGED tables public.patients [columns]"]);
  assert.deepEqual(differs((raw) => { of(raw, "tables", "public.patients").columns[2].not_null = false; }), ["CHANGED tables public.patients [columns]"]);
  assert.deepEqual(differs((raw) => { of(raw, "tables", "public.patients").columns[0].default = "uuid_generate_v4()"; }), ["CHANGED tables public.patients [columns]"]);
  assert.deepEqual(differs((raw) => { of(raw, "tables", "public.patients").columns[2].grants = ["anon:SELECT"]; }), ["CHANGED tables public.patients [columns]"]);
  assert.deepEqual(differs((raw) => { of(raw, "tables", "public.patients").owner = "supabase_admin"; }), ["CHANGED tables public.patients [owner]"]);
});

test("whitespace that means nothing is not drift: line endings, indentation, trailing spaces, blank lines", () => {
  assert.deepEqual(differs((raw) => {
    const fn = of(raw, "functions", "private.is_member(p_workspace uuid)"); fn.body = "\r\n\r\n\tselect   exists (select 1\r\n      from public.workspaces w where w.id = p_workspace and w.id is not null)   \r\n\r\n";
    of(raw, "views", "public.patient_overview").definition = " SELECT p.id,\r\n        p.workspace_id\r\n\r\n   FROM public.patients p;  ";
    of(raw, "cron", "bellis-plan-expirations").command = "  select   private.record_plan_expirations()\n";
  }), []);
  assert.equal(normalizeCode("select  1 ,\r\n\t  2 -- note  \r\n\r\n  from x"), "select 1 , 2 -- note\nfrom x");
});

test("whitespace that means something is drift: inside a string, a quoted name or a dollar-quoted text, and comments", () => {
  const body = (text) => (raw) => { of(raw, "functions", "private.is_member(p_workspace uuid)").body = text; };
  const base = answer(); of(base, "functions", "private.is_member(p_workspace uuid)").body = "begin\n  x := 'a  b';\n  y := $t$ c  d $t$;\n  z := \"Col  A\";\n  -- keep  this\nend;";
  for (const changed of ["begin\n  x := 'a b';\n  y := $t$ c  d $t$;\n  z := \"Col  A\";\n  -- keep  this\nend;", "begin\n  x := 'a  b';\n  y := $t$ c d $t$;\n  z := \"Col  A\";\n  -- keep  this\nend;",
    "begin\n  x := 'a  b';\n  y := $t$ c  d $t$;\n  z := \"Col A\";\n  -- keep  this\nend;", "begin\n  x := 'a  b';\n  y := $t$ c  d $t$;\n  z := \"Col  A\";\n  -- keep this\nend;"])
    assert.deepEqual(differs(body(changed), base), ["CHANGED functions private.is_member(p_workspace uuid) [body]"], changed);
  assert.deepEqual(differs(body("  begin\n x := 'a  b';\n    y := $t$ c  d $t$;\n z := \"Col  A\";\n -- keep  this\n end;  "), base), [], "only the indentation changed");
  assert.equal(normalizeCode("x := E'it\\'s  here';  y"), "x := E'it\\'s  here'; y");
  assert.equal(normalizeCode("x := 'never closed  \r\n  "), "x := 'never closed  \n  ", "left open: only line endings are touched");
  assert.equal(normalizeCode("SELECT  A"), "SELECT A", "letter case is kept");
});

test("functions: a different body, search_path, security, volatility or argument is drift", () => {
  const id = "private.is_member(p_workspace uuid)"; const fn = (raw) => of(raw, "functions", id);
  assert.deepEqual(differs((raw) => { fn(raw).body = fn(raw).body.replace("w.id is not null", "true"); }), [`CHANGED functions ${id} [body]`]);
  assert.deepEqual(differs((raw) => { fn(raw).config = ["search_path=public", "statement_timeout=5s"]; }), [`CHANGED functions ${id} [config]`]);
  assert.deepEqual(differs((raw) => { fn(raw).config = ["statement_timeout=5s", "search_path=\"\""]; }), [], "settings have no order");
  assert.deepEqual(differs((raw) => { fn(raw).security_definer = false; }), [`CHANGED functions ${id} [security_definer]`]);
  assert.deepEqual(differs((raw) => { fn(raw).volatility = "v"; fn(raw).leakproof = true; }), [`CHANGED functions ${id} [leakproof,volatility]`]);
  assert.deepEqual(differs((raw) => { fn(raw).arguments = "p_workspace uuid DEFAULT NULL::uuid"; }), [`CHANGED functions ${id} [arguments]`]);
  assert.deepEqual(differs((raw) => raw.functions.push({ ...copy(fn(raw)), id: "private.is_member(p_workspace uuid, p_role text)" })), ["ADDED functions private.is_member(p_workspace uuid, p_role text)"], "an overload is another object");
});

test("grants: added or removed is drift, in any order is not", () => {
  const id = "private.is_member(p_workspace uuid)";
  assert.deepEqual(differs((raw) => of(raw, "functions", id).grants.push("anon:EXECUTE")), [`CHANGED functions ${id} [grants]`]);
  assert.deepEqual(differs((raw) => of(raw, "functions", id).grants.pop()), [`CHANGED functions ${id} [grants]`]);
  assert.deepEqual(differs((raw) => of(raw, "tables", "public.workspaces").grants.push("anon:SELECT")), ["CHANGED tables public.workspaces [grants]"]);
  assert.deepEqual(differs((raw) => { of(raw, "schemas", "private").grants = ["postgres:USAGE"]; }), ["CHANGED schemas private [grants]"]);
  assert.deepEqual(differs((raw) => of(raw, "sequences", "public.audit_events_id_seq").grants.push("anon:USAGE")), ["CHANGED sequences public.audit_events_id_seq [grants]"]);
  assert.deepEqual(differs((raw) => of(raw, "default_privileges", "postgres:public:r").grants.push("service_role:SELECT")), ["CHANGED default_privileges postgres:public:r [grants]"]);
  assert.deepEqual(differs((raw) => { of(raw, "functions", id).grants.reverse(); of(raw, "tables", "public.patients").grants.reverse(); of(raw, "schemas", "public").grants.reverse(); }), []);
  assert.deepEqual(differs((raw) => { of(raw, "functions", id).grants = ["authenticated:EXECUTE*", "postgres:EXECUTE"]; }), [`CHANGED functions ${id} [grants]`], "WITH GRANT OPTION counts");
});

test("policies, triggers, cron, enums, indexes and row-level security: each change is drift", () => {
  const policy = "public.patients.patients_member_read";
  assert.deepEqual(differs((raw) => { of(raw, "policies", policy).using = "true"; }), [`CHANGED policies ${policy} [using]`]);
  assert.deepEqual(differs((raw) => { of(raw, "policies", policy).roles = ["authenticated"]; of(raw, "policies", policy).command = "*"; }), [`CHANGED policies ${policy} [command,roles]`]);
  assert.deepEqual(differs((raw) => { of(raw, "policies", policy).permissive = false; of(raw, "policies", policy).check = "(workspace_id IS NOT NULL)"; }), [`CHANGED policies ${policy} [check,permissive]`]);
  assert.deepEqual(differs((raw) => of(raw, "policies", policy).roles.reverse()), []);
  assert.deepEqual(differs((raw) => { of(raw, "triggers", "public.patients.patients_touch").definition = "CREATE TRIGGER patients_touch BEFORE INSERT OR UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION private.touch()"; of(raw, "triggers", "public.patients.patients_touch").type = 23; }), ["CHANGED triggers public.patients.patients_touch [definition,type]"]);
  assert.deepEqual(differs((raw) => { of(raw, "triggers", "public.patients.patients_touch").enabled = "D"; }), ["CHANGED triggers public.patients.patients_touch [enabled]"]);
  assert.deepEqual(differs((raw) => raw.triggers.shift()), ["REMOVED triggers auth.users.on_auth_user_created_bellis"], "auth's trigger into Bellis is covered");
  assert.deepEqual(differs((raw) => { of(raw, "cron", "bellis-plan-expirations").schedule = "*/20 * * * *"; }), ["CHANGED cron bellis-plan-expirations [schedule]"]);
  assert.deepEqual(differs((raw) => { of(raw, "cron", "bellis-plan-expirations").active = false; }), ["CHANGED cron bellis-plan-expirations [active]"]);
  assert.deepEqual(differs((raw) => { of(raw, "types", "public.booking_status").values = ["scheduled", "pending_payment", "completed", "cancelled"]; }), ["CHANGED types public.booking_status [values]"], "the order of an enum means something");
  assert.deepEqual(differs((raw) => of(raw, "types", "public.booking_status").values.push("no_show")), ["CHANGED types public.booking_status [values]"]);
  assert.deepEqual(differs((raw) => { const index = of(raw, "indexes", "public.patients_open_idx"); index.predicate = "(first_name IS NULL)"; index.definition = index.definition.replace("IS NOT NULL", "IS NULL"); }), ["CHANGED indexes public.patients_open_idx [definition,predicate]"]);
  assert.deepEqual(differs((raw) => { of(raw, "tables", "public.patients").rls = false; }), ["CHANGED tables public.patients [rls]"]);
  assert.deepEqual(differs((raw) => { of(raw, "tables", "public.patients").rls_forced = true; }), ["CHANGED tables public.patients [rls_forced]"]);
  assert.deepEqual(differs((raw) => { of(raw, "views", "public.patient_overview").options = []; }), ["CHANGED views public.patient_overview [options]"], "security_invoker counts");
  assert.deepEqual(differs((raw) => { of(raw, "constraints", "public.patients.patients_pkey").validated = false; }), ["CHANGED constraints public.patients.patients_pkey [validated]"]);
});

test("tables added or removed are drift; an extension's version alone is not", () => {
  assert.deepEqual(differs((raw) => raw.tables.push({ ...copy(raw.tables[1]), id: "public.new_table" })), ["ADDED tables public.new_table"]);
  assert.deepEqual(differs((raw) => raw.tables.pop()), ["REMOVED tables public.workspaces"]);
  assert.deepEqual(differs((raw) => { raw.extensions[0].info_version = "1.6.5"; }), [], "the platform updates extensions on its own");
  assert.deepEqual(differs((raw) => { raw.extensions[0].schema = "extensions"; }), ["CHANGED extensions pg_cron [schema]"]);
  assert.deepEqual(differs((raw) => raw.extensions.pop()), ["REMOVED extensions pg_cron"]);
});

test("an unknown schema or other cron jobs are warnings, and an unknown schema that appears is drift", () => {
  const raw = answer(); raw.schemas.push({ id: "reporting", owner: "postgres", unknown: true, grants: [] }); raw.other_cron_jobs = 2;
  const taken = capture(raw);
  assert.deepEqual(taken.warnings, [{ code: "unknown_schema", object: "reporting" }, { code: "other_cron_jobs", object: "2" }]);
  assert.deepEqual(compareSchemas(capture(), taken).differences.map((item) => `${item.change} ${item.category} ${item.id}`), ["ADDED schemas reporting"]);
});

test("secrets: what is kept and shown is redacted, and a change in a secret is still drift", () => {
  const taken = capture(); assertClean(taken);
  const body = taken.objects.functions.find((item) => item.id === "private.notify_partner()").definition.body;
  assert.match(body, /Bearer \[jwt\]/); assert.match(body, /\[connection string\]/); assert.match(body, /; -- the partner's key\nperform/, "a comment keeps the line break that ends it");
  const changed = answer(); of(changed, "functions", "private.notify_partner()").body = of(changed, "functions", "private.notify_partner()").body.replace(jwt, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ5In0.b3RoZXJzaWdu");
  const seen = compareSchemas(taken, capture(changed));
  assert.deepEqual(seen.differences.map((item) => [item.change, item.id, item.parts]), [["CHANGED", "private.notify_partner()", ["body"]]], "the hash comes from what the database said");
  const detail = differenceDetail(seen.differences[0], taken, capture(changed), ["staging", "production"]);
  assert.equal(detail.length, 2); assert.match(detail[0], /^ {4}body in staging: /); assertClean(detail);
  assert.equal(differenceLine(seen.differences[0], ["staging", "production"]), "CHANGED  functions  private.notify_partner() (body)");
});

test("a capture read back is checked: tampered, duplicated or incomplete documents are refused", () => {
  const good = capture();
  const broken = (change, pattern) => { const document = copy(good); change(document); assert.match(captureProblems(document).join(" | "), pattern); };
  broken((d) => { d.objects.rows = []; }, /a category this tool does not know/);
  broken((d) => { delete d.objects.cron; }, /objects\.cron: is missing/);
  broken((d) => d.objects.tables.push(copy(d.objects.tables[0])), /objects\.tables: has the same object twice/);
  broken((d) => { d.objects.tables[0].hash = "x"; }, /objects\.tables: has an entry that is not an object of a schema/);
  broken((d) => { d.counts.views = 9; }, /counts\.views: does not match/);
  broken((d) => { d.meta.ref = refs.production; }, /meta\.environment/);
  broken((d) => { d.formatVersion = 2; }, /formatVersion/);
  broken((d) => { d.meta.rehearsed = [{ file: "../x.sql", sha256: "a" }]; }, /meta\.rehearsed/);
  assert.throws(() => acceptCapture({ hello: "world" }, "second"), (error) => error instanceof CheckFailed && /The second capture is not a valid schema capture/.test(error.message));
  assert.deepEqual(acceptCapture({ release: "x", name: "schema-staging", data: good }), good, "the state folder's wrapper is accepted");
});

test("the SQL of a capture: read-only, rolled back, with an empty search path, and only catalogs", () => {
  const sql = schemaSql(); const list = statements(sql);
  assert.equal(validateSmokeSql(sql).ok, true); assert.equal(list[0].tokens.map((token) => token.value).join(" "), "begin transaction isolation level repeatable read read only");
  assert.deepEqual(list.map((statement) => statement.tokens[0].value), ["begin", "set", "set", "with", "rollback"]);
  assert.match(sql, /set local search_path = '';/);
  const words = list.flatMap((statement) => statement.tokens).filter((token) => token.type === "word").map((token) => token.value);
  for (const verb of ["insert", "update", "delete", "truncate", "alter", "drop", "create", "grant", "copy", "call", "do"]) assert.equal(words.includes(verb), false, verb);
  // Every relation it reads is a catalog, the migrations' list or cron's jobs: no table of the product.
  const relations = [...sql.matchAll(/\bfrom\s+([a-z_]+\.[a-z_]+|[a-z_]+)(?=[\s,)])/g)].map((match) => match[1]).filter((name) => !["ns", "member", "settings"].includes(name));
  for (const name of relations) assert.ok(/^pg_|^supabase_migrations\.schema_migrations$|^cron\.job$|^aclexplode$|^unnest$/.test(name), name);
  for (const category of Object.keys(categories)) assert.ok(sql.includes(`'${category}', (select`), category);
  assert.doesNotMatch(sql, /auth\.users/, "auth.users is never read; its triggers are found through pg_trigger");
});

test("capture against the fake CLI: confirmed target, one read-only query, never a link", (t) => {
  const cli = fakeCli(t, { schema: answer() });
  const taken = captureSchema({ supabase: cli.supabase, target: "staging", release: "h2-9", label: "staging", environment: cli.environment, temporary: scratch(t) });
  assert.deepEqual(captureProblems(taken), []); assert.deepEqual(cli.calls(), ["projects list", "db query"]);
  assert.match(statements(cli.state().queries[0])[0].tokens.map((token) => token.value).join(" "), /read only$/); assertClean(taken);
  for (const behaviour of [{ marks: "both" }, { marks: "none" }, { failProjects: true }, { linked: refs.production }]) {
    const other = fakeCli(t, { schema: answer(), ...behaviour });
    assert.throws(() => captureSchema({ supabase: other.supabase, target: "staging", label: "staging", environment: other.environment, temporary: scratch(t) }), TargetNotConfirmed, JSON.stringify(behaviour));
    assert.equal((other.state().queries ?? []).length, 0); assert.equal(other.calls().some((call) => call.startsWith("link")), false);
  }
  const ambiguousProduction = fakeCli(t, { schema: answer(), linked: refs.production, marks: "both" });
  assert.throws(() => captureSchema({ supabase: ambiguousProduction.supabase, target: "production", label: "production", environment: ambiguousProduction.environment, temporary: scratch(t) }), TargetNotConfirmed);
  assert.throws(() => captureSchema({ supabase: cli.supabase, target: "production", label: "production", environment: cli.environment, temporary: scratch(t) }), TargetNotConfirmed, "asked for production with the CLI on staging");
  const production = fakeCli(t, { schema: answer(), linked: refs.production });
  const prod = captureSchema({ supabase: production.supabase, target: "production", label: "production", environment: production.environment, temporary: scratch(t) });
  assert.equal(prod.meta.environment, "production"); assert.equal(production.linkedFile(), refs.production); assert.deepEqual(production.calls(), ["projects list", "db query"]);
  for (const [mode, pattern] of [["garbage", /could not be read/], ["leak-error", /SQL error P0001: failed to connect to \[connection string\]/]]) {
    const failing = fakeCli(t, { schema: answer(), schemaMode: mode });
    assert.throws(() => captureSchema({ supabase: failing.supabase, label: "staging", environment: failing.environment, temporary: scratch(t) }), (error) => { assertClean([error.message, error.details]); return error instanceof CheckFailed && pattern.test(error.details.join()); });
  }
});

test("migration risks: what cannot be rehearsed in a rolled-back transaction is found, and nothing else", () => {
  assert.deepEqual(migrationRisks("create table a(id int);\nalter type public.booking_status add value 'no_show';\nselect cron.schedule('bellis-x', '5 * * * *', 'select 1');\ninsert into a values (1);"), []);
  assert.deepEqual(migrationRisks("create function f() returns void language plpgsql as $$ begin perform setval('s', 1); perform dblink_exec('x'); end $$;"), [], "a function that is only created does not run");
  assert.deepEqual(migrationRisks("-- create index concurrently\nselect 'vacuum';"), []);
  const risks = (sql) => migrationRisks(sql).join(" | ");
  assert.match(risks("create index concurrently i on a(id);"), /statement 1: CONCURRENTLY cannot run inside a transaction/);
  assert.match(risks("create table a(id int);\ncreate extension if not exists pg_net;"), /statement 2: CREATE EXTENSION IF/);
  assert.match(risks("drop extension btree_gist;"), /DROP EXTENSION/);
  assert.match(risks("vacuum analyze a;"), /VACUUM cannot be rehearsed/);
  assert.match(risks("do $$ begin perform setval('public.s', 10); end $$;"), /statement 1 \(DO block\): setval\(\) moves a sequence/);
  assert.match(risks("select pg_advisory_lock(1);"), /takes a lock that outlives the transaction/);
  assert.match(risks("select net.http_post('https://x');"), /http_post\(\) sends a request to the outside/);
  assert.match(risks("copy a from '/tmp/x';"), /COPY reads or writes outside the database/);
  assert.match(risks("alter system set work_mem = '1GB';"), /ALTER SYSTEM/);
  assert.match(risks("create database other;"), /CREATE DATABASE/);
  assert.match(risks("select 'open;"), /cannot be read/);
});

/** A project with migrations and a release manifest, in a scratch folder. */
function project(t, migrations = { "20261020090000_add_notes_flag.sql": "alter table public.patients add column flagged boolean not null default false;\n" }, { manifest } = {}) {
  const root = scratch(t, "bellis-drift-"); mkdirSync(join(root, "supabase", "migrations"), { recursive: true }); mkdirSync(join(root, "releases"), { recursive: true });
  for (const [name, text] of Object.entries(migrations)) writeFileSync(join(root, "supabase", "migrations", name), text);
  writeFileSync(join(root, "releases", "h2-9.json"), JSON.stringify(manifest ?? releaseManifest({ migrations: Object.entries(migrations).map(([file, text]) => ({ file, sha256: sqlHash(text) })) })));
  return { root, home: scratch(t, "bellis-home-"), git: createGit({ cwd: gitRepo(t).dir }) };
}
/** What the catalogs say after the release's migration: one more column. */
const migrated = () => { const raw = answer(); of(raw, "tables", "public.patients").columns.push({ name: "flagged", type: "boolean", not_null: true, default: "false", identity: "", generated: "", collation: null, grants: [] }); raw.applied_migrations.push("20261020090000"); return raw; };

test("release migrations: the manifest's files, in order, with their hashes, from supabase/migrations only", (t) => {
  const made = project(t, { "20261020090000_a.sql": "create table a(id int);\n", "20261021090000_b.sql": "create table b(id int);\n" });
  assert.deepEqual(releaseMigrations(made.root, "h2-9").map((item) => [item.file, item.verified]), [["20261020090000_a.sql", true], ["20261021090000_b.sql", true]]);
  writeFileSync(join(made.root, "supabase", "migrations", "20261021090000_b.sql"), "create table b(id int, extra int);\n");
  assert.throws(() => releaseMigrations(made.root, "h2-9"), (error) => error instanceof CheckFailed && /the hash differs/.test(error.message));
  const reversed = project(t, { "20261020090000_a.sql": "create table a(id int);\n", "20261021090000_b.sql": "create table b(id int);\n" }, { manifest: releaseManifest({ migrations: [{ file: "20261021090000_b.sql", sha256: sqlHash("create table b(id int);\n") }, { file: "20261020090000_a.sql", sha256: sqlHash("create table a(id int);\n") }] }) });
  assert.throws(() => releaseMigrations(reversed.root, "h2-9"), (error) => error instanceof CheckFailed && /not in the order they are applied/.test(error.details.join()));
  const outside = project(t, {}, { manifest: releaseManifest({ migrations: [{ file: "../../outside.sql", sha256: "a".repeat(64) }] }) });
  assert.throws(() => releaseMigrations(outside.root, "h2-9"), (error) => error instanceof CheckFailed && /the file name of a migration \(no path\)/.test(error.details.join()));
  const own = project(t, { "20261020090000_a.sql": "begin;\ncreate table a(id int);\ncommit;\n" });
  assert.throws(() => releaseMigrations(own.root, "h2-9"), (error) => error instanceof CheckFailed && /cannot run inside a smoke's transaction/.test(error.message));
  assert.throws(() => releaseMigrations(made.root, "nope"), PreconditionError); assert.throws(() => releaseMigrations(made.root, "../x"), PreconditionError);
  assert.throws(() => releaseMigrations(project(t, {}).root, "h2-9"), /lists no migrations/);
});

test("rehearsal: the migrations run in one transaction on staging, the schema is measured, and staging is left as it was", (t) => {
  const made = project(t); const pending = releaseMigrations(made.root, "h2-9");
  const cli = fakeCli(t, { schema: answer(), schemaRehearsed: migrated() });
  const outcome = rehearse({ supabase: cli.supabase, pending, release: "h2-9", environment: cli.environment, temporary: scratch(t) });
  assert.deepEqual(outcome.changes.differences.map((item) => `${item.change} ${item.category} ${item.id} [${item.parts}]`), ["CHANGED tables public.patients [columns]"]);
  assert.deepEqual(outcome.expected.meta.rehearsed, [{ file: "20261020090000_add_notes_flag.sql", sha256: pending[0].sha256 }]); assert.deepEqual(outcome.base.meta.rehearsed, []);
  assert.deepEqual(cli.calls(), ["projects list", "projects list", "db query", "db query", "db query", "projects list", "db query"], "confirm, capture, rehearse, check the rollback, capture again; never a link");
  const sql = cli.state().queries[1]; const list = statements(sql);
  assert.equal(validateSmokeSql(sql).ok, true); assert.deepEqual(list.map((statement) => statement.tokens[0].value), ["begin", "alter", "set", "set", "select", "rollback"]);
  assert.ok(sql.indexOf("add column flagged") < sql.indexOf("set local search_path")); assert.equal(rehearsalSql(pending), sql);
  assert.match(cli.state().queries[2], /txid_status/);
});

test("rehearsal fails closed: production, an unsafe migration, already applied, a rollback that did not happen, a schema that changed", (t) => {
  const made = project(t); const pending = releaseMigrations(made.root, "h2-9"); const run = (cli, list = pending) => rehearse({ supabase: cli.supabase, pending: list, release: "h2-9", environment: cli.environment, temporary: scratch(t) });
  const onProduction = fakeCli(t, { schema: answer(), schemaRehearsed: migrated(), linked: refs.production });
  assert.throws(() => run(onProduction), TargetNotConfirmed); assert.equal((onProduction.state().queries ?? []).length, 0, "nothing ever runs on production");
  const unsafe = fakeCli(t, { schema: answer() });
  assert.throws(() => run(unsafe, [{ ...pending[0], text: "create index concurrently i on public.patients(id);" }]), (error) => error instanceof HumanActionRequired && /CONCURRENTLY/.test(error.details.join()));
  assert.deepEqual(unsafe.calls(), [], "refused before anything was sent");
  const applied = fakeCli(t, { schema: migrated() });
  assert.throws(() => run(applied), (error) => error instanceof HumanActionRequired && /already applied on staging/.test(error.details.join()));
  assert.equal(applied.state().queries.length, 1, "only the base capture ran");
  const committed = fakeCli(t, { schema: answer(), schemaRehearsed: migrated(), txStatus: { rehearsal: "committed" } });
  assert.throws(() => run(committed), (error) => error instanceof CheckFailed && /not reported as rolled back/.test(error.message));
  const leftover = fakeCli(t, { schema: answer(), schemaRehearsed: migrated(), schemaLater: migrated() });
  assert.throws(() => run(leftover), (error) => error instanceof CheckFailed && /not what it was before the rehearsal/.test(error.message) && /CHANGED tables public\.patients/.test(error.details.join()));
  assert.throws(() => run(fakeCli(t, { schema: answer() }), []), PreconditionError);
});

test("expected diff: explained exactly, drift in production, something unexplained in staging, other files", (t) => {
  const made = project(t); const pending = releaseMigrations(made.root, "h2-9");
  const base = capture(answer(), { label: "base" }), expected = capture(migrated(), { label: "expected", rehearsed: [{ file: pending[0].file, sha256: pending[0].sha256 }] });
  const staging = capture(migrated()), production = capture(answer(), { environment: "production", label: "production" });
  let seen = explainExpected({ base, expected, staging, production, pending });
  assert.equal(seen.ok, true, seen.problems.join()); assert.deepEqual(seen.explained.map((item) => `${item.change} ${item.id}`), ["CHANGED public.patients"]); assert.deepEqual(seen.drift, []); assert.deepEqual(seen.unexplained, []);
  // Production also changed something by hand: the release is expected, but that is drift.
  const touched = answer(); of(touched, "functions", "private.is_member(p_workspace uuid)").security_definer = false;
  seen = explainExpected({ base, expected, staging, production: capture(touched, { environment: "production", label: "production" }), pending });
  assert.equal(seen.ok, false); assert.deepEqual(seen.drift.map((item) => `${item.change} ${item.id} [${item.parts}]`), ["CHANGED private.is_member(p_workspace uuid) [security_definer]"]);
  // Staging has an object the migrations did not create.
  const extra = migrated(); extra.tables.push({ ...copy(extra.tables[1]), id: "public.scratch_table" });
  seen = explainExpected({ base, expected, staging: capture(extra), production, pending });
  assert.equal(seen.ok, false); assert.deepEqual(seen.unexplained.map((item) => `${item.change} ${item.id}`), ["ADDED public.scratch_table"]); assert.deepEqual(seen.drift, []);
  // The migration file is not the one that was rehearsed.
  seen = explainExpected({ base, expected, staging, production, pending: [{ ...pending[0], sha256: "b".repeat(64) }] });
  assert.equal(seen.ok, false); assert.match(seen.problems.join(), /not the files that were rehearsed/);
  // Production is missing a migration that is not part of the release.
  const behind = answer(); behind.applied_migrations = ["20261017090000"];
  seen = explainExpected({ base, expected, staging, production: capture(behind, { environment: "production", label: "production" }), pending });
  assert.equal(seen.ok, false); assert.match(seen.problems.join(), /the migrations pending for production \(20261018090000, 20261020090000\) are not exactly those of the release \(20261020090000\)/);
  seen = explainExpected({ base, expected, staging: capture(answer(), { environment: "production" }), production, pending }); assert.match(seen.problems.join(), /the staging capture is of production/);
});

async function invoke(t, argv, { cli, made = project(t), environment } = {}) {
  let output = "";
  const code = await main(argv, { root: made.root, environment: environment ?? cli.environment, home: made.home, write: (text) => { output += text; }, supabase: cli.supabase, git: made.git });
  return { code, output, cli, made };
}
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";

test("command: capture staging and production and compare them exactly", async (t) => {
  const made = project(t);
  const staging = await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "staging"], { made, cli: fakeCli(t, { schema: answer() }) });
  assert.equal(staging.code, EXIT.PASS, staging.output); assert.match(staging.output, /^ {5}2 {2}schemas\n {5}2 {2}tables\n/);
  assert.match(sectionOf(staging.output, "DRIFT"), /^DRIFT\nINFO\n- staging: schema of staging captured, 17 object\(s\)/); assert.match(sectionOf(staging.output, "TARGET"), /read-only transaction/);
  const file = join(made.home, "Bellis-Releases", "h2-9", "schema-staging.json"); assert.ok(existsSync(file)); assertClean(readFileSync(file, "utf8"));
  const production = await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "production"], { made, cli: fakeCli(t, { schema: answer(), linked: refs.production }) });
  assert.equal(production.code, EXIT.PASS, production.output); assert.match(sectionOf(production.output, "CLI FINAL TARGET"), /^CLI FINAL TARGET\nINFO\n- PROD \(left as it was found\)/);
  assert.equal(production.cli.linkedFile(), refs.production); assert.equal(production.cli.calls().some((call) => call.startsWith("link")), false);
  const same = await invoke(t, ["drift", "--release", "h2-9", "--compare", "staging", "production"], { made, cli: fakeCli(t) });
  assert.equal(same.code, EXIT.PASS, same.output); assert.match(sectionOf(same.output, "DRIFT"), /^DRIFT\nPASS\n- EXACT MATCH: 17 object\(s\), no difference\n- first: staging \(staging, /);
  assert.deepEqual(same.cli.calls(), [], "comparing reads two files");
  assert.deepEqual(readdirSync(made.root).sort(), ["releases", "supabase"], "nothing was written in the repository");
});

test("command: drift is exit 1 with category, object and change; --verbose shows both sides redacted", async (t) => {
  const made = project(t); const changed = answer();
  of(changed, "functions", "private.notify_partner()").body = of(changed, "functions", "private.notify_partner()").body.replace(jwt, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ5In0.b3RoZXJzaWdu");
  of(changed, "cron", "bellis-plan-expirations").schedule = "*/20 * * * *"; changed.tables.pop();
  await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "staging"], { made, cli: fakeCli(t, { schema: answer() }) });
  await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "production"], { made, cli: fakeCli(t, { schema: changed, linked: refs.production }) });
  const out = await invoke(t, ["drift", "--release", "h2-9", "--compare", "staging", "production"], { made, cli: fakeCli(t) });
  assert.equal(out.code, EXIT.CHECK_FAILED);
  assert.match(out.output, /^REMOVED {2}tables {2}public\.workspaces \(only in staging\)\nCHANGED {2}functions {2}private\.notify_partner\(\) \(body\)\nCHANGED {2}cron {2}bellis-plan-expirations \(schedule\)\n/);
  assert.match(sectionOf(out.output, "DRIFT"), /^DRIFT\nFAIL\n- DRIFT: 3 difference\(s\)/); assert.doesNotMatch(out.output, /perform net\.http_post/, "no body by default"); assertClean(out.output);
  const verbose = await invoke(t, ["drift", "--release", "h2-9", "--compare", "staging", "production", "--verbose"], { made, cli: fakeCli(t) });
  assert.match(verbose.output, / {4}schedule in staging: 20 \* \* \* \*\n {4}schedule in production: \*\/20 \* \* \* \*/); assert.match(verbose.output, /body in staging: begin perform net\.http_post/); assertClean(verbose.output);
  const ndjson = await invoke(t, ["drift", "--release", "h2-9", "--compare", "staging", "production", "--ndjson"], { made, cli: fakeCli(t) });
  const events = ndjson.output.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["difference", "difference", "difference", "compare", "report"]);
  assert.deepEqual(events[1], { type: "difference", category: "functions", object: "private.notify_partner()", change: "CHANGED", parts: ["body"] }); assert.equal(events.at(-1).exitCode, EXIT.CHECK_FAILED); assertClean(ndjson.output);
});

test("command: rehearse, then expected: the difference is exactly the release", async (t) => {
  const made = project(t);
  const rehearsed = await invoke(t, ["drift", "--rehearse", "--release", "h2-9"], { made, cli: fakeCli(t, { schema: answer(), schemaRehearsed: migrated() }) });
  assert.equal(rehearsed.code, EXIT.PASS, rehearsed.output); assert.match(rehearsed.output, /^CHANGED {2}tables {2}public\.patients \(columns\)\n/);
  assert.match(sectionOf(rehearsed.output, "DRIFT"), /rehearsed on staging: the release changes 1 object\(s\)/); assert.match(sectionOf(rehearsed.output, "MIGRATIONS"), /of the release: 20261020090000_add_notes_flag\.sql \(sha256 [0-9a-f]{12}, matches the manifest\)/);
  const again = await invoke(t, ["drift", "--rehearse", "--release", "h2-9"], { made, cli: fakeCli(t, { schema: answer() }) }); assert.equal(again.code, EXIT.PRECONDITION_OR_USAGE);
  await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "staging"], { made, cli: fakeCli(t, { schema: migrated() }) });
  await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "production"], { made, cli: fakeCli(t, { schema: answer(), linked: refs.production }) });
  const exact = await invoke(t, ["drift", "--release", "h2-9", "--compare", "staging", "production"], { made, cli: fakeCli(t) });
  assert.equal(exact.code, EXIT.CHECK_FAILED, "an exact comparison sees the release as a difference");
  const explained = await invoke(t, ["drift", "--expected", "--release", "h2-9"], { made, cli: fakeCli(t) });
  assert.equal(explained.code, EXIT.PASS, explained.output); assert.match(explained.output, /^EXPLAINED {4}CHANGED {2}tables {2}public\.patients \(columns\)\n/);
  assert.match(sectionOf(explained.output, "DRIFT"), /^DRIFT\nPASS\n- EXPLAINED: the 1 difference\(s\) between staging and production are exactly what the release's migrations do/); assert.deepEqual(explained.cli.calls(), []);
  // Someone changes production by hand: the same release no longer explains everything.
  const touched = answer(); of(touched, "policies", "public.patients.patients_member_read").using = "true";
  await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "production", "--replace"], { made, cli: fakeCli(t, { schema: touched, linked: refs.production }) });
  const drifted = await invoke(t, ["drift", "--expected", "--release", "h2-9"], { made, cli: fakeCli(t) });
  assert.equal(drifted.code, EXIT.CHECK_FAILED); assert.match(drifted.output, /DRIFT {8}CHANGED {2}policies {2}public\.patients\.patients_member_read \(using\)/);
  assert.match(sectionOf(drifted.output, "DRIFT"), /NOT EXPLAINED BY THE RELEASE[\s\S]*drift in production \(differs from what the release was rehearsed on\): 1/);
});

test("command: expected without a rehearsal asks for a person; a changed file is caught", async (t) => {
  const made = project(t);
  const missing = await invoke(t, ["drift", "--expected", "--release", "h2-9"], { made, cli: fakeCli(t) });
  assert.equal(missing.code, EXIT.HUMAN_ACTION_REQUIRED); assert.match(missing.output, /was not rehearsed/);
  await invoke(t, ["drift", "--rehearse", "--release", "h2-9"], { made, cli: fakeCli(t, { schema: answer(), schemaRehearsed: migrated() }) });
  writeFileSync(join(made.root, "supabase", "migrations", "20261020090000_add_notes_flag.sql"), "alter table public.patients add column flagged boolean;\n");
  const changed = await invoke(t, ["drift", "--expected", "--release", "h2-9"], { made, cli: fakeCli(t) });
  assert.equal(changed.code, EXIT.CHECK_FAILED); assert.match(changed.output, /is not the file release h2-9 was prepared with \(the hash differs\)/);
  const unsafe = project(t, { "20261020090000_index.sql": "create index concurrently i on public.patients(id);\n" });
  const refused = await invoke(t, ["drift", "--rehearse", "--release", "h2-9"], { made: unsafe, cli: fakeCli(t, { schema: answer() }) });
  assert.equal(refused.code, EXIT.HUMAN_ACTION_REQUIRED); assert.match(refused.output, /cannot be rehearsed safely/); assert.deepEqual(refused.cli.calls(), []);
});

test("command: a target in doubt is exit 3, arguments that make no sense are exit 2, and state stays outside the repository", async (t) => {
  const ambiguous = await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "production"], { cli: fakeCli(t, { schema: answer(), linked: refs.production, marks: "both" }) });
  assert.equal(ambiguous.code, EXIT.TARGET_NOT_CONFIRMED); assert.equal(ambiguous.cli.state().queries, undefined);
  const elsewhere = await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "production"], { cli: fakeCli(t, { schema: answer() }) });
  assert.equal(elsewhere.code, EXIT.TARGET_NOT_CONFIRMED); assert.equal(elsewhere.cli.linkedFile(), refs.staging);
  const rehearseOnProduction = await invoke(t, ["drift", "--rehearse", "--release", "h2-9"], { cli: fakeCli(t, { schema: answer(), linked: refs.production }) });
  assert.equal(rehearseOnProduction.code, EXIT.TARGET_NOT_CONFIRMED); assert.equal(rehearseOnProduction.cli.state().queries, undefined);
  for (const argv of [["drift"], ["drift", "--capture"], ["drift", "--capture", "--release", "h2-9"], ["drift", "--capture", "--release", "h2-9", "--env", "prod"], ["drift", "--capture", "--compare", "a", "b", "--release", "h2-9"],
    ["drift", "--release", "h2-9", "--compare", "a"], ["drift", "--release", "h2-9", "--compare", "staging", "production"], ["drift", "--capture", "--release", "h2-9", "--env", "staging", "--label", "base"], ["drift", "--expected"], ["drift", "--rehearse", "--release", "nope"]]) {
    const out = await invoke(t, argv, { cli: fakeCli(t, { schema: answer() }) }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE, argv.join(" ")); assert.equal(out.cli.state().queries, undefined, argv.join(" "));
  }
  const made = project(t); const cli = fakeCli(t, { schema: answer() });
  const inside = await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "staging"], { made, cli, environment: { ...cli.environment, BELLIS_RELEASES_DIR: join(made.root, "state") } });
  assert.equal(inside.code, EXIT.PRECONDITION_OR_USAGE); assert.match(inside.output, /cannot be inside the repository/);
  const twice = project(t); await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "staging"], { made: twice, cli: fakeCli(t, { schema: answer() }) });
  assert.equal((await invoke(t, ["drift", "--capture", "--release", "h2-9", "--env", "staging"], { made: twice, cli: fakeCli(t, { schema: answer() }) })).code, EXIT.PRECONDITION_OR_USAGE);
});
