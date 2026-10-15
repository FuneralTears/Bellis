/**
 * Release tooling: what a release remembers between commands (a passed precheck, a snapshot, a report).
 * It lives outside the repository, one folder per release: <home>\Bellis-Releases\<release-id>\ by default, or
 * wherever BELLIS_RELEASES_DIR says. Nothing here can be committed by accident, and nothing secret is written:
 * a value or a field name that looks like a credential is refused before the file is touched.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PreconditionError, redact } from "./report.mjs";

const idPattern = /^[a-z0-9][a-z0-9._-]{1,60}$/;
const namePattern = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const secretKey = /pass(word|wd)?|secret|token|authorization|cookie|service_?role|private_?key|connection|dsn|credential|api_?key|publishable/i;
const secretValue = [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, /\bsb_(secret|publishable)_[A-Za-z0-9_-]+/, /\b(sbp|sbs|ghp|gho|github_pat)_[A-Za-z0-9_]{12,}/, /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i];

/** Paths (like "a.b[2].password") of anything in `data` that looks like a credential. Empty when it is clean. */
export function findSecrets(data, path = "") {
  if (data === null || data === undefined) return [];
  if (typeof data === "string") return secretValue.some((pattern) => pattern.test(data)) ? [path || "(value)"] : [];
  if (typeof data !== "object") return [];
  if (Array.isArray(data)) return data.flatMap((item, index) => findSecrets(item, `${path}[${index}]`));
  return Object.entries(data).flatMap(([key, value]) => {
    const here = path ? `${path}.${key}` : key;
    return secretKey.test(key) ? [here] : findSecrets(value, here);
  });
}

export function createState({ root, repository = process.cwd(), environment = process.env, home = homedir(), now = () => new Date() } = {}) {
  const base = resolve(root ?? environment.BELLIS_RELEASES_DIR ?? join(home, "Bellis-Releases"));
  // Runtime state never lives in the repository, whatever the settings say.
  const inside = relative(resolve(repository), base);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) throw new PreconditionError("The release state folder cannot be inside the repository.");
  const dirOf = (releaseId) => {
    if (!idPattern.test(String(releaseId ?? ""))) throw new PreconditionError("A release id uses lowercase letters, digits, dots and dashes (for example h2-8c).");
    return join(base, releaseId);
  };
  const fileOf = (releaseId, name) => {
    if (!namePattern.test(String(name ?? ""))) throw new PreconditionError("A state name uses lowercase letters, digits, dots and dashes.");
    return join(dirOf(releaseId), `${name}.json`);
  };
  return {
    root: base,
    releaseDir: dirOf,
    exists(releaseId) { return existsSync(dirOf(releaseId)); },
    /** Creates the folder of a release (and the root) if they are not there. */
    ensure(releaseId) { const dir = dirOf(releaseId); mkdirSync(dir, { recursive: true }); return dir; },
    /**
     * Saves `data` as <release>/<name>.json. Written to a temporary file and renamed, so a reader never sees half
     * a file and an interrupted save leaves the previous one intact. Refuses anything that looks like a secret.
     */
    save(releaseId, name, data) {
      const found = findSecrets(data);
      if (found.length) throw new PreconditionError("Release state cannot hold credentials.", { details: found.slice(0, 5).map((path) => `refused field: ${redact(path, 80)}`) });
      const file = fileOf(releaseId, name); mkdirSync(dirOf(releaseId), { recursive: true });
      const document = { release: releaseId, name, savedAt: now().toISOString(), data };
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", flag: "wx" }); renameSync(temporary, file); }
      catch (error) { rmSync(temporary, { force: true }); throw new PreconditionError(`Release state could not be saved (${error.code ?? "error"}).`); }
      return file;
    },
    /** What was saved under <name>, with when: { savedAt, data }. Null when there is nothing or it cannot be read. */
    load(releaseId, name) {
      try { const document = JSON.parse(readFileSync(fileOf(releaseId, name), "utf8")); return document && document.release === releaseId && document.name === name ? { savedAt: document.savedAt, data: document.data } : null; }
      catch { return null; }
    },
    /**
     * A file of any release folder (an archived one, say), with the release written inside it: { release, savedAt,
     * data }. Unlike `load`, the folder's name does not have to be the release; the caller checks `release` itself.
     * Read only. Null when there is nothing or it cannot be read.
     */
    read(folder, name) {
      try { const document = JSON.parse(readFileSync(fileOf(folder, name), "utf8")); return document && document.name === name && typeof document.release === "string" ? { release: document.release, savedAt: document.savedAt, data: document.data } : null; }
      catch { return null; }
    },
    /** How old a saved state is, in minutes. Infinity when there is none. */
    ageMinutes(releaseId, name) {
      const found = this.load(releaseId, name); const at = found ? Date.parse(found.savedAt) : NaN;
      return Number.isFinite(at) ? (now().getTime() - at) / 60_000 : Infinity;
    },
  };
}
