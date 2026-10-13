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
  const row = /select 'bellis_smoke_v1' as contract, '([a-z0-9_]+)' as smoke, 'PASS' as result, '([0-9a-f]+)' as nonce/.exec(sql);
  const id = row?.[1] ?? "unknown"; const nonce = row?.[2] ?? "";
  const behaviour = state.behaviour?.[id] ?? (sql.includes("bellis_smoke_selftest_expected_failure") ? "selftest-error" : "pass");
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
