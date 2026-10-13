/**
 * Release tooling: reading a SQL smoke well enough to know what it does to its transaction, before it is sent
 * anywhere. Not a SQL parser: a tokenizer that tells code apart from the four places where a word like COMMIT is
 * only text (a -- comment, a block comment, a quoted string and a dollar-quoted body), and a statement splitter on top of it.
 *
 * A smoke is accepted only when it is one transaction that is undone: BEGIN is its first statement, there is no
 * other transaction control anywhere, and a plain ROLLBACK is its last statement. Whatever cannot be read with
 * certainty (an unterminated string, an unknown shape) is refused: the doubt never runs.
 *
 * COMMIT inside a dollar-quoted body is allowed on purpose: inside a transaction block PostgreSQL refuses to end
 * the transaction from a DO block or a procedure, so that text cannot commit anything. The runner also checks
 * afterwards, with the transaction id, that each one was really rolled back.
 */

export class SqlError extends Error {}
const idStart = /[A-Za-z_\u0080-￿]/, idPart = /[A-Za-z0-9_$\u0080-￿]/;
const dollarTag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
const lineOf = (sql, index) => sql.slice(0, index).split("\n").length;

/**
 * The tokens of a piece of SQL, comments dropped: { type: "word" | "string" | "identifier" | "dollar" | "number" |
 * "punct", value, start, end }. Words are lowercased; a dollar token carries its `body`. Throws SqlError for
 * anything left open.
 */
export function tokenize(input) {
  const sql = String(input ?? "").replace(/^﻿/, ""); const tokens = []; const n = sql.length; let i = 0;
  const quoted = (start, quote, escapes) => {
    let j = start + 1;
    while (j < n) {
      if (escapes && sql[j] === "\\") { j += 2; continue; }
      if (sql[j] === quote) { if (sql[j + 1] === quote) { j += 2; continue; } return j + 1; }
      j++;
    }
    throw new SqlError(`a ${quote === "'" ? "string" : "quoted identifier"} opened on line ${lineOf(sql, start)} is never closed`);
  };
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && d === "-") { const end = sql.indexOf("\n", i); i = end < 0 ? n : end + 1; continue; }
    if (c === "/" && d === "*") {
      let depth = 1, j = i + 2;
      while (j < n && depth) { if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; } else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; } else j++; }
      if (depth) throw new SqlError(`a comment opened on line ${lineOf(sql, i)} is never closed`);
      i = j; continue;
    }
    if (c === "'") { const end = quoted(i, "'", false); tokens.push({ type: "string", value: sql.slice(i, end), start: i, end }); i = end; continue; }
    if (c === '"') { const end = quoted(i, '"', false); tokens.push({ type: "identifier", value: sql.slice(i, end), start: i, end }); i = end; continue; }
    if (c === "$") {
      const tag = dollarTag.exec(sql.slice(i, i + 80))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) throw new SqlError(`a dollar-quoted body (${tag}) opened on line ${lineOf(sql, i)} is never closed`);
        tokens.push({ type: "dollar", value: tag, body: sql.slice(i + tag.length, close), start: i, end: close + tag.length }); i = close + tag.length; continue;
      }
      tokens.push({ type: "punct", value: c, start: i, end: i + 1 }); i++; continue;
    }
    if (idStart.test(c)) {
      let j = i + 1; while (j < n && idPart.test(sql[j])) j++;
      const word = sql.slice(i, j).toLowerCase();
      // E'..' (with backslash escapes), and B'..', X'..', N'..': the letter belongs to the string.
      if (sql[j] === "'" && /^[ebxn]$/.test(word)) { const end = quoted(j, "'", word === "e"); tokens.push({ type: "string", value: sql.slice(i, end), start: i, end }); i = end; continue; }
      tokens.push({ type: "word", value: word, start: i, end: j }); i = j; continue;
    }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++; tokens.push({ type: "number", value: sql.slice(i, j), start: i, end: j }); i = j; continue; }
    tokens.push({ type: "punct", value: c, start: i, end: i + 1 }); i++;
  }
  return tokens;
}

/** The statements of a piece of SQL: each one its tokens, where it starts and where it ends (after its ";"). */
export function statements(input) {
  const out = []; let current = [];
  for (const token of tokenize(input)) {
    if (token.type === "punct" && token.value === ";") { if (current.length) out.push({ tokens: current, start: current[0].start, end: token.end }); current = []; }
    else current.push(token);
  }
  if (current.length) out.push({ tokens: current, start: current[0].start, end: current.at(-1).end });
  return out;
}

/**
 * What a statement does to the transaction, or null when it does nothing to it: "begin", "commit", "rollback" (a
 * plain one, the kind that ends a smoke) or "other" (savepoints, ROLLBACK TO, prepared transactions, AND CHAIN).
 */
export function transactionControl(statement) {
  const words = []; for (const token of statement.tokens) { if (token.type !== "word") break; words.push(token.value); }
  const [first, second] = words; const alone = statement.tokens.length === words.length;
  if (first === "begin" || (first === "start" && second === "transaction")) return "begin";
  if (first === "commit" || first === "end" || (first === "prepare" && second === "transaction")) return "commit";
  if (first === "rollback" || first === "abort") return alone && (words.length === 1 || (words.length === 2 && ["transaction", "work"].includes(second))) ? "rollback" : "other";
  if (first === "savepoint" || first === "release") return "other";
  return null;
}
const describe = (sql, statement) => `line ${lineOf(sql, statement.start)}`;

/** Extra static checks a smoke can ask for in the manifest (its "checks"). */
export const smokeChecks = Object.freeze({
  /**
   * The smoke compares against a workspace's local day, so it must not take "today" from the server, whose day
   * is UTC: between 21:00 and midnight in Argentina the two differ and the smoke would fail by the hour.
   */
  "workspace-clock"(tokens) {
    const problems = []; const banned = ["current_date", "current_time", "localtime", "localtimestamp"];
    const scan = (list) => list.forEach((token, index) => {
      if (token.type === "dollar") { try { scan(tokenize(token.body)); } catch { /* not SQL: nothing to check */ } return; }
      if (token.type !== "word") return;
      if (banned.includes(token.value)) problems.push(`uses ${token.value}: the day has to come from the workspace's time zone`);
      const rest = list.slice(index + 1, index + 6).map((item) => item.value).join("");
      if ((token.value === "now" && rest.startsWith("()::date")) || (token.value === "current_timestamp" && rest.startsWith("::date"))) problems.push(`casts ${token.value} to a date without a time zone: the day has to come from the workspace's time zone`);
    });
    scan(tokens);
    return [...new Set(problems)];
  },
});

/**
 * Whether a smoke is a single transaction that is undone. Returns { ok, problems, head, body }: `head` is the text
 * up to and including BEGIN, `body` what lies between BEGIN and the final ROLLBACK.
 */
export function validateSmokeSql(input, { checks = [] } = {}) {
  const sql = String(input ?? "").replace(/^﻿/, ""); const problems = [];
  let list;
  try { list = statements(sql); } catch (error) { if (!(error instanceof SqlError)) throw error; return { ok: false, problems: [`cannot be read: ${error.message}`], head: "", body: "" }; }
  if (!list.length) return { ok: false, problems: ["is empty"], head: "", body: "" };
  const kinds = list.map(transactionControl);
  const begins = kinds.flatMap((kind, index) => (kind === "begin" ? [index] : []));
  if (begins.length === 0) problems.push("has no BEGIN");
  else if (begins.length > 1) problems.push(`has ${begins.length} BEGIN statements (${begins.map((index) => describe(sql, list[index])).join(", ")})`);
  else if (begins[0] !== 0) problems.push("does not start with BEGIN: statements before it would run outside the transaction");
  kinds.forEach((kind, index) => {
    if (kind === "commit") problems.push(`has a COMMIT (${describe(sql, list[index])})`);
    if (kind === "other") problems.push(`has transaction control that is not supported in a smoke (${describe(sql, list[index])})`);
    if (kind === "rollback" && index !== list.length - 1) problems.push(`has a ROLLBACK before the end (${describe(sql, list[index])}): what follows would run outside the transaction`);
  });
  if (kinds.at(-1) !== "rollback") problems.push("does not end in ROLLBACK");
  for (const name of checks) {
    const check = smokeChecks[name];
    if (!check) problems.push(`asks for an unknown check: ${name}`); else problems.push(...check(list.flatMap((statement) => statement.tokens)));
  }
  if (problems.length) return { ok: false, problems, head: "", body: "" };
  return { ok: true, problems: [], head: sql.slice(0, list[0].end), body: sql.slice(list[0].end, list.at(-1).start) };
}

/** A migration that is going to run inside a smoke's transaction cannot have transaction control of its own. */
export function validateMigrationSql(input) {
  let list;
  try { list = statements(input); } catch (error) { if (!(error instanceof SqlError)) throw error; return { ok: false, problems: [`cannot be read: ${error.message}`] }; }
  if (!list.length) return { ok: false, problems: ["is empty"] };
  const sql = String(input ?? "").replace(/^﻿/, "");
  const problems = list.flatMap((statement) => { const kind = transactionControl(statement); return kind ? [`controls its own transaction (${kind === "other" ? "savepoint or similar" : kind.toUpperCase()}, ${describe(sql, statement)})`] : []; });
  return { ok: problems.length === 0, problems };
}

/**
 * The text that is actually run for a smoke: BEGIN, the pending migrations (if any), the smoke's own statements,
 * the result row and ROLLBACK. `resultRow` is a complete statement written by the runner.
 */
export function composeSmokeSql(validated, { pending = [], resultRow }) {
  if (!validated?.ok) throw new SqlError("only a validated smoke can be composed");
  const migrations = pending.map((item) => `\n-- pending migration: ${item.file}\n${String(item.text).replace(/^﻿/, "")}\n;\n`).join("");
  return `${validated.head}\n${migrations}${validated.body}\n;\n${resultRow}\nrollback;\n`;
}
