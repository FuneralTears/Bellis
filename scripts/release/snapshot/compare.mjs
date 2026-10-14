/**
 * Release tooling: compares two data snapshots, the one taken before and the one taken after.
 * Any difference is a failure: a count, a fingerprint, a table that is in one and not in the other, the columns of
 * a table, or a configuration that is not the same (which makes the two not comparable at all). There is no list
 * of differences that are expected: when one is needed it will be explicit configuration, not a default.
 * What comes out is which tables differ and how, with their counts. Never a row, and never a hash.
 */
import { readFileSync } from "node:fs";
import { CheckFailed, PreconditionError } from "../lib/report.mjs";
import { snapshotProblems } from "./capture.mjs";

/** Checks a snapshot read from anywhere. Accepts the document itself or the file the state folder wraps it in. */
export function acceptSnapshot(value, name = "snapshot") {
  const document = value && typeof value === "object" && value.format === undefined && value.data && typeof value.data === "object" ? value.data : value;
  const problems = snapshotProblems(document);
  if (problems.length) throw new CheckFailed(`The ${name} snapshot is not valid, or holds something a snapshot cannot contain.`, { stage: "snapshot", details: problems.slice(0, 10) });
  return document;
}
export function readSnapshotFile(path, name = "snapshot") {
  let value; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new PreconditionError(`The ${name} snapshot could not be read.`); }
  return acceptSnapshot(value, name);
}

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * { ok, comparable, problems, rows }. `problems` are the reasons the two cannot be compared at all; `rows` has one
 * entry per table: { table, countBefore, countAfter, countEqual, fingerprintEqual, status }, where status is
 * "same", "count", "fingerprint", "columns", "settings", "removed" or "added". fingerprintEqual is null for a
 * table that is only counted.
 */
export function compareSnapshots(before, after) {
  const problems = [];
  if (before.version !== after.version) problems.push("the two snapshots are of different format versions");
  if (before.meta.configVersion !== after.meta.configVersion) problems.push(`the configuration version differs (${before.meta.configVersion} and ${after.meta.configVersion})`);
  else if (before.meta.configHash !== after.meta.configHash) problems.push("the configuration differs: tables, keys or excluded columns are not the same");
  if (before.meta.environment !== after.meta.environment || before.meta.ref !== after.meta.ref) problems.push(`the two snapshots are of different environments (${before.meta.environment} and ${after.meta.environment})`);
  const first = new Map(before.tables.map((entry) => [entry.table, entry])), second = new Map(after.tables.map((entry) => [entry.table, entry]));
  const rows = [...new Set([...first.keys(), ...second.keys()])].map((table) => {
    const a = first.get(table), b = second.get(table);
    const row = { table, countBefore: a?.count ?? null, countAfter: b?.count ?? null, countEqual: !!a && !!b && a.count === b.count, fingerprintEqual: null, status: "same" };
    if (!a || !b) return { ...row, status: a ? "removed" : "added" };
    if (a.mode !== b.mode) return { ...row, status: "settings" };
    if (a.mode === "fingerprint") {
      row.fingerprintEqual = a.fingerprint === b.fingerprint;
      if (!sameList(a.key, b.key) || !sameList(a.excluded, b.excluded)) return { ...row, status: "settings" };
      if (a.columns !== b.columns || a.columnsFingerprint !== b.columnsFingerprint) return { ...row, status: "columns" };
    }
    if (!row.countEqual) return { ...row, status: "count" };
    if (row.fingerprintEqual === false) return { ...row, status: "fingerprint" };
    return row;
  });
  const different = rows.filter((row) => row.status !== "same");
  return { ok: problems.length === 0 && different.length === 0, comparable: problems.length === 0, problems, rows, different };
}

const explain = { count: "the number of rows changed", fingerprint: "same number of rows, different content", columns: "the columns of the table changed", settings: "taken with different settings", removed: "only in the first snapshot", added: "only in the second snapshot" };
/** One line per table that differs, for a person: the table, what happened and the two counts. */
export function differenceLine(row) {
  const counts = row.countBefore === null || row.countAfter === null ? "" : row.countEqual ? ` (${row.countBefore} rows)` : ` (${row.countBefore} → ${row.countAfter} rows)`;
  return `${row.table}: ${explain[row.status] ?? row.status}${counts}`;
}
