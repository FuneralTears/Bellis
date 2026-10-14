/**
 * Release tooling: captures the schema of the project the CLI is linked to, as a document that can be compared.
 *
 * The SQL is scripts/release/drift/schema.sql: a read-only transaction that reads PostgreSQL's catalogs. What comes
 * back is turned into objects grouped by category. Each object keeps:
 *   - `hash` and `parts`: SHA-256 of its normalized definition, whole and attribute by attribute. They are computed
 *     from what the database said, before anything is redacted, so a difference is never hidden;
 *   - `definition`: the same attributes with anything that looks like a credential removed. This is only for
 *     showing; it is never what is compared.
 *
 * What is normalized, and nothing else:
 *   1. line endings: CRLF and CR become LF, everywhere (a file applied from a Windows checkout differs only in this);
 *   2. in function bodies, view definitions and cron commands: any run of whitespace in code, line breaks included,
 *      becomes one space, and there is none at the start or the end. Quoted strings, quoted names, dollar-quoted
 *      text and comments are kept exactly as they are (a -- comment loses only the spaces at its end, and keeps the
 *      line break that ends it);
 *   3. lists that have no order of their own are sorted: grants, the roles of a policy, the settings of a function,
 *      the options of a table or a view;
 *   4. names: the capture runs with an empty search path, so PostgreSQL writes every name in full (schema.name).
 * Not normalized, because they mean something: the order of a table's columns, the order of an enum's values, the
 * letter case of anything, the text of comments, and everything PostgreSQL prints itself (constraints, indexes,
 * policies, triggers, defaults), which is already canonical.
 *
 * Capturing never links the CLI: it has to be on the environment asked for already.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CheckFailed, redact, scrub } from "../lib/report.mjs";
import { confirmTarget, environments } from "../lib/target.mjs";
import { statements, validateSmokeSql } from "../smoke/sql.mjs";

export const schemaFormat = "bellis_schema";
export const schemaFormatVersion = 1;
export const sqlMarker = "Bellis schema capture";
const here = dirname(fileURLToPath(import.meta.url));
export const schemaSql = () => readFileSync(join(here, "schema.sql"), "utf8").replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value ?? null));

/**
 * The categories of a capture: which attributes are code (normalized as code), which are lists without an order of
 * their own (sorted), and which are information that is shown and not compared.
 */
export const categories = Object.freeze({
  schemas: { sorted: ["grants"] },
  tables: { sorted: ["grants", "options"], nested: { columns: { sorted: ["grants"] } } },
  constraints: {},
  indexes: {},
  policies: { sorted: ["roles"] },
  functions: { code: ["body", "sql_body"], sorted: ["grants", "config"] },
  views: { code: ["definition"], sorted: ["grants", "options"] },
  triggers: {},
  types: {},
  sequences: { sorted: ["grants"] },
  default_privileges: { sorted: ["grants"] },
  extensions: { info: ["info_version"] },
  cron: { code: ["command"] },
});
export const warningCodes = Object.freeze(["unknown_schema", "other_cron_jobs", "server_version"]);

const lineEndings = (text) => text.replace(/\r\n?/g, "\n");
/**
 * Code with the whitespace that means nothing taken out (see the top of this file). It walks the text knowing when
 * it is inside a string, a quoted name, a dollar-quoted text or a comment, and leaves those alone. If something is
 * left open it stops normalizing and returns the text with only its line endings fixed: in doubt, less is changed.
 */
export function normalizeCode(input) {
  const text = lineEndings(String(input ?? "")); const out = []; let i = 0; const n = text.length; let code = "";
  const flush = () => { out.push({ code }); code = ""; };
  const keep = (end) => { flush(); out.push({ kept: text.slice(i, end) }); i = end; };
  while (i < n) {
    const c = text[i], d = text[i + 1];
    // A comment is kept as written, except for spaces at its very end.
    if (c === "-" && d === "-") { const end = text.indexOf("\n", i) < 0 ? n : text.indexOf("\n", i); flush(); out.push({ kept: text.slice(i, end).replace(/[ \t]+$/, ""), comment: true }); i = end; continue; }
    if (c === "/" && d === "*") { const end = text.indexOf("*/", i + 2); if (end < 0) return text; keep(end + 2); continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; const escapes = c === "'" && /(^|[^A-Za-z0-9_$])[eE]$/.test(text.slice(Math.max(0, i - 2), i));
      for (;;) { if (j >= n) return text; if (escapes && text[j] === "\\") { j += 2; continue; } if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; } j++; }
      keep(j + 1); continue;
    }
    if (c === "$" && !/[A-Za-z0-9_$]/.test(text[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 80))?.[0];
      if (tag) { const end = text.indexOf(tag, i + tag.length); if (end < 0) return text; keep(end + tag.length); continue; }
    }
    code += c; i++;
  }
  flush();
  // Inside code: one space for any run of spaces and tabs, nothing around line breaks, no blank lines.
  // In code, any run of whitespace (line breaks included) is one space. A -- comment ends its line, so a line break
  // is written after it; everything that was kept goes back exactly as it was.
  let result = "";
  out.forEach((piece, index) => {
    if (piece.kept !== undefined) { result += piece.kept; if (piece.comment) result += "\n"; return; }
    let segment = piece.code.replace(/\s+/g, " ");
    if (index === 0 || out[index - 1]?.comment) segment = segment.replace(/^ /, "");
    result += segment;
  });
  return result.trimEnd();
}

const sortedList = (value) => (Array.isArray(value) ? [...value].map((item) => (typeof item === "string" ? lineEndings(item) : item)).sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0)) : value);
function normalizeValue(value, key, rules) {
  if (rules.code?.includes(key)) return value === null || value === undefined ? null : normalizeCode(value);
  if (rules.sorted?.includes(key)) return sortedList(value);
  if (rules.nested?.[key] && Array.isArray(value)) return value.map((item) => normalizeObject(item, rules.nested[key]));
  if (typeof value === "string") return lineEndings(value);
  return value ?? null;
}
function normalizeObject(object, rules) { return Object.fromEntries(Object.keys(object).sort().map((key) => [key, normalizeValue(object[key], key, rules)])); }
const scrubValue = (value) => (typeof value === "string" ? scrub(value) : Array.isArray(value) ? value.map(scrubValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item)])) : value);

const refuse = (message, details = []) => new CheckFailed(message, { stage: "schema capture", details: details.slice(0, 20) });
const idPattern = /^[^\u0000-\u001f]{1,400}$/;

/**
 * Turns the database's answer into a capture. Throws when the answer is not what was asked for: a category missing,
 * an object without a name, or the same object twice.
 */
export function buildCapture(answer, meta) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw refuse("The database's answer is not a schema.");
  const problems = [], warnings = [], objects = {}, counts = {};
  for (const [category, rules] of Object.entries(categories)) {
    const list = answer[category];
    if (!Array.isArray(list)) { problems.push(`${category}: missing from the answer`); continue; }
    const seen = new Set(); objects[category] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !idPattern.test(raw.id)) { problems.push(`${category}: an object has no usable name`); continue; }
      if (seen.has(raw.id)) { problems.push(`${category}: ${redact(raw.id, 120)} appears twice`); continue; } seen.add(raw.id);
      const { id, ...rest } = raw; const normalized = normalizeObject(rest, rules);
      const compared = Object.fromEntries(Object.entries(normalized).filter(([key]) => !rules.info?.includes(key)));
      objects[category].push({ id, hash: sha256(canonical(compared)), parts: Object.fromEntries(Object.entries(compared).map(([key, value]) => [key, sha256(canonical(value))])), definition: scrubValue(normalized) });
    }
    objects[category].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); counts[category] = objects[category].length;
  }
  for (const item of objects.schemas ?? []) if (item.definition.unknown === true) warnings.push({ code: "unknown_schema", object: item.id });
  if (Number(answer.other_cron_jobs) > 0) warnings.push({ code: "other_cron_jobs", object: String(Number(answer.other_cron_jobs)) });
  if (!Array.isArray(answer.applied_migrations) || answer.applied_migrations.some((version) => !/^\d{14}$/.test(String(version)))) problems.push("the list of applied migrations could not be read");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(answer.database_time))) problems.push("the database's time could not be read");
  if (problems.length) throw refuse("The schema could not be captured with certainty.", problems);
  const capture = { format: schemaFormat, formatVersion: schemaFormatVersion,
    meta: { environment: meta.environment, ref: environments[meta.environment].ref, capturedAt: meta.capturedAt, databaseTime: answer.database_time, gitCommit: meta.gitCommit ?? null, release: meta.release ?? null, label: meta.label,
      serverVersion: /^\d{5,6}$/.test(String(answer.server_version)) ? String(answer.server_version) : null, rehearsed: meta.rehearsed ?? [] },
    counts, appliedMigrations: answer.applied_migrations.map(String), objects, warnings };
  const wrong = captureProblems(capture);
  if (wrong.length) throw refuse("The schema capture is not valid.", wrong);
  return capture;
}

/** Everything wrong with a capture document, as a list. Checked before it is written and when it is read back. */
export function captureProblems(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["the capture is not a document"];
  const problems = []; const hash = /^[0-9a-f]{64}$/;
  if (document.format !== schemaFormat) problems.push("format: is not a Bellis schema capture");
  if (document.formatVersion !== schemaFormatVersion) problems.push("formatVersion: is not a version this tool reads");
  const meta = document.meta ?? {};
  if (!Object.hasOwn(environments, meta.environment ?? "") || environments[meta.environment].ref !== meta.ref) problems.push("meta.environment: is not staging or production with its own ref");
  for (const field of ["capturedAt", "databaseTime"]) if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(meta[field]))) problems.push(`meta.${field}: is not a time`);
  if (meta.gitCommit !== null && !/^[0-9a-f]{40}$/.test(String(meta.gitCommit))) problems.push("meta.gitCommit: is not a commit");
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(String(meta.label))) problems.push("meta.label: is not a label");
  if (!Array.isArray(meta.rehearsed) || meta.rehearsed.some((item) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(String(item?.file)) || !hash.test(String(item?.sha256)))) problems.push("meta.rehearsed: is not a list of migrations with their hashes");
  if (!Array.isArray(document.appliedMigrations) || document.appliedMigrations.some((version) => !/^\d{14}$/.test(String(version)))) problems.push("appliedMigrations: is not a list of versions");
  if (!Array.isArray(document.warnings) || document.warnings.some((warning) => !warningCodes.includes(warning?.code) || typeof warning.object !== "string")) problems.push("warnings: is not a list of known warnings");
  const objects = document.objects ?? {};
  for (const category of Object.keys(objects)) if (!Object.hasOwn(categories, category)) problems.push("objects: has a category this tool does not know");
  for (const category of Object.keys(categories)) {
    const list = objects[category];
    if (!Array.isArray(list)) { problems.push(`objects.${category}: is missing`); continue; }
    const seen = new Set();
    for (const item of list) {
      if (typeof item?.id !== "string" || !idPattern.test(item.id) || !hash.test(String(item.hash)) || !item.parts || typeof item.parts !== "object" || Object.values(item.parts).some((value) => !hash.test(String(value))) || !item.definition || typeof item.definition !== "object") { problems.push(`objects.${category}: has an entry that is not an object of a schema`); break; }
      if (seen.has(item.id)) { problems.push(`objects.${category}: has the same object twice`); break; } seen.add(item.id);
    }
    if (document.counts?.[category] !== list.length) problems.push(`counts.${category}: does not match the objects`);
  }
  return problems;
}

/** The SELECT of schema.sql, without the transaction around it: what a rehearsal runs after the migrations. */
export function schemaSelect(sql = schemaSql()) {
  const list = statements(sql); const select = list.find((statement) => ["with", "select"].includes(statement.tokens[0].value));
  if (!select) throw refuse("schema.sql has no query.");
  return sql.slice(select.start, select.end).replace(/;\s*$/, "");
}

/** Runs one schema query file and parses its answer. `columns` are the ones asked for; `schema` is always one. */
export function readAnswer(supabase, sql, { temporary = tmpdir(), columns = ["schema"] } = {}) {
  const dir = mkdtempSync(join(temporary, "bellis-schema-"));
  try {
    const file = join(dir, "schema.sql"); writeFileSync(file, sql, "utf8");
    const answer = supabase.query(file, { columns, timeoutMs: 300_000 });
    if (!answer.ok) throw refuse("The schema could not be read from the database.", [redact(answer.reason, 240)]);
    if (answer.rows.length !== 1 || typeof answer.rows[0].schema !== "string") throw refuse("The database's answer is not a schema.");
    let parsed; try { parsed = JSON.parse(answer.rows[0].schema); } catch { throw refuse("The database's answer is not a schema."); }
    return { parsed, row: answer.rows[0] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Captures the schema of `target` ("staging" or "production") with a read-only transaction. The CLI has to be
 * there already; it is not linked or moved.
 */
export function captureSchema({ supabase, target = "staging", release = null, label, gitCommit = null, environment = process.env, now = () => new Date(), temporary = tmpdir() }) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(String(label ?? ""))) throw refuse("A schema capture needs a label.");
  const sql = schemaSql();
  const shape = validateSmokeSql(sql); const opening = statements(sql)[0]?.tokens.map((token) => token.value).join(" ") ?? "";
  if (!shape.ok || !/\bread only$/.test(opening) || !sql.includes(sqlMarker)) throw refuse("schema.sql is not a read-only transaction that is rolled back.", shape.problems);
  confirmTarget(supabase, target, { environment });
  const { parsed } = readAnswer(supabase, sql, { temporary });
  if (supabase.linkedRef() !== environments[target].ref) throw refuse("The CLI moved while the schema was being captured.");
  return buildCapture(parsed, { environment: target, release, label, gitCommit, capturedAt: now().toISOString().replace(/\.\d+Z$/, "Z") });
}
