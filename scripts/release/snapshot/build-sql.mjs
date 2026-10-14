/**
 * Release tooling: the configuration of a data snapshot (tables.json, next to this file) and the SQL that takes it.
 *
 * A snapshot is counts and fingerprints, never rows. The fingerprint of a table is built like this:
 *   1. each row becomes JSONB (to_jsonb), minus the columns the configuration leaves out, and is hashed (SHA-256);
 *   2. each hash is cut into four 60-bit numbers, and each of the four is added up over the whole table;
 *   3. the row count and the four sums are hashed once more.
 * Adding is the same in any order, so the result cannot depend on the order PostgreSQL returns rows in, and nothing
 * is concatenated: the work is one pass and four running totals, whatever the size of the table. The declared key
 * is part of every row's hash, and it is checked on every capture: never null, never repeated.
 *
 * The SQL is one read-only transaction (PostgreSQL itself refuses a write in it), in UTC so a timestamp is written
 * the same way wherever it is taken, and it ends in ROLLBACK.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckFailed, PreconditionError } from "../lib/report.mjs";

export const configPath = "scripts/release/snapshot/tables.json";
export const sqlMarker = "Bellis data snapshot";
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const tableName = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;
/** Schemas whose rows are never hashed: only counted. */
const countOnlySchemas = ["auth", "vault"];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Everything wrong with a snapshot configuration, as a list. Empty when it can be used. */
export function configProblems(config) {
  if (!config || typeof config !== "object" || !Array.isArray(config.tables)) return ["the configuration has no list of tables"];
  const problems = [];
  if (!Number.isInteger(config.version) || config.version < 1) problems.push("the configuration has no version");
  if (!Array.isArray(config.schemas) || !config.schemas.length || config.schemas.some((name) => !identifier.test(String(name)))) problems.push("the configuration does not say which schemas it covers");
  if (!config.tables.length) problems.push("the configuration lists no tables");
  const seen = new Set();
  for (const [index, entry] of config.tables.entries()) {
    const name = typeof entry?.table === "string" ? entry.table : `#${index + 1}`;
    if (!tableName.test(String(entry?.table ?? ""))) { problems.push(`${name}: a table is named schema.table, in lowercase`); continue; }
    if (seen.has(entry.table)) problems.push(`${name}: listed twice`); seen.add(entry.table);
    const schema = entry.table.split(".")[0];
    if (!["fingerprint", "count"].includes(entry.mode)) { problems.push(`${name}: the mode is fingerprint or count`); continue; }
    if (entry.mode === "fingerprint") {
      if (countOnlySchemas.includes(schema)) problems.push(`${name}: tables of ${schema} can only be counted`);
      if (!Array.isArray(entry.key) || !entry.key.length) problems.push(`${name}: has no key. A fingerprint needs the columns that identify a row, said explicitly`);
      else { if (entry.key.some((column) => !identifier.test(String(column)))) problems.push(`${name}: a key column is not a valid name`); if (new Set(entry.key).size !== entry.key.length) problems.push(`${name}: a key column is repeated`); }
    } else if (entry.key !== undefined || entry.exclude !== undefined) problems.push(`${name}: a table that is only counted has no key and no excluded columns`);
    if (entry.exclude !== undefined && !Array.isArray(entry.exclude)) problems.push(`${name}: "exclude" is a list`);
    const excluded = new Set();
    for (const item of Array.isArray(entry.exclude) ? entry.exclude : []) {
      if (!identifier.test(String(item?.column ?? ""))) { problems.push(`${name}: an excluded column is not a valid name`); continue; }
      if (typeof item.reason !== "string" || item.reason.trim().length < 10) problems.push(`${name}: ${item.column} is excluded without a reason`);
      if (excluded.has(item.column)) problems.push(`${name}: ${item.column} is excluded twice`); excluded.add(item.column);
      if (Array.isArray(entry.key) && entry.key.includes(item.column)) problems.push(`${name}: ${item.column} is part of the key and cannot be excluded`);
    }
  }
  for (const item of config.ignored ?? []) {
    if (!tableName.test(String(item?.table ?? ""))) { problems.push("an ignored table is named schema.table, in lowercase"); continue; }
    if (typeof item.reason !== "string" || item.reason.trim().length < 10) problems.push(`${item.table}: ignored without a reason`);
    if (seen.has(item.table)) problems.push(`${item.table}: listed and ignored at the same time`); seen.add(item.table);
  }
  return problems;
}

/** Reads and checks the configuration of this repository. */
export function loadConfig(root) {
  let config;
  try { config = JSON.parse(readFileSync(join(root, configPath), "utf8")); } catch { throw new PreconditionError(`${configPath} could not be read.`); }
  const problems = configProblems(config);
  if (problems.length) throw new CheckFailed("The snapshot configuration is not valid.", { stage: "snapshot configuration", details: problems.slice(0, 20) });
  return config;
}

const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value ?? null));
/** What identifies a configuration: two snapshots are comparable only when it is the same. Notes do not count. */
export function configHash(config) {
  return sha256(canonical({ version: config.version, schemas: config.schemas,
    tables: config.tables.map((entry) => ({ table: entry.table, mode: entry.mode, key: entry.key ?? null, exclude: (entry.exclude ?? []).map((item) => item.column).sort() })),
    ignored: (config.ignored ?? []).map((item) => item.table).sort() }));
}

/**
 * The same fingerprint, computed here from rows held in memory. It is the model of what the SQL does (same steps,
 * same arithmetic), used to reason about it and to test it without a database. It is not byte-compatible with
 * PostgreSQL's: the JSON of a row is written differently there.
 */
export function fingerprintRows(rows, { exclude = [] } = {}) {
  const sums = [0n, 0n, 0n, 0n];
  for (const row of rows) {
    const kept = Object.fromEntries(Object.entries(row).filter(([column]) => !exclude.includes(column)));
    const hash = sha256(canonical(kept));
    for (let part = 0; part < 4; part++) sums[part] += BigInt(`0x${hash.slice(part * 15, part * 15 + 15)}`);
  }
  return sha256([rows.length, ...sums].join(":"));
}

const quoted = (name) => { if (!identifier.test(name)) throw new CheckFailed("A name in the snapshot configuration is not valid."); return `"${name}"`; };
const relation = (table) => table.split(".").map(quoted).join(".");
const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;
const part = (index) => `('x' || substr(h, ${index * 15 + 1}, 15))::bit(60)::bigint::numeric`;

/**
 * One SELECT that reads `source` (anything that can follow FROM, aliased t) and returns a single row: n,
 * key_nulls, key_distinct and fp.
 */
export function statsSql(source, { key, exclude = [] }) {
  const keyColumns = key.map((column) => `t.${quoted(column)}`);
  const without = exclude.length ? `array[${exclude.map((column) => literal(column)).join(",")}]::text[]` : "array[]::text[]";
  return `select count(*) as n, count(*) filter (where not key_ok) as key_nulls, count(distinct key_text) as key_distinct,
      encode(sha256(convert_to(concat_ws(':', count(*), coalesce(sum(p1), 0), coalesce(sum(p2), 0), coalesce(sum(p3), 0), coalesce(sum(p4), 0)), 'UTF8')), 'hex') as fp
    from (select ${[0, 1, 2, 3].map((index) => `${part(index)} as p${index + 1}`).join(", ")}, key_ok, key_text
      from (select encode(sha256(convert_to((to_jsonb(t) - ${without})::text, 'UTF8')), 'hex') as h,
          (${keyColumns.map((column) => `${column} is not null`).join(" and ")}) as key_ok, jsonb_build_array(${keyColumns.join(", ")})::text as key_text
        from ${source}) r) p`;
}

function tableSql(entry) {
  const name = literal(entry.table), from = relation(entry.table);
  if (entry.mode === "count") return `(select jsonb_build_object('table', ${name}, 'count', (select count(*) from ${from})))`;
  const oid = `${literal(from)}::regclass`;
  return `(select jsonb_build_object('table', ${name}, 'count', s.n, 'fingerprint', s.fp, 'key_nulls', s.key_nulls, 'key_distinct', s.key_distinct,
    'columns', (select coalesce(jsonb_agg(a.attname order by a.attnum), '[]'::jsonb) from pg_attribute a where a.attrelid = ${oid} and a.attnum > 0 and not a.attisdropped),
    'primary_key', (select coalesce(jsonb_agg(a.attname order by k.ord), '[]'::jsonb) from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum where i.indrelid = ${oid} and i.indisprimary))
  from (${statsSql(`${from} t`, { key: entry.key, exclude: (entry.exclude ?? []).map((item) => item.column) })}) s)`;
}

/**
 * Four fingerprints of made-up rows, computed by the database with the very expressions used for the tables: the
 * same rows in another order, with one field changed, and with only an excluded column changed. A capture is
 * accepted only if the first two agree with the base, the third does not and the fourth does.
 */
function selfTestSql() {
  const fp = (rows) => `(select fp from (${statsSql(`(values ${rows}) t(id, label, seen)`, { key: ["id"], exclude: ["seen"] })}) s)`;
  return `jsonb_build_object('base', ${fp("(1, 'a', 'x'), (2, 'b', 'y'), (3, 'c', 'z')")}, 'reordered', ${fp("(3, 'c', 'z'), (1, 'a', 'x'), (2, 'b', 'y')")},
    'changed', ${fp("(1, 'a', 'x'), (2, 'B', 'y'), (3, 'c', 'z')")}, 'excluded_changed', ${fp("(1, 'a', 'other'), (2, 'b', 'y'), (3, 'c', 'z')")})`;
}

/** The SQL of a snapshot: one read-only transaction that answers with one row and one column, `snapshot`. */
export function buildSnapshotSql(config) {
  const problems = configProblems(config);
  if (problems.length) throw new CheckFailed("The snapshot configuration is not valid.", { stage: "snapshot configuration", details: problems.slice(0, 20) });
  const known = [...config.tables.map((entry) => entry.table), ...(config.ignored ?? []).map((item) => item.table)];
  return `-- ${sqlMarker}, configuration version ${config.version}. Generated by scripts/release/snapshot/build-sql.mjs.
-- Read-only: counts and fingerprints. No row leaves the database.
begin transaction isolation level repeatable read read only;
set local time zone 'UTC';
select jsonb_build_object(
  'database_time', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'tables', (select jsonb_agg(x.item) from (values
    ${config.tables.map((entry) => `(${tableSql(entry)})`).join(",\n    ")}
  ) x(item)),
  'uncovered', (select coalesce(jsonb_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname), '[]'::jsonb) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = any(array[${config.schemas.map(literal).join(",")}]::text[]) and (n.nspname || '.' || c.relname) <> all(array[${known.map(literal).join(",")}]::text[])),
  'self_test', ${selfTestSql()}
) as snapshot;
rollback;
`;
}
