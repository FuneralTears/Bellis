/**
 * Release tooling: checks the production backups a person made before a release. It never makes a backup, never
 * asks for a password and never touches Supabase: it reads files with `pg_restore --list`.
 *
 * Two backups, one per schema, in C:\Users\<user>\Bellis-Backups\ (or BELLIS_BACKUPS_DIR):
 *   bellis-prod-public-YYYYMMDD-HHMM-pre-<release>.dump      pg_dump --format=custom --schema=public
 *   bellis-prod-private-YYYYMMDD-HHMM-pre-<release>.dump     pg_dump --format=custom --schema=private
 * `auth` and `vault` are not in them: known debt.
 *
 * A backup passes when it exists, is not empty, is a custom-format archive pg_restore can read, is at most 24 hours
 * old (by the time written inside it), has a name that matches its release, schema and that time, holds only its own
 * schema, holds the data of every table, and holds exactly the objects production has in that schema: no fewer
 * (something applied to production is missing from it) and no more (in particular nothing that only the release's
 * migrations create). The objects are not listed by hand: they come from the schema captures of the release
 * (`schema-base`, measured on staging and verified identical to production, and `schema-expected` for what the
 * migrations add). Its size is compared with the previous backup of the same schema: much smaller or much larger is a
 * question for a person.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { PreconditionError, redact } from "../lib/report.mjs";

export const backupSchemas = Object.freeze(["public", "private"]);
export const defaults = Object.freeze({ maxAgeHours: 24, smallerThan: 0.8, largerThan: 2.5, nameSkewHours: 2 });
const namePattern = /^bellis-prod-(public|private)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-pre-([a-z0-9](?:[a-z0-9-]|\.(?!\.)){1,60})\.dump$/;
const tocTypes = ["MATERIALIZED VIEW", "FK CONSTRAINT", "ROW SECURITY", "SEQUENCE OWNED BY", "SEQUENCE SET", "TABLE DATA", "DEFAULT ACL", "TABLE ATTACH", "INDEX ATTACH", "CONSTRAINT", "SEQUENCE", "FUNCTION", "PROCEDURE", "AGGREGATE", "TRIGGER", "POLICY", "DOMAIN", "SCHEMA", "TABLE", "INDEX", "VIEW", "TYPE", "COMMENT", "DEFAULT", "ACL", "EXTENSION", "PUBLICATION", "RULE"];

export function backupsDir(environment = process.env, home = homedir()) { return resolve(environment.BELLIS_BACKUPS_DIR ?? join(home, "Bellis-Backups")); }

/** What a backup's name says: { schema, release, time } (time read as local time), or null when it is not one of ours. */
export function parseBackupName(name) {
  const match = namePattern.exec(name); if (!match) return null;
  const [, schema, year, month, day, hour, minute, release] = match;
  const time = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(time.getTime()) || time.getMonth() !== Number(month) - 1 ? null : { schema, release, time };
}

/**
 * The table of contents of an archive, as pg_restore --list prints it: { format, createdAt, entries }. Each entry:
 * { type, schema, name }; the owner at the end of the line is dropped.
 */
export function parseToc(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const header = (label) => lines.find((line) => line.startsWith(`;     ${label}:`))?.split(":").slice(1).join(":").trim() ?? null;
  const created = /^; Archive created at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(lines.find((line) => line.startsWith("; Archive created at")) ?? "");
  const entries = [];
  for (const line of lines) {
    const match = /^\d+; \d+ \d+ (.+)$/.exec(line.trim()); if (!match) continue;
    const rest = match[1]; const type = tocTypes.find((name) => rest.startsWith(`${name} `));
    if (!type) { entries.push({ type: "UNKNOWN", schema: null, name: rest }); continue; }
    const words = rest.slice(type.length + 1).split(" ");
    const schema = words.shift(); words.pop();
    entries.push({ type, schema, name: words.join(" ") });
  }
  return { format: header("Format"), createdAt: created ? new Date(`${created[1]}T${created[2]}`) : null, dumpedFrom: header("Dumped from database version"), dumpedBy: header("Dumped by pg_dump version"), entries };
}

/** The keys a schema's objects have in an archive's table of contents, derived from a schema capture. */
export function expectedEntries(capture, schema) {
  const inSchema = (id) => id.startsWith(`${schema}.`); const local = (id) => id.slice(schema.length + 1);
  const keys = new Set();
  const constraintNames = new Set();
  for (const item of capture.objects.constraints) {
    if (!inSchema(item.id)) continue; const type = item.definition.type;
    const [table, ...name] = local(item.id).split(".");
    if (["p", "u", "x"].includes(type)) { keys.add(`CONSTRAINT ${table} ${name.join(".")}`); constraintNames.add(name.join(".")); }
    if (type === "f") keys.add(`FK CONSTRAINT ${table} ${name.join(".")}`);
  }
  for (const item of capture.objects.tables) if (inSchema(item.id)) { keys.add(`TABLE ${local(item.id)}`); keys.add(`TABLE DATA ${local(item.id)}`); if (item.definition.rls) keys.add(`ROW SECURITY ${local(item.id)}`); }
  for (const item of capture.objects.views) if (inSchema(item.id)) keys.add(`${item.definition.kind === "m" ? "MATERIALIZED VIEW" : "VIEW"} ${local(item.id)}`);
  for (const item of capture.objects.functions) if (inSchema(item.id)) keys.add(`${{ p: "PROCEDURE", a: "AGGREGATE" }[item.definition.kind] ?? "FUNCTION"} ${local(item.id).split("(")[0]}`);
  for (const item of capture.objects.types) if (inSchema(item.id)) keys.add(`${item.definition.kind === "d" ? "DOMAIN" : "TYPE"} ${local(item.id)}`);
  for (const item of capture.objects.sequences) if (inSchema(item.id)) keys.add(`SEQUENCE ${local(item.id)}`);
  for (const item of capture.objects.indexes) if (inSchema(item.id) && !constraintNames.has(local(item.id))) keys.add(`INDEX ${local(item.id)}`);
  for (const item of capture.objects.policies) if (inSchema(item.id)) keys.add(`POLICY ${local(item.id).replace(".", " ")}`);
  for (const item of capture.objects.triggers) if (inSchema(item.id)) keys.add(`TRIGGER ${local(item.id).replace(".", " ")}`);
  return keys;
}
/** The same keys, read from an archive. Functions are keyed by name: the archive writes their arguments differently. */
export function archiveEntries(toc, schema) {
  const keys = new Set();
  for (const entry of toc.entries) {
    if (entry.schema !== schema) continue;
    if (["TABLE", "TABLE DATA", "VIEW", "MATERIALIZED VIEW", "TYPE", "DOMAIN", "SEQUENCE", "INDEX", "ROW SECURITY"].includes(entry.type)) keys.add(`${entry.type} ${entry.name}`);
    else if (["FUNCTION", "PROCEDURE", "AGGREGATE"].includes(entry.type)) keys.add(`${entry.type} ${entry.name.split("(")[0]}`);
    else if (["CONSTRAINT", "FK CONSTRAINT", "POLICY", "TRIGGER"].includes(entry.type)) keys.add(`${entry.type} ${entry.name}`);
  }
  return keys;
}

/** pg_restore, from BELLIS_PG_RESTORE, the newest PostgreSQL in Program Files, or the PATH. */
export function findPgRestore(environment = process.env) {
  if (environment.BELLIS_PG_RESTORE) return environment.BELLIS_PG_RESTORE;
  const base = "C:\\Program Files\\PostgreSQL";
  if (existsSync(base)) { const versions = readdirSync(base).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a)); for (const version of versions) { const path = join(base, version, "bin", "pg_restore.exe"); if (existsSync(path)) return path; } }
  return "pg_restore";
}
/** Runs `pg_restore --list` without a shell. Returns { code, stdout }; stderr is never shown. */
export function defaultListToc(environment = process.env) {
  const program = findPgRestore(environment);
  return (file) => { const result = spawnSync(program, ["--list", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }); return { code: result.status ?? 1, stdout: result.stdout ?? "", missing: result.error?.code === "ENOENT" }; };
}

/** The newest backup of `schema` for `release` in `dir`, by the time in its name. Null when there is none. */
export function findBackup(dir, schema, release) {
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).map((name) => ({ name, parsed: parseBackupName(name) })).filter((item) => item.parsed?.schema === schema && item.parsed.release === release).sort((a, b) => b.parsed.time - a.parsed.time);
  return found.length ? join(dir, found[0].name) : null;
}
/** The newest other backup of the same schema made before `file` (by modification time), any naming. */
export function previousBackup(file, schema) {
  const dir = resolve(file, ".."); const mine = statSync(file).mtimeMs;
  const others = readdirSync(dir).filter((name) => name.startsWith(`bellis-prod-${schema}-`) && name.endsWith(".dump") && name !== basename(file))
    .map((name) => ({ path: join(dir, name), stat: statSync(join(dir, name)) })).filter((item) => item.stat.isFile() && item.stat.mtimeMs < mine).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return others[0] ? { file: basename(others[0].path), size: others[0].stat.size } : null;
}
const fileHash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const insideRepository = (root, path) => { const inside = relative(resolve(root), resolve(path)); return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)); };

/**
 * Checks one backup. Returns { schema, status, file, problems, notes, metadata }:
 *   status "PASS", "REQUIRED" (there is no backup to check: a person has to make it), "HUMAN" (it may be fine, but a
 *   person has to look: its size), or "FAIL".
 * `base` is the schema production has (schema-base of the release); `expected`, if the release has migrations, is
 * what it will have after them.
 */
export function validateBackup({ schema, release, file, base, expected = null, root, listToc, now = () => new Date(), maxAgeHours = defaults.maxAgeHours }) {
  const result = (status, problems = [], notes = [], metadata = null) => ({ schema, status, file: file ? basename(file) : null, problems, notes, metadata });
  if (!backupSchemas.includes(schema)) throw new PreconditionError(`A backup is of public or private, not ${schema}.`);
  if (!file || !existsSync(file)) return result("REQUIRED", [`no backup of ${schema} for ${release}${file ? ` at ${basename(file)}` : ""}`]);
  if (root && insideRepository(root, file)) return result("FAIL", ["the backup is inside the repository: backups never go there"]);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size === 0) return result("FAIL", ["the file is empty"]);
  const problems = [], notes = [];
  const named = parseBackupName(basename(file));
  if (!named) problems.push(`the name is not bellis-prod-${schema}-YYYYMMDD-HHMM-pre-${release}.dump`);
  else { if (named.schema !== schema) problems.push(`the name says ${named.schema}, this is the ${schema} backup`); if (named.release !== release) problems.push(`the name is for release ${named.release}, not ${release}`); }
  const listed = listToc(file);
  if (listed.missing) return result("FAIL", ["pg_restore was not found (set BELLIS_PG_RESTORE)"]);
  if (listed.code !== 0) return result("FAIL", ["pg_restore cannot read it: the archive is damaged or not an archive"]);
  const toc = parseToc(listed.stdout);
  if (toc.format !== "CUSTOM") problems.push(`the format is ${toc.format ?? "unknown"}, not custom (pg_dump --format=custom)`);
  if (!toc.createdAt || Number.isNaN(toc.createdAt.getTime())) problems.push("the archive does not say when it was made");
  else {
    const hours = (now().getTime() - toc.createdAt.getTime()) / 3_600_000;
    if (hours > maxAgeHours) problems.push(`it is ${hours.toFixed(1)} hours old; at most ${maxAgeHours} are accepted`);
    if (hours < -0.1) problems.push("it says it was made in the future");
    if (named && Math.abs(named.time.getTime() - toc.createdAt.getTime()) > defaults.nameSkewHours * 3_600_000) problems.push("the time in its name does not match the time inside the archive");
  }
  // Only its own schema.
  const foreign = [...new Set(toc.entries.filter((entry) => entry.schema && entry.schema !== "-" && entry.schema !== schema).map((entry) => entry.schema))];
  const otherSchemas = toc.entries.filter((entry) => entry.type === "SCHEMA" && entry.name !== schema).map((entry) => entry.name);
  if (foreign.length || otherSchemas.length) problems.push(`it holds other schemas: ${[...new Set([...foreign, ...otherSchemas])].join(", ")}`);
  if (!toc.entries.some((entry) => entry.type === "SCHEMA" && entry.name === schema) && !toc.entries.some((entry) => entry.schema === schema)) problems.push(`it does not hold the schema ${schema}`);
  if (toc.entries.some((entry) => entry.type === "UNKNOWN")) notes.push(`${toc.entries.filter((entry) => entry.type === "UNKNOWN").length} entry(ies) of a kind this check does not read`);
  // Exactly production's objects: nothing missing, nothing that only the release creates, nothing else.
  let missing = [], pendingPresent = [], unexpected = [];
  if (!base) return result("HUMAN", [...problems, "there is no capture of production's schema for this release to check the backup against (run bellis:staging first)"], notes);
  const want = expectedEntries(base, schema); const have = archiveEntries(toc, schema);
  const pendingOnly = expected ? new Set([...expectedEntries(expected, schema)].filter((key) => !want.has(key))) : new Set();
  missing = [...want].filter((key) => !have.has(key)).sort();
  for (const key of [...have].filter((item) => !want.has(item)).sort()) (pendingOnly.has(key) ? pendingPresent : unexpected).push(key);
  if (missing.length) problems.push(`${missing.length} object(s) production has are missing: ${missing.slice(0, 6).join("; ")}${missing.length > 6 ? "…" : ""}`);
  if (pendingPresent.length) problems.push(`${pendingPresent.length} object(s) that only the release's migrations create are already in it: ${pendingPresent.slice(0, 6).join("; ")} — it was made after the release, not before`);
  if (unexpected.length) problems.push(`${unexpected.length} object(s) production does not have: ${unexpected.slice(0, 6).join("; ")}`);
  const metadata = { file: basename(file), size: stat.size, sha256: fileHash(file), archiveCreatedAt: toc.createdAt && !Number.isNaN(toc.createdAt.getTime()) ? toc.createdAt.toISOString() : null,
    dumpedFrom: toc.dumpedFrom, dumpedBy: toc.dumpedBy, entries: toc.entries.length, objectsChecked: want.size };
  if (problems.length) return result("FAIL", problems, notes, metadata);
  // Size: compared with the previous backup of the same schema; a warning a person has to look at, never the only proof.
  const previous = previousBackup(file, schema);
  if (!previous) notes.push(`no previous ${schema} backup to compare its size with; its contents were checked`);
  else {
    const ratio = stat.size / previous.size; metadata.previous = previous;
    notes.push(`size ${stat.size} bytes, ${Math.round(ratio * 100)}% of ${previous.file}`);
    if (ratio < defaults.smallerThan || ratio > defaults.largerThan) return result("HUMAN", [`its size is ${Math.round(ratio * 100)}% of the previous ${schema} backup: a person has to look at it before it is trusted`], notes, metadata);
  }
  notes.push(`${want.size} object(s) of production found, none missing, nothing extra`);
  return result("PASS", [], notes, metadata);
}

/** Both backups of a release. `paths` can name the files explicitly; otherwise the newest of each is used. */
export function validateBackups({ release, base, expected, root, dir, paths = {}, listToc, now, maxAgeHours }) {
  return Object.fromEntries(backupSchemas.map((schema) => [schema, validateBackup({ schema, release, file: paths[schema] ? resolve(paths[schema]) : findBackup(dir, schema, release), base, expected, root, listToc, now, maxAgeHours })]));
}
/** The lines a report shows for one backup. */
export function backupLines(check) {
  return [check.file ? `file: ${check.file}` : null, ...check.problems.map((line) => redact(line, 300)), ...check.notes.map((line) => redact(line, 300)), check.metadata?.archiveCreatedAt ? `made at ${check.metadata.archiveCreatedAt}` : null];
}
