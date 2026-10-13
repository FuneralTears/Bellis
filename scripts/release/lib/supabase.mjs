/**
 * Release tooling: the only place that runs the Supabase CLI.
 * Two rules. It is run without a shell, as a program with a list of arguments, so nothing is interpreted on the
 * way. And its output is never printed: each call parses what it needs and returns only named fields. When a call
 * fails, the reason is one redacted line.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PreconditionError, redact } from "./report.mjs";

const refPattern = /^[a-z0-9]{20}$/;

/**
 * Where the CLI is. It is not a dependency of the project today: it runs from the npx cache. Looked for, in order:
 * BELLIS_SUPABASE_CLI (a path, set by hand), the project's node_modules, the npx cache (the newest copy).
 * Returns the command as a list: a .js entry is run with this same Node.
 */
export function resolveCli({ root, environment = process.env } = {}) {
  const asCommand = (path, source) => ({ command: /\.(c|m)?js$/i.test(path) ? [process.execPath, path] : [path], source, path });
  const override = environment.BELLIS_SUPABASE_CLI;
  if (override) {
    if (!existsSync(override)) throw new PreconditionError(`BELLIS_SUPABASE_CLI points to a file that does not exist.`);
    return asCommand(override, "BELLIS_SUPABASE_CLI");
  }
  const inProject = ["dist/supabase.js", "bin/supabase.exe", "bin/supabase"].map((entry) => join(root ?? process.cwd(), "node_modules", "supabase", entry)).find(existsSync);
  if (inProject) return asCommand(inProject, "node_modules");
  const cache = join(environment.npm_config_cache || environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, "npm-cache") || join(homedir(), ".npm"), "_npx");
  if (existsSync(cache)) {
    const found = readdirSync(cache).flatMap((entry) => ["dist/supabase.js", "bin/supabase.exe", "bin/supabase"].map((file) => join(cache, entry, "node_modules", "supabase", file)).filter(existsSync).slice(0, 1))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (found.length) return asCommand(found[0], "npx cache");
  }
  throw new PreconditionError("The Supabase CLI was not found. Run it once with npx, or set BELLIS_SUPABASE_CLI to its path.");
}

/** The JSON document in what a command printed. Lines before it (progress messages) are ignored. */
function parseJson(stdout) {
  const text = String(stdout ?? ""); const start = text.search(/[{[]/);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

/**
 * A handle on the CLI for one working directory. `command` and `environment` can be replaced in tests by a fake
 * program; nothing here knows the difference.
 */
export function createSupabase({ cwd = process.cwd(), command, environment = process.env, timeoutMs = 120_000 } = {}) {
  const cli = command ? { command, source: "given" } : resolveCli({ root: cwd, environment });
  // Raw result of one run. Stays inside this module: callers get parsed fields, never stdout or stderr.
  function run(args, timeout = timeoutMs) {
    const result = spawnSync(cli.command[0], [...cli.command.slice(1), ...args], { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
    const timedOut = result.error?.code === "ETIMEDOUT";
    return { code: result.status ?? (timedOut ? 124 : 1), stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut, spawnError: result.error && !timedOut ? result.error.code ?? "spawn failed" : null };
  }
  /** One short, redacted line saying why a call failed. Never the output itself. */
  function reason(result) {
    if (result.spawnError) return `the CLI could not be started (${result.spawnError})`;
    if (result.timedOut) return "the CLI did not answer in time";
    const last = String(result.stderr || result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? "";
    return redact(`exit ${result.code}${last ? `: ${last}` : ""}`, 200);
  }
  return {
    source: cli.source,
    /** The project the CLI is linked to, read from its own file. Null when there is none or it is not a ref. */
    linkedRef() {
      try { const value = readFileSync(join(cwd, "supabase", ".temp", "project-ref"), "utf8").trim(); return refPattern.test(value) ? value : null; } catch { return null; }
    },
    /** Links the CLI to a project. Says whether it worked; shows nothing of what the CLI printed. */
    link(ref) {
      if (!refPattern.test(String(ref))) return { ok: false, reason: "not a project ref" };
      const result = run(["link", "--project-ref", ref]);
      return result.code === 0 ? { ok: true } : { ok: false, reason: reason(result) };
    },
    /** The projects of the account: ref, name, status and which one is linked. Any other field is dropped. */
    projects() {
      const result = run(["projects", "list"]);
      if (result.code !== 0) return { ok: false, reason: reason(result), projects: [] };
      const parsed = parseJson(result.stdout); const list = Array.isArray(parsed) ? parsed : parsed?.projects;
      if (!Array.isArray(list)) return { ok: false, reason: "the list of projects could not be read", projects: [] };
      return { ok: true, projects: list.map((item) => ({ ref: String(item?.ref ?? item?.id ?? ""), name: String(item?.name ?? ""), status: String(item?.status ?? ""), linked: item?.linked === true })) };
    },
    /**
     * Runs the SQL of a file against the linked project and returns the last result set, reduced to the columns
     * asked for (as text, or null). Nothing else of the answer comes back. A SQL error is one redacted line with
     * its code and its message.
     */
    query(file, { columns = [], timeoutMs: limit = timeoutMs } = {}) {
      const result = run(["db", "query", "--linked", "--output-format", "json", "-f", file], limit);
      const parsed = parseJson(result.stdout);
      if (result.code !== 0 || !parsed || parsed._tag === "Error" || parsed.error) {
        const message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
        const sql = /ERROR:\s+([A-Z0-9]{5}):\s*([^\\\n"]*)/.exec(message);
        if (sql) return { ok: false, reason: redact(`SQL error ${sql[1]}: ${sql[2]}`, 240) };
        if (result.code === 0 && !parsed) return { ok: false, reason: "the answer could not be read" };
        return { ok: false, reason: message && !result.spawnError && !result.timedOut ? redact(`exit ${result.code}: ${message}`, 240) : reason(result) };
      }
      if (!Array.isArray(parsed.rows)) return { ok: false, reason: "the answer has no rows" };
      const text = (value) => (value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value));
      return { ok: true, rows: parsed.rows.map((row) => Object.fromEntries(columns.map((column) => [column, text(row?.[column])]))) };
    },
    /** The CLI's version. Local: no request is sent. */
    version() {
      const result = run(["--version"]);
      const match = /\d+\.\d+\.\d+/.exec(result.stdout);
      return result.code === 0 && match ? { ok: true, version: match[0] } : { ok: false, reason: reason(result) };
    },
  };
}
