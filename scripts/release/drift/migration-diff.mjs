/**
 * Release tooling: telling the differences a release is supposed to make from drift.
 *
 * Before a release, production does not have the pending migrations and staging does, so the two schemas differ and
 * an exact comparison cannot say whether that difference is only the release. What the migrations change is not
 * guessed from their text: it is measured.
 *
 *   rehearse (on staging, before the migrations are applied there):
 *     1. the schema is captured                                          → base
 *     2. one transaction runs the pending migrations, captures the schema and is rolled back   → expected
 *     3. PostgreSQL confirms that transaction was aborted, and the schema is captured again and must equal base
 *   The difference between base and expected is exactly what the release does, as PostgreSQL itself did it.
 *
 *   expected (before production, with staging already migrated): four captures are compared, and nothing is run.
 *     production must equal base       — otherwise production is not what the release was rehearsed on: drift
 *     staging must equal expected      — otherwise staging has something the migrations do not explain
 *     the migrations must be the same files, by hash and in the same order, as the ones rehearsed
 *     the versions staging has and production lacks must be exactly those of the release
 *
 * Nothing here runs a migration against production, and the rehearsal refuses production outright. A migration
 * that cannot be rehearsed safely (it cannot run in a transaction, or it does something a rollback does not undo)
 * stops the rehearsal and asks for a person: nothing is assumed about it.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckFailed, HumanActionRequired, PreconditionError, redact } from "../lib/report.mjs";
import { confirmTarget, environments } from "../lib/target.mjs";
import { resolvePending } from "../smoke/runner.mjs";
import { SqlError, statements, validateSmokeSql } from "../smoke/sql.mjs";
import { buildCapture, captureSchema, readAnswer, schemaSelect, sqlMarker } from "./capture.mjs";
import { compareSchemas } from "./compare.mjs";

/** Functions whose effects a rollback does not undo, or that reach outside the database. */
const unsafeCalls = Object.freeze({
  setval: "moves a sequence, which a rollback does not undo",
  dblink: "runs SQL over another connection, outside this transaction", dblink_exec: "runs SQL over another connection, outside this transaction", dblink_connect: "opens another connection, outside this transaction",
  pg_advisory_lock: "takes a lock that outlives the transaction", pg_advisory_lock_shared: "takes a lock that outlives the transaction", pg_terminate_backend: "ends another session", pg_cancel_backend: "cancels another session",
  pg_reload_conf: "reloads the server's configuration", lo_import: "reads a file on the server", lo_export: "writes a file on the server",
  http_post: "sends a request to the outside", http_get: "sends a request to the outside", http_delete: "sends a request to the outside", http: "sends a request to the outside",
});

/**
 * What in a migration makes it unsafe to rehearse, as a list of short sentences. Empty when nothing was found. Reads
 * the statements that run when the migration runs: the top level and the bodies of DO blocks. The body of a
 * function that is only being created does not run, and is not read.
 */
export function migrationRisks(text) {
  let list; try { list = statements(text); } catch (error) { if (!(error instanceof SqlError)) throw error; return [`cannot be read: ${error.message}`]; }
  const risks = new Set();
  const scan = (tokens, where) => {
    const words = tokens.map((token) => (token.type === "word" ? token.value : token.type === "punct" ? token.value : ""));
    const first = words.filter(Boolean).slice(0, 3).join(" ");
    if (words.includes("concurrently")) risks.add(`${where}: CONCURRENTLY cannot run inside a transaction`);
    if (/^(vacuum|checkpoint|load|discard)\b/.test(first)) risks.add(`${where}: ${first.split(" ")[0].toUpperCase()} cannot be rehearsed inside a transaction`);
    if (/^alter system\b/.test(first)) risks.add(`${where}: ALTER SYSTEM cannot run inside a transaction`);
    if (/^(create|drop|alter) (database|tablespace)\b/.test(first)) risks.add(`${where}: ${first.toUpperCase()} cannot run inside a transaction`);
    if (/^(create|drop|alter) extension\b/.test(first)) risks.add(`${where}: ${first.toUpperCase()} — an extension may do things a rollback does not undo`);
    if (/^copy\b/.test(first)) risks.add(`${where}: COPY reads or writes outside the database`);
    tokens.forEach((token, index) => { if (token.type === "word" && Object.hasOwn(unsafeCalls, token.value) && tokens[index + 1]?.value === "(") risks.add(`${where}: ${token.value}() ${unsafeCalls[token.value]}`); });
  };
  list.forEach((statement, index) => {
    const where = `statement ${index + 1}`;
    scan(statement.tokens, where);
    if (statement.tokens[0]?.value === "do") for (const token of statement.tokens) if (token.type === "dollar") { try { for (const inner of statements(token.body)) scan(inner.tokens, `${where} (DO block)`); } catch { risks.add(`${where}: its DO block cannot be read`); } }
  });
  return [...risks];
}

/** The migrations of a release, from its manifest (releases/<id>.json): exactly those files, in that order, with those hashes. */
export function releaseMigrations(root, release) {
  if (!/^[a-z0-9][a-z0-9._-]{1,60}$/.test(String(release ?? ""))) throw new PreconditionError("A release id uses lowercase letters, digits, dots and dashes.");
  let manifest; try { manifest = JSON.parse(readFileSync(join(root, "releases", `${release}.json`), "utf8")); } catch { throw new PreconditionError(`releases/${release}.json could not be read.`); }
  const files = Array.isArray(manifest?.migrations) ? manifest.migrations.map((item) => item?.file) : null;
  if (!files?.length) throw new PreconditionError(`releases/${release}.json lists no migrations: there is nothing a release would change.`);
  if (files.some((file, index) => index > 0 && !(String(files[index - 1]) < String(file)))) throw new CheckFailed(`releases/${release}.json does not list its migrations in the order they are applied.`, { stage: "pending migrations" });
  return resolvePending(root, files, { release });
}

/** The SQL of a rehearsal: one transaction that applies the migrations, captures the schema and is rolled back. */
export function rehearsalSql(pending) {
  const migrations = pending.map((item) => `\n-- pending migration: ${item.file}\n${String(item.text).replace(/^﻿/, "")}\n;\n`).join("");
  const sql = `-- ${sqlMarker} (rehearsal). The migrations below run inside this transaction, the schema is captured, and everything is rolled back.
begin;
${migrations}
set local time zone 'UTC';
set local search_path = '';
select s.schema, txid_current()::text as txid from (
${schemaSelect()}
) s;
rollback;
`;
  const shape = validateSmokeSql(sql);
  if (!shape.ok) throw new CheckFailed("The rehearsal is not a single transaction that is rolled back.", { stage: "rehearsal", details: shape.problems.slice(0, 5) });
  return sql;
}

const sameMigrations = (a, b) => a.length === b.length && a.every((item, index) => item.file === b[index].file && item.sha256 === b[index].sha256);
const versionOf = (file) => file.slice(0, 14);

/**
 * Rehearses `pending` on staging and returns { base, expected, changes }. Staging is left exactly as it was, and
 * that is checked twice: with the transaction's status and with a second capture of the schema.
 */
export function rehearse({ supabase, pending, release = null, gitCommit = null, environment = process.env, now = () => new Date(), temporary = tmpdir() }) {
  if (!pending.length) throw new PreconditionError("There is no migration to rehearse.");
  const risky = pending.flatMap((item) => migrationRisks(item.text).map((risk) => `${item.file}: ${risk}`));
  if (risky.length) throw new HumanActionRequired("A pending migration cannot be rehearsed safely. Nothing was run.", { stage: "rehearsal", details: risky.slice(0, 20) });
  const sql = rehearsalSql(pending);
  // Only ever staging. Production is never the place to try a migration.
  confirmTarget(supabase, "staging", { environment });
  const stamp = () => now().toISOString().replace(/\.\d+Z$/, "Z");
  const base = captureSchema({ supabase, target: "staging", release, label: "base", gitCommit, environment, now, temporary });
  const already = pending.filter((item) => base.appliedMigrations.includes(versionOf(item.file)));
  if (already.length) throw new HumanActionRequired("Staging already has migrations of this release, so what they change can no longer be measured there.", { stage: "rehearsal", details: already.map((item) => `${item.file} is already applied on staging`) });
  if (supabase.linkedRef() !== environments.staging.ref) throw new CheckFailed("The CLI is no longer on staging.", { stage: "rehearsal" });
  const { parsed, row } = readAnswer(supabase, sql, { temporary, columns: ["schema", "txid"] });
  const expected = buildCapture(parsed, { environment: "staging", release, label: "expected", gitCommit, capturedAt: stamp(), rehearsed: pending.map((item) => ({ file: item.file, sha256: item.sha256 })) });
  // Two proofs that nothing stayed: the transaction is reported as aborted, and the schema is what it was.
  if (!/^\d{1,20}$/.test(row.txid ?? "")) throw new CheckFailed("The rehearsal did not return its transaction, so its rollback cannot be verified.", { stage: "rehearsal" });
  const dir = mkdtempSync(join(temporary, "bellis-rehearsal-"));
  try {
    const file = join(dir, "rollback-check.sql"); writeFileSync(file, `select t.txid as txid, txid_status(t.txid::bigint) as status from (values ('${row.txid}')) as t(txid);\n`, "utf8");
    const status = supabase.query(file, { columns: ["status"], timeoutMs: 120_000 });
    if (!status.ok || status.rows[0]?.status !== "aborted") throw new CheckFailed("The rehearsal's transaction is not reported as rolled back. Look at staging before doing anything else.", { stage: "rehearsal", details: [status.ok ? "its status is not aborted" : redact(status.reason, 200)] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const after = captureSchema({ supabase, target: "staging", release, label: "after", gitCommit, environment, now, temporary });
  const left = compareSchemas(base, after);
  if (!left.ok) throw new CheckFailed("Staging's schema is not what it was before the rehearsal. Look at staging before doing anything else.", { stage: "rehearsal", details: left.differences.slice(0, 10).map((item) => `${item.change} ${item.category} ${redact(item.id, 120)}`) });
  return { base, expected, changes: compareSchemas(base, expected) };
}

/**
 * Whether the difference between staging and production is exactly the release. Pure: it reads four captures.
 * Returns { ok, problems, explained, drift, unexplained }:
 *   explained    what the migrations change (base → expected);
 *   drift        where production differs from base;
 *   unexplained  where staging differs from expected.
 */
export function explainExpected({ base, expected, staging, production, pending }) {
  const problems = [];
  for (const [name, capture, want] of [["base", base, "staging"], ["expected", expected, "staging"], ["staging", staging, "staging"], ["production", production, "production"]])
    if (capture.meta.environment !== want) problems.push(`the ${name} capture is of ${capture.meta.environment}, not ${want}`);
  const wanted = pending.map((item) => ({ file: item.file, sha256: item.sha256 }));
  if (!sameMigrations(expected.meta.rehearsed, wanted)) problems.push("the migrations of the release are not the files that were rehearsed (a file, a hash or the order differs): rehearse again");
  if (base.meta.rehearsed.length) problems.push("the base capture is itself the result of a rehearsal");
  const versions = pending.map((item) => versionOf(item.file)).sort();
  const onlyStaging = staging.appliedMigrations.filter((version) => !production.appliedMigrations.includes(version)).sort();
  const onlyProduction = production.appliedMigrations.filter((version) => !staging.appliedMigrations.includes(version)).sort();
  if (onlyProduction.length) problems.push(`production has migrations staging does not: ${onlyProduction.join(", ")}`);
  if (onlyStaging.join() !== versions.join()) problems.push(`the migrations pending for production (${onlyStaging.join(", ") || "none"}) are not exactly those of the release (${versions.join(", ")})`);
  const drift = compareSchemas(base, production).differences, unexplained = compareSchemas(expected, staging).differences, explained = compareSchemas(base, expected).differences;
  return { ok: problems.length === 0 && drift.length === 0 && unexplained.length === 0, problems, explained, drift, unexplained };
}
