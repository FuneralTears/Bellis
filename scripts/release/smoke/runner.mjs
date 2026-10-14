/**
 * Release tooling: runs the SQL smokes of supabase/tests against the project the CLI is linked to.
 *
 * A smoke passes only when all of this is true:
 *   1. it was accepted before anything was sent: one BEGIN, no COMMIT, a final ROLLBACK (sql.mjs);
 *   2. the CLI ended with exit 0 and no SQL error;
 *   3. the answer is exactly one row, the one this run asked for: the runner writes it as the smoke's last
 *      statement inside its transaction, with the smoke's id and a value made up for this run, so reaching it
 *      means every statement before it succeeded and no other text can pass for it;
 *   4. that row says PASS;
 *   5. PostgreSQL itself says afterwards that the smoke's transaction was aborted (txid_status).
 *
 * Every run first proves the runner can still say no: a smoke with a COMMIT and one without a ROLLBACK have to be
 * refused without being sent, and a smoke that raises an error has to fail. If any of them gets through, nothing
 * else runs.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CheckFailed, PreconditionError, redact } from "../lib/report.mjs";
import { confirmTarget, environments } from "../lib/target.mjs";
import { composeSmokeSql, validateMigrationSql, validateSmokeSql } from "./sql.mjs";

export const contract = "bellis_smoke_v1";
const rowColumns = ["contract", "smoke", "result", "nonce", "txid"];
/** The error the failing self-test raises. Seeing it is how the runner knows the failure was the intended one. */
export const selfTestMarker = "bellis_smoke_selftest_expected_failure";
export const selfTests = Object.freeze([
  { id: "selftest_commit", expect: "rejected", why: "a smoke with COMMIT is refused before it is sent", text: "begin;\nselect 1;\ncommit;\n" },
  { id: "selftest_no_rollback", expect: "rejected", why: "a smoke that does not end in ROLLBACK is refused before it is sent", text: "begin;\nselect 1;\n" },
  { id: "selftest_failure", expect: "fail", why: "a smoke that raises an error fails", text: `begin;\ndo $selftest$ begin raise exception '${selfTestMarker}'; end $selftest$;\nrollback;\n` },
]);

export const migrationDir = "supabase/migrations";
const migrationName = /^\d{14}_[a-z0-9_]+\.sql$/;
const releaseId = /^[a-z0-9][a-z0-9._-]{1,60}$/;
/** The hash of a file's text with Unix line endings, so it is the same on every checkout. */
export const sqlHash = (text) => createHash("sha256").update(String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n"), "utf8").digest("hex");

/**
 * The migrations to run before each smoke, inside its transaction. Each one is named explicitly, by file name, and
 * has to be a file of supabase/migrations: no path, no pattern, nothing from anywhere else. With a release
 * manifest (releases/<id>.json), every one has to be listed there with the same hash.
 */
export function resolvePending(root, names = [], { release } = {}) {
  if (!names.length) { if (release) throw new PreconditionError("--release only applies together with --with-pending."); return []; }
  let listed = null;
  if (release !== undefined) {
    if (!releaseId.test(String(release))) throw new PreconditionError("A release id uses lowercase letters, digits, dots and dashes.");
    let manifest; try { manifest = JSON.parse(readFileSync(join(root, "releases", `${release}.json`), "utf8")); } catch { throw new PreconditionError(`releases/${release}.json could not be read.`); }
    if (!Array.isArray(manifest?.migrations)) throw new PreconditionError(`releases/${release}.json lists no migrations.`);
    listed = new Map(manifest.migrations.map((item) => [item?.file, item?.sha256]));
  }
  const base = realpathSync(join(root, migrationDir)); const seen = new Set(); const out = [];
  for (const name of names) {
    if (typeof name !== "string" || !migrationName.test(name)) throw new PreconditionError(`A pending migration is named by its file name in ${migrationDir} (for example 20261018090000_name.sql). Paths are not accepted.`);
    if (seen.has(name)) throw new PreconditionError(`${name} is listed twice.`); seen.add(name);
    const path = join(base, name);
    if (!existsSync(path)) throw new PreconditionError(`${name} is not in ${migrationDir}.`);
    // A link that points somewhere else is still somewhere else.
    if (realpathSync(path) !== path && !realpathSync(path).startsWith(base + sep)) throw new PreconditionError(`${name} is not a file of ${migrationDir}.`);
    const text = readFileSync(path, "utf8"); const hash = sqlHash(text);
    if (listed) {
      if (!listed.has(name)) throw new CheckFailed(`${name} is not part of release ${release}.`, { stage: "pending migrations" });
      if (listed.get(name) !== hash) throw new CheckFailed(`${name} is not the file release ${release} was prepared with (the hash differs).`, { stage: "pending migrations" });
    }
    const checked = validateMigrationSql(text);
    if (!checked.ok) throw new CheckFailed(`${name} cannot run inside a smoke's transaction.`, { stage: "pending migrations", details: checked.problems.slice(0, 5) });
    out.push({ file: name, text, sha256: hash, verified: !!listed });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const resultRow = (id, nonce) => `select '${contract}' as contract, '${id}' as smoke, 'PASS' as result, '${nonce}' as nonce, txid_current()::text as txid;`;
const plainId = /^[a-z][a-z0-9_]{1,60}$/;

/**
 * One smoke, from text to verdict: { id, status: "PASS" | "FAIL" | "REJECTED", reason, txid, ms }. A smoke that is
 * not accepted is never written to disk and never sent: `supabase.query` is not called for it.
 */
export function runOne({ id, text, checks = [], expect = "PASS", timeoutSeconds = 120 }, { supabase, dir, nonce, pending = [], now = Date.now }) {
  const started = now();
  const done = (status, reason = null, txid = null) => ({ id, status, reason, txid, ms: now() - started });
  if (!plainId.test(id) || !/^[0-9a-f]{16,64}$/.test(nonce)) return done("REJECTED", "the smoke id or the run value is not usable");
  const validated = validateSmokeSql(text, { checks });
  if (!validated.ok) return done("REJECTED", validated.problems.join("; "));
  const file = join(dir, `${id}.sql`);
  writeFileSync(file, composeSmokeSql(validated, { pending, resultRow: resultRow(id, nonce) }), "utf8");
  const answer = supabase.query(file, { columns: rowColumns, timeoutMs: timeoutSeconds * 1000 });
  if (!answer.ok) return done("FAIL", answer.reason);
  if (answer.rows.length !== 1) return done("FAIL", answer.rows.length ? `expected one result row, got ${answer.rows.length}` : "the expected result row is missing");
  const row = answer.rows[0];
  if (row.contract !== contract || row.smoke !== id || row.nonce !== nonce) return done("FAIL", "the expected result row is missing: the answer is not the row this run asked for");
  if (row.result !== expect) return done("FAIL", `the result is ${/^[A-Z_]{1,20}$/.test(row.result ?? "") ? row.result : "not readable"}, expected ${expect}`);
  if (!/^\d{1,20}$/.test(row.txid ?? "")) return done("FAIL", "the result row has no transaction id, so the rollback cannot be verified");
  return done("PASS", null, row.txid);
}

/** Runs the self-tests. Returns one entry per test: { id, ok, detail }. */
function runSelfTests(context) {
  return selfTests.map((test) => {
    let sent = 0;
    const counted = { ...context.supabase, query: (...args) => { sent++; return context.supabase.query(...args); } };
    const outcome = runOne({ id: test.id, text: test.text, timeoutSeconds: 120 }, { ...context, supabase: counted, pending: [] });
    if (test.expect === "rejected") {
      const ok = outcome.status === "REJECTED" && sent === 0;
      return { id: test.id, ok, why: test.why, detail: ok ? "refused, nothing was sent" : sent ? "IT WAS SENT: the runner did not refuse it" : `not refused (${outcome.status})` };
    }
    const ok = outcome.status === "FAIL" && String(outcome.reason ?? "").includes(selfTestMarker);
    return { id: test.id, ok, why: test.why, detail: ok ? "failed, as it has to" : outcome.status === "PASS" ? "IT PASSED: the runner cannot tell a failing smoke" : `could not be checked (${redact(outcome.reason ?? outcome.status, 160)})` };
  });
}

/** Asks PostgreSQL what became of each transaction. Returns a map txid → status, or a reason it could not. */
function transactionStatuses(supabase, dir, txids) {
  if (!txids.length) return { ok: true, statuses: new Map() };
  if (!txids.every((txid) => /^\d{1,20}$/.test(txid))) return { ok: false, reason: "a transaction id is not a number" };
  const file = join(dir, "rollback-check.sql");
  writeFileSync(file, `select t.txid as txid, txid_status(t.txid::bigint) as status from unnest(array[${txids.map((txid) => `'${txid}'`).join(",")}]::text[]) as t(txid);\n`, "utf8");
  const answer = supabase.query(file, { columns: ["txid", "status"], timeoutMs: 120_000 });
  if (!answer.ok) return { ok: false, reason: answer.reason };
  return { ok: true, statuses: new Map(answer.rows.map((row) => [row.txid, row.status])) };
}

/**
 * Runs `smokes` (entries of the manifest) and returns { ok, selfTests, results, target, counts }. `emit` receives
 * one event per thing that happens ({ type: "plan" | "selftest" | "smoke" | "rollback" | "summary", ... }), which
 * is what the human output and the NDJSON output are both made of.
 * Order: read and check every file; confirm the CLI is on staging; self-tests; smokes; rollback check.
 */
export function runSmokes({ root, supabase, manifest, smokes, pending = [], environment = process.env, emit = () => {}, makeNonce = () => randomBytes(16).toString("hex"), temporary = tmpdir(), target = "staging", transactionalTestsOnProduction = false }) {
  // Production only as prod-release's regression: each smoke is a transaction that is rolled back (checked before
  // it is sent, and with PostgreSQL afterwards), and never with pending migrations.
  if (target !== "staging" && !(target === "production" && transactionalTestsOnProduction === true && !pending.length)) throw new PreconditionError("Smokes run on staging; on production only as prod-release's regression, without pending migrations.");
  const defaults = Number(manifest.defaults.timeoutSeconds);
  const plan = smokes.map((smoke) => {
    let text = null; try { text = readFileSync(join(root, smoke.file), "utf8"); } catch { /* reported below */ }
    const checked = text === null ? { ok: false, problems: ["the file could not be read"] } : validateSmokeSql(text, { checks: smoke.checks ?? [] });
    return { id: smoke.id, file: smoke.file, groups: smoke.groups, text, checks: smoke.checks ?? [], expect: smoke.expect.result, timeoutSeconds: Number(smoke.timeoutSeconds ?? defaults), problems: checked.problems };
  });
  emit({ type: "plan", target, smokes: plan.map((item) => item.id), pending: pending.map((item) => ({ file: item.file, sha256: item.sha256.slice(0, 12), verified: item.verified })) });
  const counts = { total: plan.length, passed: 0, failed: 0, rejected: 0, notRun: 0 };
  const finish = (ok, extra) => { const summary = { ok, target, selfTests: [], results: [], counts, ...extra }; emit({ type: "summary", ok, counts, stopped: extra.stopped ?? null }); return summary; };
  // Nothing is sent while any file is in doubt: not that smoke, and not the others either.
  const rejected = plan.filter((item) => item.problems.length);
  if (rejected.length) {
    const results = plan.map((item) => (item.problems.length ? { id: item.id, status: "REJECTED", reason: item.problems.join("; "), txid: null, ms: 0 } : { id: item.id, status: "NOT RUN", reason: "another smoke was refused", txid: null, ms: 0 }));
    for (const result of results) emit({ type: "smoke", ...result });
    counts.rejected = rejected.length; counts.notRun = plan.length - rejected.length;
    return finish(false, { results, targetConfirmed: false, stopped: "a smoke was refused before anything was sent" });
  }
  const dir = mkdtempSync(join(temporary, "bellis-smoke-"));
  try {
    confirmTarget(supabase, target, { environment });
    const onTarget = () => supabase.linkedRef() === environments[target].ref && !((environment.SUPABASE_PROJECT_ID ?? "").trim() && environment.SUPABASE_PROJECT_ID.trim() !== environments[target].ref);
    const context = { supabase, dir, nonce: makeNonce() };
    const tests = runSelfTests(context);
    for (const test of tests) emit({ type: "selftest", ...test });
    if (!tests.every((test) => test.ok)) { counts.notRun = plan.length; return finish(false, { targetConfirmed: true, selfTests: tests, results: plan.map((item) => ({ id: item.id, status: "NOT RUN", reason: "the runner failed its own self-test", txid: null, ms: 0 })), stopped: "the runner failed its own self-test" }); }
    const results = [];
    for (const item of plan) {
      const result = onTarget() ? runOne(item, { ...context, pending }) : { id: item.id, status: "FAIL", reason: `the CLI is no longer on ${target}`, txid: null, ms: 0 };
      results.push(result); emit({ type: "smoke", ...result, reason: result.reason ? redact(result.reason, 300) : null });
    }
    // The last word on each rollback is PostgreSQL's, not the file's.
    const passed = results.filter((result) => result.status === "PASS");
    const seen = transactionStatuses(supabase, dir, passed.map((result) => result.txid));
    for (const result of passed) {
      const status = seen.ok ? seen.statuses.get(result.txid) : null;
      if (status !== "aborted") { result.status = "FAIL"; result.reason = seen.ok ? `its transaction was not rolled back (${/^[a-z ]{1,20}$/.test(status ?? "") ? status : "unknown"})` : `the rollback could not be verified (${seen.reason})`; }
    }
    emit({ type: "rollback", ok: seen.ok && passed.every((result) => result.status === "PASS"), checked: passed.length, reason: seen.ok ? null : redact(seen.reason, 200), notRolledBack: passed.filter((result) => result.status !== "PASS").map((result) => result.id) });
    counts.passed = results.filter((result) => result.status === "PASS").length; counts.failed = results.length - counts.passed;
    return finish(counts.failed === 0 && counts.total > 0, { targetConfirmed: true, selfTests: tests, results, rollbackVerified: seen.ok });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
/** One line of text for an event, for a person. Null for events that need no line. */
export function humanLine(event) {
  if (event.type === "plan") return `smokes: ${event.smokes.length} on ${event.target}${event.pending.length ? `, with ${event.pending.length} pending migration(s): ${event.pending.map((item) => `${item.file} (${item.sha256}${item.verified ? ", matches the release" : ""})`).join(", ")}` : ""}`;
  if (event.type === "selftest") return `${event.ok ? "ok  " : "FAIL"}  self-test ${event.id}: ${event.detail}`;
  if (event.type === "smoke") return `${event.status.padEnd(8)}  ${event.id}${event.status === "PASS" ? `  ${seconds(event.ms)}` : `  ${event.reason ?? ""}`}`;
  if (event.type === "rollback") return event.ok ? `ok    rollback verified for ${event.checked} transaction(s)` : `FAIL  rollback: ${event.reason ?? `not rolled back: ${event.notRolledBack.join(", ")}`}`;
  return null;
}
