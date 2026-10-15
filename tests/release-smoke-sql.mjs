/**
 * The static side of the smoke runner: reading SQL, the manifest, and the migrations that can run before a smoke.
 * Nothing here runs SQL or reaches Supabase.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CheckFailed, PreconditionError } from "../scripts/release/lib/report.mjs";
import { loadManifest, manifestProblems, selectSmokes } from "../scripts/release/smoke/manifest.mjs";
import { resolvePending, sqlHash } from "../scripts/release/smoke/runner.mjs";
import { composeSmokeSql, statements, tokenize, transactionControl, validateMigrationSql, validateSmokeSql } from "../scripts/release/smoke/sql.mjs";
import { scratch } from "./fixtures/release-harness.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const accepted = (sql, options) => assert.deepEqual(validateSmokeSql(sql, options).problems, []);
const refused = (sql, pattern, options) => { const seen = validateSmokeSql(sql, options); assert.equal(seen.ok, false, sql); assert.match(seen.problems.join(" | "), pattern); };

test("tokenizer: comments disappear, strings and dollar bodies are one token each", () => {
  const tokens = tokenize("select 'a;b' , $$ c; d $$ -- e; f\n/* g; /* nested; */ h */ from \"T;x\" where x = $1;");
  assert.deepEqual(tokens.map((token) => token.type === "punct" || token.type === "word" ? token.value : token.type),
    ["select", "string", ",", "dollar", "from", "identifier", "where", "x", "=", "$", "number", ";"]);
  assert.equal(tokens.find((token) => token.type === "dollar").body, " c; d ");
  assert.equal(statements("select 1; select 'x;y'; do $f$ begin commit; end $f$;").length, 3);
  assert.equal(statements("select 1").length, 1); assert.equal(statements(" -- nothing\n/* at all */ ;; ").length, 0);
  assert.deepEqual(tokenize("SELECT Foo").map((token) => token.value), ["select", "foo"]);
});

test("tokenizer: quotes inside quotes, escape strings and tagged dollar quotes", () => {
  assert.equal(statements("select 'it''s; fine'; select 2;").length, 2);
  assert.equal(statements("select E'a\\'; commit; b'; select 2;").length, 2, "a backslash escapes the quote in an E string");
  assert.equal(statements("select 'a\\'; select 2;").length, 2, "and does not in a plain string");
  assert.equal(statements('select "a""; commit; b"; select 2;').length, 2);
  assert.equal(statements("do $body$ begin perform $$ commit; $$; end $body$; select 2;").length, 2, "a dollar body ends only at its own tag");
  assert.equal(statements("select a$b, $1, $2; select 2;").length, 2, "a $ inside a name or a parameter opens nothing");
  assert.equal(statements("\ufeffbegin; rollback;").length, 2, "a byte order mark is not SQL");
});

test("tokenizer: anything left open is an error, never a guess", () => {
  for (const sql of ["select 'abc", "select $$ abc", "select $a$ abc $b$", "/* abc", 'select "abc', "select E'abc\\'"]) {
    assert.throws(() => tokenize(sql), /never closed/, sql);
    refused(`begin; ${sql}`, /cannot be read/);
  }
});

test("what counts as transaction control", () => {
  const kind = (sql) => transactionControl(statements(sql)[0]);
  for (const sql of ["begin", "BEGIN", "begin transaction", "Begin Work", "start transaction", "begin isolation level serializable"]) assert.equal(kind(sql), "begin", sql);
  for (const sql of ["commit", "COMMIT work", "end", "end transaction", "commit and chain", "prepare transaction 'x'", "commit prepared 'x'"]) assert.equal(kind(sql), "commit", sql);
  for (const sql of ["rollback", "ROLLBACK", "rollback transaction", "rollback work", "abort"]) assert.equal(kind(sql), "rollback", sql);
  for (const sql of ["rollback to savepoint a", "rollback to a", "rollback and chain", "rollback prepared 'x'", "savepoint a", "release savepoint a", "release a"]) assert.equal(kind(sql), "other", sql);
  for (const sql of ["select 1", "start_job()", "select commit from t", "update t set rollback = 1", "do $$ begin commit; end $$", "prepare plan as select 1", "comment on table t is 'commit'"]) assert.equal(kind(sql), null, sql);
});

test("a smoke that is one transaction, undone, is accepted", () => {
  accepted("begin;\nselect 1;\nrollback;\n"); accepted("-- note\n/* more */\nBEGIN;\nselect 1;\nROLLBACK;\n-- the end\n"); accepted("begin; rollback"); accepted("start transaction;\nselect 1;\nrollback transaction;");
  const seen = validateSmokeSql("-- top\nbegin;\nselect 1;\nselect 2;\nrollback;\n");
  assert.equal(seen.head, "-- top\nbegin;"); assert.equal(seen.body, "\nselect 1;\nselect 2;\n");
});

test("BEGIN: missing, doubled or not first", () => {
  refused("select 1;\nrollback;", /has no BEGIN/);
  refused("begin;\nselect 1;\nbegin;\nrollback;", /has 2 BEGIN statements \(line 1, line 3\)/);
  refused("begin;\nstart transaction;\nrollback;", /has 2 BEGIN statements/);
  refused("select 1;\nbegin;\nrollback;", /does not start with BEGIN/);
  refused("", /is empty/); refused("-- only a comment\n", /is empty/);
});

test("COMMIT: a real one is refused, in any spelling", () => {
  for (const sql of ["begin;\nselect 1;\ncommit;\n", "begin;\nselect 1;\nCOMMIT;\nrollback;", "begin; select 1; end; rollback;", "begin;\nselect 1;\ncommit work;\nrollback;", "begin;select 1;commit;rollback;",
    "begin;\nselect 1; /* hidden */ commit /* here */ ;\nrollback;", "begin;\nprepare transaction 'x';\nrollback;", "begin;\nselect 1;\ncommit and chain;\nrollback;"]) refused(sql, /has a COMMIT/);
  refused("begin;\nselect 1;\n  commit;\nrollback;", /has a COMMIT \(line 3\)/);
});

test("COMMIT: the word in a comment, a string or a dollar body is only text", () => {
  accepted("begin;\n-- commit;\nselect 1;\nrollback;");
  accepted("begin;\n/* commit;\n commit; */\nselect 1;\nrollback;");
  accepted("begin;\nselect 'commit;' as word, 'x'';commit;' as other;\nrollback;");
  accepted("begin;\ndo $$ begin\n  -- inside a transaction block PostgreSQL refuses this at run time\n  commit;\nend $$;\nrollback;");
  accepted("begin;\ncreate function pg_temp.f() returns void language plpgsql as $fn$ begin rollback; end $fn$;\nselect commit, \"commit\" from (select 1 as commit) t;\nrollback;");
  accepted("begin;\nselect 1; -- rollback; begin; commit;\nrollback;");
});

test("ROLLBACK: missing, not last, or not a plain one", () => {
  refused("begin;\nselect 1;\n", /does not end in ROLLBACK/);
  refused("begin;\nselect 1;\n-- rollback;\n", /does not end in ROLLBACK/);
  refused("begin;\nselect 'rollback;';\n", /does not end in ROLLBACK/);
  refused("begin;\nselect 1;\nrollback;\nselect 2;\n", /has a ROLLBACK before the end \(line 3\).*does not end in ROLLBACK/);
  refused("begin;\nrollback;\ninsert into t values (1);\nrollback;", /has a ROLLBACK before the end \(line 2\)/);
  refused("begin;\nsavepoint a;\nrollback to savepoint a;\nrollback;", /transaction control that is not supported/);
  refused("begin;\nselect 1;\nrollback and chain;", /not supported.*does not end in ROLLBACK/);
});

test("composing: BEGIN, pending migrations, the smoke, the result row, ROLLBACK, and it is still one transaction", () => {
  const smoke = validateSmokeSql("-- top\nbegin;\nselect 1;\n-- last comment without a statement\nrollback;\n");
  const row = "select 'row' as contract;";
  const plain = composeSmokeSql(smoke, { resultRow: row });
  assert.deepEqual(statements(plain).map((statement) => statement.tokens[0].value), ["begin", "select", "select", "rollback"]); accepted(plain);
  const pending = [{ file: "20270101000000_a.sql", text: "create table a(id int);\n-- trailing comment" }, { file: "20270102000000_b.sql", text: "alter table a add b int" }];
  const composed = composeSmokeSql(smoke, { pending, resultRow: row });
  assert.deepEqual(statements(composed).map((statement) => statement.tokens[0].value), ["begin", "create", "alter", "select", "select", "rollback"]); accepted(composed);
  assert.ok(composed.indexOf("create table a") < composed.indexOf("alter table a") && composed.indexOf("alter table a") < composed.indexOf("select 1") && composed.indexOf("select 1") < composed.indexOf(row));
  assert.match(composed, /select 'row' as contract;\nrollback;\n$/);
  assert.throws(() => composeSmokeSql(validateSmokeSql("select 1;"), { resultRow: row }), /validated/);
});

test("a migration that controls its own transaction cannot run inside a smoke", () => {
  assert.equal(validateMigrationSql("create table a(id int);\ncreate function f() returns void language plpgsql as $$ begin null; end $$;").ok, true);
  assert.equal(validateMigrationSql("-- commit;\nselect 'begin;';").ok, true);
  for (const sql of ["begin;\ncreate table a(id int);\ncommit;", "create table a(id int);\ncommit;", "create table a(id int);\nrollback;", "savepoint a;", "start transaction;"]) {
    const seen = validateMigrationSql(sql); assert.equal(seen.ok, false, sql); assert.match(seen.problems[0], /controls its own transaction/);
  }
  assert.equal(validateMigrationSql("").ok, false); assert.equal(validateMigrationSql("select 'open").ok, false);
});

test("the workspace clock: a smoke that asks for it cannot take the day from the server", () => {
  const checks = ["workspace-clock"];
  accepted("begin;\nselect (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1;\nrollback;", { checks });
  accepted("begin;\n-- not current_date\nselect 'current_date', now(), now() - interval '1 day';\nrollback;", { checks });
  refused("begin;\nselect current_date - 1;\nrollback;", /uses current_date/, { checks });
  refused("begin;\nselect CURRENT_DATE;\nrollback;", /uses current_date/, { checks });
  refused("begin;\ndo $$ begin perform 1 where current_date > '2020-01-01'; end $$;\nrollback;", /uses current_date/, { checks });
  refused("begin;\nselect now()::date;\nrollback;", /casts now to a date/, { checks });
  refused("begin;\nselect now( ) :: date - 1;\nrollback;", /casts now to a date/, { checks });
  refused("begin;\nselect current_timestamp::date, localtimestamp;\nrollback;", /casts current_timestamp to a date.*uses localtimestamp|uses localtimestamp.*casts current_timestamp/, { checks });
  accepted("begin;\nselect current_date;\nrollback;"); // only where the manifest asks for it
  refused("begin;\nrollback;", /unknown check: nope/, { checks: ["nope"] });
});

test("patient_crm_phase3 keeps taking 'today' from the workspace's time zone", () => {
  const manifest = loadManifest(repository); const entry = manifest.smokes.find((smoke) => smoke.id === "patient_crm_phase3");
  assert.deepEqual(entry.checks, ["workspace-clock"], "the guard is asked for in the manifest");
  const sql = readFileSync(join(repository, entry.file), "utf8");
  accepted(sql, { checks: entry.checks });
  assert.match(sql, /\(now\(\) at time zone \(select w\.timezone from public\.workspaces w where w\.id=w1\)\)::date-1/);
  // The mistake that was fixed once: going back to the server's day is refused before the smoke is ever sent.
  const regressed = sql.replace(/\(now\(\) at time zone \(select w\.timezone from public\.workspaces w where w\.id=w1\)\)::date-1/, "current_date-1");
  assert.notEqual(regressed, sql); refused(regressed, /uses current_date/, { checks: entry.checks });
});

test("the real manifest: valid, complete, and every smoke is a transaction that is undone", () => {
  const manifest = loadManifest(repository);
  const onDisk = readdirSync(join(repository, "supabase", "tests")).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(manifest.smokes.map((smoke) => smoke.file.split("/").at(-1)).sort(), onDisk);
  assert.deepEqual(Object.keys(manifest.groups), ["core", "crm", "plans", "admin", "calendar", "release"]);
  for (const smoke of manifest.smokes) { accepted(readFileSync(join(repository, smoke.file), "utf8"), { checks: smoke.checks ?? [] }); assert.equal(smoke.id, smoke.file.split("/").at(-1).replace(/_smoke\.sql$/, "")); assert.ok(smoke.groups.includes("release")); }
  assert.equal(selectSmokes(manifest, { groups: ["release"] }).length, manifest.smokes.length);
});

test("no smoke depends on the users that happen to exist", () => {
  const manifest = loadManifest(repository);
  for (const smoke of manifest.smokes) {
    const code = tokenize(readFileSync(join(repository, smoke.file), "utf8")).map((token) => (token.type === "dollar" ? token.body : token.value)).join(" ");
    assert.doesNotMatch(code, /from\s+auth\s*\.\s*users\s+order\s+by/i, `${smoke.id} picks an existing user`);
  }
  for (const [id, tag] of [["crm_phase4", "crm-phase4"], ["crm_phase5", "crm-phase5"], ["phase6_roles", "phase6-roles"]]) {
    const sql = readFileSync(join(repository, "supabase", "tests", `${id}_smoke.sql`), "utf8");
    assert.match(sql, /insert into auth\.users\(/); assert.ok(sql.includes(`'${tag}-' || n || '@example.invalid'`), id); assert.match(sql, /'f[0-9a-f]000000-0000-4000-8000-000000000001'::uuid u1/);
  }
});

const entry = (id, extra = {}) => ({ id, file: `supabase/tests/${id}_smoke.sql`, groups: ["core"], expect: { result: "PASS" }, ...extra });
const manifestOf = (smokes, extra = {}) => ({ version: 1, contract: { name: "bellis_smoke_v1", pass: "PASS" }, defaults: { timeoutSeconds: 120 }, groups: { core: "x", admin: "y" }, smokes, ...extra });

test("manifest: a valid one has no problems", () => {
  assert.deepEqual(manifestProblems(manifestOf([entry("a_one"), entry("b_two", { groups: ["admin", "core"], timeoutSeconds: 300, checks: ["workspace-clock"], requires: ["something"] })])), []);
});

test("manifest: duplicates, missing files, unknown groups and unlisted smokes are all errors", () => {
  const has = (manifest, pattern, options) => assert.match(manifestProblems(manifest, options).join(" | "), pattern);
  has(manifestOf([entry("a_one"), entry("a_one")]), /a_one: the id is listed twice.*a_one: supabase\/tests\/a_one_smoke\.sql is listed twice/);
  has(manifestOf([entry("a_one"), entry("b_two", { file: "supabase/tests/a_one_smoke.sql" }), entry("c", { groups: ["admin"] })]), /b_two: supabase\/tests\/a_one_smoke\.sql is listed twice/);
  has(manifestOf([entry("a_one"), entry("b_two", { groups: ["admin"] })]), /b_two: supabase\/tests\/b_two_smoke\.sql does not exist/, { exists: (file) => file.includes("a_one") });
  has(manifestOf([entry("a_one", { groups: ["nope"] })]), /a_one: unknown group nope/);
  has(manifestOf([entry("a_one", { groups: [] })]), /a_one: belongs to no group/);
  has(manifestOf([entry("a_one", { groups: ["core", "core"] })]), /a group is repeated/);
  has(manifestOf([entry("a_one")]), /group admin has no smokes/);
  has(manifestOf([entry("a_one", { groups: ["core", "admin"] })]), /supabase\/tests\/new_smoke\.sql is not in the manifest/, { files: ["supabase/tests/a_one_smoke.sql", "supabase/tests/new_smoke.sql"] });
  has(manifestOf([entry("a_one", { file: "../../etc/passwd" })]), /the file has to be supabase\/tests/);
  has(manifestOf([entry("a_one", { file: "supabase/tests/../migrations/x_smoke.sql" })]), /the file has to be supabase\/tests/);
  has(manifestOf([entry("A-One")]), /the id uses lowercase/);
  has(manifestOf([entry("a_one", { expect: undefined })]), /has to say what it expects/);
  has(manifestOf([entry("a_one", { expect: { result: "FAIL" } })]), /has to say what it expects/);
  has(manifestOf([entry("a_one", { timeoutSeconds: 0 })]), /timeout/); has(manifestOf([entry("a_one", { checks: ["nope"] })]), /unknown check nope/);
  has(manifestOf([entry("a_one")], { contract: undefined }), /result contract/); has(manifestOf([entry("a_one")], { defaults: {} }), /default timeout/);
  assert.deepEqual(manifestProblems({}), ["the manifest has no list of smokes"]); assert.deepEqual(manifestProblems(null), ["the manifest has no list of smokes"]);
});

test("manifest on disk: an invalid one stops the command with every problem listed", (t) => {
  const root = scratch(t); mkdirSync(join(root, "scripts", "release", "smoke"), { recursive: true }); mkdirSync(join(root, "supabase", "tests"), { recursive: true });
  assert.throws(() => loadManifest(root), PreconditionError);
  writeFileSync(join(root, "supabase", "tests", "a_one_smoke.sql"), "begin; rollback;"); writeFileSync(join(root, "supabase", "tests", "stray_smoke.sql"), "begin; rollback;");
  writeFileSync(join(root, "scripts", "release", "smoke", "manifest.json"), JSON.stringify(manifestOf([entry("a_one", { groups: ["core", "admin"] }), entry("gone", { groups: ["core"] })])));
  assert.throws(() => loadManifest(root), (error) => error instanceof CheckFailed && /gone: supabase\/tests\/gone_smoke\.sql does not exist/.test(error.details.join()) && /stray_smoke\.sql is not in the manifest/.test(error.details.join()));
});

test("selection: by group, by id, everything by default, and each smoke once", () => {
  const manifest = manifestOf([entry("a_one"), entry("b_two", { groups: ["admin", "core"] }), entry("c_three", { groups: ["admin"] })]);
  const ids = (options) => selectSmokes(manifest, options).map((smoke) => smoke.id);
  assert.deepEqual(ids(), ["a_one", "b_two", "c_three"]); assert.deepEqual(ids({ all: true }), ["a_one", "b_two", "c_three"]);
  assert.deepEqual(ids({ groups: ["core"] }), ["a_one", "b_two"]); assert.deepEqual(ids({ groups: ["admin"] }), ["b_two", "c_three"]);
  assert.deepEqual(ids({ groups: ["core", "admin"] }), ["a_one", "b_two", "c_three"], "b_two is in both groups and runs once");
  assert.deepEqual(ids({ groups: ["admin", "admin"], only: ["b_two"] }), ["b_two", "c_three"]);
  assert.deepEqual(ids({ only: ["c_three", "a_one"] }), ["a_one", "c_three"], "always in the order of the manifest");
  assert.throws(() => ids({ groups: ["nope"] }), PreconditionError); assert.throws(() => ids({ only: ["nope"] }), PreconditionError); assert.throws(() => ids({ all: true, groups: ["core"] }), PreconditionError);
});

function migrations(t, files) {
  const root = scratch(t); mkdirSync(join(root, "supabase", "migrations"), { recursive: true }); mkdirSync(join(root, "releases"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "supabase", "migrations", name), text);
  return root;
}

test("pending migrations: named one by one, by file name, from supabase/migrations only", (t) => {
  const root = migrations(t, { "20270102000000_b.sql": "alter table a add b int;", "20270101000000_a.sql": "create table a(id int);" });
  writeFileSync(join(root, "outside.sql"), "drop table x;"); writeFileSync(join(root, "supabase", "20270103000000_c.sql"), "drop table x;");
  const found = resolvePending(root, ["20270102000000_b.sql", "20270101000000_a.sql"]);
  assert.deepEqual(found.map((item) => [item.file, item.verified]), [["20270101000000_a.sql", false], ["20270102000000_b.sql", false]], "in order, whatever order they were given in");
  assert.equal(found[0].sha256, sqlHash("create table a(id int);")); assert.deepEqual(resolvePending(root, []), []);
  for (const name of ["../outside.sql", "..\\outside.sql", join(root, "outside.sql"), "supabase/migrations/20270101000000_a.sql", "../20270103000000_c.sql", "20270103000000_c.sql", "*.sql", "20270101000000_a", "", "20270101000000_a.sql/../../outside.sql", "C:\\x.sql", "/etc/passwd"])
    assert.throws(() => resolvePending(root, [name]), PreconditionError, name);
  assert.throws(() => resolvePending(root, ["20270101000000_a.sql", "20270101000000_a.sql"]), /listed twice/);
});

test("pending migrations: one with its own transaction control is refused", (t) => {
  const root = migrations(t, { "20270101000000_a.sql": "begin;\ncreate table a(id int);\ncommit;\n", "20270102000000_b.sql": "create table b(id int);\n-- commit; in a comment is fine\n", "20270103000000_c.sql": "create table c(id int);\nrollback;" });
  assert.throws(() => resolvePending(root, ["20270101000000_a.sql"]), (error) => error instanceof CheckFailed && /cannot run inside a smoke's transaction/.test(error.message) && /controls its own transaction \(BEGIN, line 1\)/.test(error.details.join()));
  assert.throws(() => resolvePending(root, ["20270103000000_c.sql"]), CheckFailed);
  assert.equal(resolvePending(root, ["20270102000000_b.sql"]).length, 1);
});

test("pending migrations: with a release manifest, the file has to be listed and be the same file", (t) => {
  const root = migrations(t, { "20270101000000_a.sql": "create table a(id int);\r\n", "20270102000000_b.sql": "create table b(id int);\n" });
  writeFileSync(join(root, "releases", "h2-9.json"), JSON.stringify({ id: "h2-9", migrations: [{ file: "20270101000000_a.sql", sha256: sqlHash("create table a(id int);\n") }] }));
  assert.deepEqual(resolvePending(root, ["20270101000000_a.sql"], { release: "h2-9" }).map((item) => item.verified), [true], "the hash does not depend on line endings");
  assert.throws(() => resolvePending(root, ["20270102000000_b.sql"], { release: "h2-9" }), (error) => error instanceof CheckFailed && /is not part of release h2-9/.test(error.message));
  writeFileSync(join(root, "supabase", "migrations", "20270101000000_a.sql"), "create table a(id int, extra int);\n");
  assert.throws(() => resolvePending(root, ["20270101000000_a.sql"], { release: "h2-9" }), (error) => error instanceof CheckFailed && /the hash differs/.test(error.message));
  assert.throws(() => resolvePending(root, ["20270101000000_a.sql"], { release: "nope" }), PreconditionError); assert.throws(() => resolvePending(root, ["20270101000000_a.sql"], { release: "../h2-9" }), PreconditionError);
  assert.throws(() => resolvePending(root, [], { release: "h2-9" }), PreconditionError);
});
