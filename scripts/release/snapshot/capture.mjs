/**
 * Release tooling: takes a data snapshot of the project the CLI is linked to, and decides what a snapshot may
 * contain.
 *
 * A snapshot holds counts, fingerprints and technical metadata: nothing else. `snapshotProblems` is the gate: it
 * accepts a document only if every field is one it knows and every value has the shape it expects (a number, a
 * hash, a table name, a column name). A name, an email, a note or a token has no place to be in it, so a document
 * that carries one is refused, both before it is written and when it is read back to be compared.
 *
 * Capturing never links the CLI: it has to be on the environment asked for already, confirmed with the account's
 * list of projects. The SQL is a read-only transaction, so it is safe on production too.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckFailed, redact } from "../lib/report.mjs";
import { confirmTarget, environments } from "../lib/target.mjs";
import { statements, validateSmokeSql } from "../smoke/sql.mjs";
import { buildSnapshotSql, configHash, configProblems } from "./build-sql.mjs";

export const snapshotFormat = "bellis_snapshot";
export const snapshotVersion = 1;
export const toolVersion = "h2.8c";
export const warningCodes = Object.freeze(["uncovered_table", "no_primary_key", "key_is_not_primary_key"]);
const patterns = { hash: /^[0-9a-f]{64}$/, table: /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/, column: /^[a-z_][a-z0-9_]{0,62}$/, time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/,
  commit: /^[0-9a-f]{40}$/, ref: /^[a-z0-9]{20}$/, release: /^[a-z0-9][a-z0-9._-]{1,60}$/, label: /^[a-z0-9][a-z0-9-]{0,30}$/, tool: /^[a-z0-9][a-z0-9._-]{0,30}$/ };
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const count = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Everything wrong with a snapshot document, as a list of field paths and what was expected there. Never a value:
 * what is wrong might be the very thing that must not be shown.
 */
export function snapshotProblems(document) {
  const problems = [];
  const fields = (object, allowed, path) => { for (const key of Object.keys(object)) if (!allowed.includes(key)) problems.push(`${path}: unexpected field (${/^[a-z_A-Z]{1,40}$/.test(key) ? key : "name not shown"})`); };
  const text = (value, pattern, path, what) => { if (typeof value !== "string" || !pattern.test(value)) problems.push(`${path}: is not ${what}`); };
  const list = (value, pattern, path, what) => { if (!Array.isArray(value)) problems.push(`${path}: is not a list`); else value.forEach((item, index) => text(item, pattern, `${path}[${index}]`, what)); };
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["the snapshot is not a document"];
  fields(document, ["format", "version", "meta", "tables", "warnings", "ignored"], "snapshot");
  if (document.format !== snapshotFormat) problems.push("format: is not a Bellis snapshot");
  if (document.version !== snapshotVersion) problems.push("version: is not a version this tool reads");
  const meta = document.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) problems.push("meta: is missing");
  else {
    fields(meta, ["tool", "configVersion", "configHash", "release", "label", "environment", "ref", "commit", "capturedAt", "databaseTime"], "meta");
    text(meta.tool, patterns.tool, "meta.tool", "a tool version"); if (!count(meta.configVersion) || meta.configVersion < 1) problems.push("meta.configVersion: is not a version");
    text(meta.configHash, patterns.hash, "meta.configHash", "a hash"); if (meta.release !== null) text(meta.release, patterns.release, "meta.release", "a release id");
    text(meta.label, patterns.label, "meta.label", "a label"); text(meta.ref, patterns.ref, "meta.ref", "a project ref");
    if (!Object.hasOwn(environments, meta.environment ?? "") || environments[meta.environment].ref !== meta.ref) problems.push("meta.environment: is not staging or production with its own ref");
    if (meta.commit !== null) text(meta.commit, patterns.commit, "meta.commit", "a commit"); text(meta.capturedAt, patterns.time, "meta.capturedAt", "a time"); text(meta.databaseTime, patterns.time, "meta.databaseTime", "a time");
  }
  if (!Array.isArray(document.tables) || !document.tables.length) problems.push("tables: is missing or empty");
  else {
    const seen = new Set();
    document.tables.forEach((entry, index) => {
      const path = `tables[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { problems.push(`${path}: is not a table entry`); return; }
      text(entry.table, patterns.table, `${path}.table`, "a table name"); if (seen.has(entry.table)) problems.push(`${path}.table: is listed twice`); seen.add(entry.table);
      if (!count(entry.count)) problems.push(`${path}.count: is not a count`);
      if (entry.mode === "count") fields(entry, ["table", "mode", "count"], path);
      else if (entry.mode === "fingerprint") {
        fields(entry, ["table", "mode", "count", "fingerprint", "key", "excluded", "columns", "columnsFingerprint"], path);
        text(entry.fingerprint, patterns.hash, `${path}.fingerprint`, "a hash"); text(entry.columnsFingerprint, patterns.hash, `${path}.columnsFingerprint`, "a hash");
        list(entry.key, patterns.column, `${path}.key`, "a column name"); list(entry.excluded, patterns.column, `${path}.excluded`, "a column name");
        if (!count(entry.columns) || entry.columns < 1) problems.push(`${path}.columns: is not a count`);
      } else problems.push(`${path}.mode: is not fingerprint or count`);
    });
  }
  if (!Array.isArray(document.warnings)) problems.push("warnings: is not a list");
  else document.warnings.forEach((warning, index) => {
    const path = `warnings[${index}]`;
    if (!warning || typeof warning !== "object" || Array.isArray(warning)) { problems.push(`${path}: is not a warning`); return; }
    fields(warning, ["code", "table"], path); if (!warningCodes.includes(warning.code)) problems.push(`${path}.code: is not a known warning`); text(warning.table, patterns.table, `${path}.table`, "a table name");
  });
  list(document.ignored, patterns.table, "ignored", "a table name");
  return problems;
}

const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const answerFields = { count: ["table", "count"], fingerprint: ["table", "count", "fingerprint", "key_nulls", "key_distinct", "columns", "primary_key"] };
const refuse = (message, details = []) => new CheckFailed(message, { stage: "snapshot", details: details.slice(0, 20) });

/**
 * Turns what the database answered into a snapshot, checking every part of it against the configuration. Throws
 * instead of producing a snapshot that is not certain: a missing table, a fingerprint that is not a hash, a key
 * that repeats, an excluded column that does not exist.
 */
export function buildSnapshot(answer, config, meta) {
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.tables) || !Array.isArray(answer.uncovered) || !answer.self_test) throw refuse("The database's answer is not a snapshot.");
  const test = answer.self_test;
  if (![test.base, test.reordered, test.changed, test.excluded_changed].every((value) => patterns.hash.test(String(value))) || test.reordered !== test.base || test.excluded_changed !== test.base || test.changed === test.base)
    throw refuse("The fingerprint failed its own check in the database: the same rows in another order, a changed field or an excluded column did not behave as they must.");
  const answered = new Map(answer.tables.map((item) => [item?.table, item]));
  const problems = [], warnings = [], tables = [];
  for (const entry of config.tables) {
    const got = answered.get(entry.table);
    if (!got) { problems.push(`${entry.table}: missing from the answer`); continue; }
    // The SQL is ours, so a field that was not asked for means the answer is not what it seems. It is not copied anywhere.
    if (Object.keys(got).some((field) => !answerFields[entry.mode].includes(field))) { problems.push(`${entry.table}: the answer has a field that was not asked for`); continue; }
    if (!count(got.count)) { problems.push(`${entry.table}: the count is not a number`); continue; }
    if (entry.mode === "count") { tables.push({ table: entry.table, mode: "count", count: got.count }); continue; }
    const columns = Array.isArray(got.columns) && got.columns.every((name) => patterns.column.test(String(name))) ? got.columns : null;
    if (!columns?.length) { problems.push(`${entry.table}: its columns could not be read`); continue; }
    if (!patterns.hash.test(String(got.fingerprint))) { problems.push(`${entry.table}: the fingerprint could not be computed`); continue; }
    const excluded = (entry.exclude ?? []).map((item) => item.column).sort();
    for (const column of entry.key) if (!columns.includes(column)) problems.push(`${entry.table}: the key column ${column} does not exist`);
    for (const column of excluded) if (!columns.includes(column)) problems.push(`${entry.table}: the excluded column ${column} does not exist`);
    if (got.key_nulls !== 0) problems.push(`${entry.table}: the key is empty in some rows`);
    if (got.key_distinct !== got.count) problems.push(`${entry.table}: the key does not identify a row (it repeats)`);
    const primary = Array.isArray(got.primary_key) ? got.primary_key : [];
    if (!primary.length) warnings.push({ code: "no_primary_key", table: entry.table });
    else if (!same([...primary].sort(), [...entry.key].sort())) warnings.push({ code: "key_is_not_primary_key", table: entry.table });
    tables.push({ table: entry.table, mode: "fingerprint", count: got.count, fingerprint: got.fingerprint, key: [...entry.key], excluded, columns: columns.length, columnsFingerprint: sha256(columns.join(",")) });
  }
  for (const name of answer.uncovered) { if (patterns.table.test(String(name))) warnings.push({ code: "uncovered_table", table: name }); else problems.push("a table that is not covered has a name that cannot be shown"); }
  if (problems.length) throw refuse("The snapshot could not be taken with certainty.", problems);
  const snapshot = { format: snapshotFormat, version: snapshotVersion,
    meta: { tool: toolVersion, configVersion: config.version, configHash: configHash(config), release: meta.release ?? null, label: meta.label, environment: meta.environment, ref: environments[meta.environment].ref,
      commit: meta.commit ?? null, capturedAt: meta.capturedAt, databaseTime: answer.database_time },
    tables, warnings, ignored: (config.ignored ?? []).map((item) => item.table) };
  const wrong = snapshotProblems(snapshot);
  if (wrong.length) throw refuse("The snapshot has something a snapshot cannot contain.", wrong);
  return snapshot;
}

/**
 * Captures a snapshot of `environment` ("staging" or "production"). The CLI has to be there already; it is not
 * linked or moved. Returns the snapshot document.
 */
export function captureSnapshot({ supabase, config, target = "staging", release = null, label, commit = null, environment = process.env, now = () => new Date(), temporary = tmpdir() }) {
  const problems = configProblems(config);
  if (problems.length) throw new CheckFailed("The snapshot configuration is not valid.", { stage: "snapshot configuration", details: problems.slice(0, 20) });
  if (!patterns.label.test(String(label ?? ""))) throw refuse("A snapshot needs a label (for example pre or post).");
  const sql = buildSnapshotSql(config);
  // The SQL that is about to run is checked like any other: one transaction, undone, and opened read-only.
  const shape = validateSmokeSql(sql); const opening = statements(sql)[0]?.tokens.map((token) => token.value).join(" ") ?? "";
  if (!shape.ok || !/\bread only$/.test(opening)) throw refuse("The snapshot SQL is not a read-only transaction that is rolled back.", shape.problems);
  confirmTarget(supabase, target, { environment });
  const dir = mkdtempSync(join(temporary, "bellis-snapshot-"));
  try {
    const file = join(dir, "snapshot.sql"); writeFileSync(file, sql, "utf8");
    const answer = supabase.query(file, { columns: ["snapshot"], timeoutMs: 300_000 });
    if (!answer.ok) throw refuse("The snapshot could not be read from the database.", [redact(answer.reason, 240)]);
    if (answer.rows.length !== 1 || typeof answer.rows[0].snapshot !== "string") throw refuse("The database's answer is not a snapshot.");
    let parsed; try { parsed = JSON.parse(answer.rows[0].snapshot); } catch { throw refuse("The database's answer is not a snapshot."); }
    if (supabase.linkedRef() !== environments[target].ref) throw refuse("The CLI moved while the snapshot was being taken.");
    return buildSnapshot(parsed, config, { release, label, environment: target, commit, capturedAt: now().toISOString().replace(/\.\d+Z$/, "Z") });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
