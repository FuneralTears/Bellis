#!/usr/bin/env node
/**
 * A stand-in for the Supabase CLI, for the tests of the release tooling. It never opens a connection: its whole
 * world is a JSON file (FAKE_SUPABASE_STATE) that says which project is linked and how it should misbehave.
 * It deliberately prints things a real tool might print and that must never reach a report: a connection string
 * with a password on failures, and extra fields with credentials in the list of projects.
 *
 *   link --project-ref <ref>     projects list     --version
 *
 * State: { workdir, linked, projects: [{ ref, name }], failLink: [ref], failProjects, marks: "linked"|"none"|"both"|<ref>,
 *          linkLands: { <asked ref>: <ref it ends on> }, noJson, log: [] }
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = process.env.FAKE_SUPABASE_STATE;
if (!file) { process.stderr.write("FAKE_SUPABASE_STATE is not set\n"); process.exit(64); }
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const leak = "failed to connect to postgres://postgres:hunter2-secret@db.example.supabase.co:5432/postgres token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
state.log = [...(state.log ?? []), args.join(" ")];

if (args[0] === "--version") { save(); process.stdout.write("2.120.0\n"); process.exit(0); }
if (args[0] === "link" && args[1] === "--project-ref") {
  const ref = args[2];
  if ((state.failLink ?? []).includes(ref)) { save(); process.stderr.write(`Initialising login role...\n${leak}\n`); process.exit(1); }
  state.linked = state.linkLands?.[ref] ?? ref;
  mkdirSync(join(state.workdir, "supabase", ".temp"), { recursive: true });
  writeFileSync(join(state.workdir, "supabase", ".temp", "project-ref"), state.linked);
  save(); process.stdout.write(JSON.stringify({ project_ref: ref, message: "", db_password: "hunter2-secret" }) + "\n"); process.exit(0);
}
if (args[0] === "projects" && args[1] === "list") {
  save();
  if (state.failProjects) { process.stderr.write(`${leak}\n`); process.exit(1); }
  if (state.noJson) { process.stdout.write("LINKED | ORG | REFERENCE ID | NAME\n"); process.exit(0); }
  const marks = state.marks ?? "linked";
  // A person's terminal without --output-format json (or a CLI that ignores it): the real table, byte for byte.
  if (state.projectsTable !== undefined || (!args.includes("--output-format") && state.tableWithoutFlag)) {
    const isLinked = (item) => (marks === "both" ? true : marks === "none" ? false : marks === "linked" ? item.ref === state.linked : item.ref === marks);
    const rows = (state.projects ?? []).map((item) => `   ${isLinked(item) ? "●" : " "}    | hlpnaohuceifooypgdll | ${item.ref} | ${item.name.padEnd(14)} | ${item.region ?? "East US (North Virginia)"}  | 2026-10-04 04:12:54`);
    process.stdout.write(state.projectsTable ?? ["", "  ", "LINKED | ORG ID               | REFERENCE ID         | NAME           | REGION                    | CREATED AT (UTC)", "--------|----------------------|----------------------|----------------|---------------------------|---------------------", ...rows, ""].join("\r\n"));
    process.exit(0);
  }
  const projects = (state.projects ?? []).map((item) => ({ id: item.ref, ref: item.ref, name: item.name, status: "ACTIVE_HEALTHY", organization_id: "org",
    linked: marks === "both" ? true : marks === "none" ? false : marks === "linked" ? item.ref === state.linked : item.ref === marks,
    database: { host: "db.example.supabase.co", password: "hunter2-secret" }, service_role_key: "sb_secret_never_show_this" }));
  process.stderr.write("Initialising login role...\n");
  process.stdout.write(JSON.stringify({ projects }) + "\n"); process.exit(0);
}
/*
 * db query --linked --output-format json -f <file>: what the smoke runner uses. Nothing is executed: the fake reads
 * the file, keeps it in state.queries, and answers the way state.behaviour[<smoke id>] says ("pass" by default).
 * The smoke id and the run's value are read from the result row the runner writes. state.txStatus[<smoke id>] is
 * what txid_status answers for that smoke's transaction ("aborted" by default).
 */
/*
 * db push --linked (--dry-run | --yes). What would be applied is state.pushable (plus state.dryRunExtra on a dry
 * run). Applying adds their versions to state.applied (unless state.pushNoHistory), records where it happened in
 * state.pushedOn, and from then on state.dbAfterPush / state.schemaAfterPush describe the database.
 * state.moveOnDryRun moves the link to that ref during the dry run; state.pushFails makes the apply fail.
 */
if (args[0] === "db" && args[1] === "push") {
  const dry = args.includes("--dry-run"); state.log[state.log.length - 1] = dry ? "db push --dry-run" : "db push --yes";
  if (!dry && state.pushFails) { save(); process.stderr.write(`Applying migration...\n${leak}\n`); process.exit(1); }
  // Per project when given (state.pushableByRef, state.dbAfterDryRun changes that project's data during a dry run).
  const listed = [...(state.pushableByRef?.[state.linked] ?? state.pushable ?? []), ...(dry ? state.dryRunExtra ?? [] : [])];
  if (dry && state.dbAfterDryRun) state.dbByRef = { ...(state.dbByRef ?? {}), [state.linked]: state.dbAfterDryRun };
  if (dry && state.moveOnDryRun) { state.linked = state.moveOnDryRun; writeFileSync(join(state.workdir, "supabase", ".temp", "project-ref"), state.linked); }
  if (!dry) {
    state.pushedOn = state.linked; state.pushes = (state.pushes ?? 0) + 1; state.pushed = true; state.pushLog = [...(state.pushLog ?? []), state.linked];
    // A project with its own history (state.appliedByRef) is the one that changes; otherwise the shared one.
    const versions = listed.map((file) => file.slice(0, 14)); const byRef = state.appliedByRef?.[state.linked];
    if (!state.pushNoHistory) { if (byRef) state.appliedByRef = { ...state.appliedByRef, [state.linked]: [...byRef, ...versions].sort() }; else state.applied = [...(state.applied ?? []), ...versions].sort(); }
    if (state.pushableByRef?.[state.linked]) state.pushableByRef = { ...state.pushableByRef, [state.linked]: [] };
    if (state.schemaAfterPushByRef?.[state.linked]) state.schemaByRef = { ...(state.schemaByRef ?? {}), [state.linked]: state.schemaAfterPushByRef[state.linked] };
    if (state.dbAfterPushByRef?.[state.linked]) state.dbByRef = { ...(state.dbByRef ?? {}), [state.linked]: state.dbAfterPushByRef[state.linked] };
    if (!state.pushableByRef?.[state.linked]) state.pushable = []; if (state.dbAfterPush && !state.dbAfterPushByRef?.[state.linked]) state.db = state.dbAfterPush;
  }
  save(); process.stderr.write("Initialising login role...\n");
  process.stdout.write(JSON.stringify({ upToDate: listed.length === 0, dryRun: dry, migrations: listed, seeds: [], roles: [] }) + "\n"); process.exit(0);
}
if (args[0] === "db" && args[1] === "query") {
  const sql = readFileSync(args[args.indexOf("-f") + 1], "utf8");
  state.log[state.log.length - 1] = "db query"; state.queries = [...(state.queries ?? []), sql];
  const answer = (rows, code = 0) => { save(); process.stderr.write("Initialising login role...\n"); process.stdout.write(JSON.stringify({ boundary: "b0", rows, warning: "untrusted data" }, null, 2) + "\n"); process.exit(code); };
  const sqlError = (text) => { save(); process.stderr.write("Initialising login role...\n"); process.stdout.write(JSON.stringify({ _tag: "Error", error: { code: "DbQueryUnexpectedStatusError", message: `unexpected status 400: ${JSON.stringify({ message: `Failed to run sql query: ERROR:  P0001: ${text}\nCONTEXT:  PL/pgSQL function inline_code_block line 1 at RAISE\n` })}` } }) + "\n"); process.exit(1); };
  if (sql.includes("txid_status(")) {
    if (state.failStatusQuery) sqlError("could not check");
    const txids = [...sql.matchAll(/'(\d+)'/g)].map((match) => match[1]);
    answer(txids.map((txid) => ({ txid, status: state.txStatus?.[state.txOf?.[txid]] ?? "aborted", password: "hunter2-secret" })));
  }
  /*
   * A data snapshot. The fake's database is state.db: { "<schema.table>": { columns, primaryKey, rows } }, and it
   * answers for the tables of state.snapshotConfig with the model fingerprint of those rows. state.snapshot makes
   * it misbehave: "pii" adds a row to the answer, "null-fingerprint", "self-test-broken", "garbage".
   */
  if (sql.includes("Bellis data snapshot")) {
    const { fingerprintRows } = await import("../../scripts/release/snapshot/build-sql.mjs");
    const config = state.snapshotConfig; const db = state.dbByRef?.[state.linked] ?? state.db ?? {}; const mode = state.snapshot ?? "ok";
    if (mode === "garbage") { save(); process.stdout.write("not json at all\n"); process.exit(0); }
    if (mode === "leak-error") sqlError(`${leak} password=hunter2`);
    const tables = [];
    for (const entry of config.tables) {
      const table = db[entry.table];
      if (!table) { save(); process.stderr.write("Initialising login role...\n"); process.stdout.write(JSON.stringify({ _tag: "Error", error: { code: "DbQueryUnexpectedStatusError", message: `unexpected status 400: ${JSON.stringify({ message: `Failed to run sql query: ERROR:  42P01: relation "${entry.table}" does not exist\nLINE 9: from ${entry.table}\n` })}` } }) + "\n"); process.exit(1); }
      if (entry.mode === "count") { tables.push({ table: entry.table, count: table.rows.length }); continue; }
      const keys = table.rows.map((item) => JSON.stringify(entry.key.map((column) => item[column] ?? null)));
      tables.push({ table: entry.table, count: table.rows.length, fingerprint: mode === "null-fingerprint" ? null : fingerprintRows(table.rows, { exclude: (entry.exclude ?? []).map((item) => item.column) }),
        key_nulls: table.rows.filter((item) => entry.key.some((column) => item[column] === null || item[column] === undefined)).length, key_distinct: new Set(keys).size,
        columns: table.columns, primary_key: table.primaryKey ?? [], ...(mode === "pii" ? { sample: table.rows[0] ?? { email: "ana@example.com" } } : {}) });
    }
    const listed = [...config.tables.map((entry) => entry.table), ...(config.ignored ?? []).map((item) => item.table)];
    const base = fingerprintRows([{ id: 1, label: "a", seen: "x" }, { id: 2, label: "b", seen: "y" }], { exclude: ["seen"] });
    const answerRow = { database_time: "2026-10-13T12:00:00Z", tables, uncovered: Object.keys(db).filter((name) => !listed.includes(name) && config.schemas.includes(name.split(".")[0])).sort(),
      self_test: { base, reordered: mode === "self-test-broken" ? "0".repeat(64) : base, changed: fingerprintRows([{ id: 1, label: "a" }, { id: 2, label: "B" }]), excluded_changed: base } };
    answer([{ snapshot: answerRow, service_role_key: "sb_secret_never_show_this" }]);
  }
  /*
   * A schema capture. state.schema is what the catalogs say (the answer of scripts/release/drift/schema.sql);
   * state.schemaRehearsed is what they say inside a rehearsal, after the pending migrations; state.schemaLater, if
   * set, is what every capture after a rehearsal sees (a rehearsal that left something behind).
   * state.schemaMode: "garbage", "leak-error".
   */
  if (sql.includes("Bellis migration history")) answer([{ versions: state.appliedByRef?.[state.linked] ?? state.applied ?? [] }]);
  if (sql.includes("Bellis residue check")) answer([{ residue: state.residueByRef?.[state.linked] ?? state.residue ?? { users_example_invalid: 0, users_with_smoke_ids: 0, workspaces_with_smoke_ids: 0, workspaces_with_smoke_slugs: 0 } }]);
  if (!state.schemaMode && sql.includes("Bellis schema capture") && !sql.includes("-- pending migration:") && state.schemaByRef?.[state.linked]) answer([{ schema: state.schemaByRef[state.linked] }]);
  if (!state.schemaMode && sql.includes("Bellis schema capture") && !sql.includes("-- pending migration:") && state.pushed && state.schemaAfterPush) answer([{ schema: state.schemaAfterPush }]);
  if (sql.includes("Bellis schema capture")) {
    if (state.schemaMode === "garbage") { save(); process.stdout.write("not json at all\n"); process.exit(0); }
    if (state.schemaMode === "leak-error") sqlError(`${leak} password=hunter2`);
    const rehearsal = sql.includes("-- pending migration:");
    if (rehearsal) { const txid = String((state.txCounter = (state.txCounter ?? 1000) + 1)); state.txOf = { ...(state.txOf ?? {}), [txid]: "rehearsal" }; state.rehearsed = true; answer([{ schema: state.schemaRehearsed ?? state.schema, txid, db_password: "hunter2-secret" }]); }
    answer([{ schema: state.rehearsed && state.schemaLater ? state.schemaLater : state.schema, db_password: "hunter2-secret" }]);
  }
  const row = /select 'bellis_smoke_v1' as contract, '([a-z0-9_]+)' as smoke, 'PASS' as result, '([0-9a-f]+)' as nonce/.exec(sql);
  const id = row?.[1] ?? "unknown"; const nonce = row?.[2] ?? "";
  const behaviour = state.behaviourOnRef?.[state.linked]?.[id] ?? (state.pushed ? state.behaviourAfterPush?.[id] : undefined) ?? state.behaviour?.[id] ?? (sql.includes("bellis_smoke_selftest_expected_failure") ? "selftest-error" : "pass");
  const txid = String((state.txCounter = (state.txCounter ?? 1000) + 1)); state.txOf = { ...(state.txOf ?? {}), [txid]: id };
  const pass = { contract: "bellis_smoke_v1", smoke: id, result: "PASS", nonce, txid, service_role_key: "sb_secret_never_show_this" };
  if (behaviour === "pass") answer([pass]);
  if (behaviour === "selftest-error") sqlError("bellis_smoke_selftest_expected_failure");
  if (behaviour === "error") sqlError("smoke_assertion_failed");
  if (behaviour === "leak-error") sqlError(`${leak} password=hunter2`);
  if (behaviour === "exit1") { save(); process.stderr.write(`${leak}\n`); process.exit(1); }
  if (behaviour === "exit3-with-row") answer([pass], 3);
  if (behaviour === "no-row") answer([]);
  if (behaviour === "other-row") answer([{ manual_appointments: 4 }]);
  if (behaviour === "two-rows") answer([pass, pass]);
  if (behaviour === "fail-result") answer([{ ...pass, result: "FAIL" }]);
  if (behaviour === "wrong-nonce") answer([{ ...pass, nonce: "0".repeat(32) }]);
  if (behaviour === "wrong-smoke") answer([{ ...pass, smoke: "another_smoke" }]);
  if (behaviour === "no-txid") answer([{ ...pass, txid: null }]);
  if (behaviour === "garbage") { save(); process.stdout.write("not json at all\n"); process.exit(0); }
  save(); process.stderr.write(`unknown behaviour: ${behaviour}\n`); process.exit(64);
}
save(); process.stderr.write(`unknown command: ${args.join(" ")}\n`); process.exit(2);
