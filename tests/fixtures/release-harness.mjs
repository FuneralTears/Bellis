/**
 * Shared by the tests of the release tooling: a temporary working directory with a fake Supabase CLI wired to it,
 * and temporary git repositories. Nothing here reaches Supabase or any network.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSupabase } from "../../scripts/release/lib/supabase.mjs";
import { environments } from "../../scripts/release/lib/target.mjs";

export const fakeCliPath = join(dirname(fileURLToPath(import.meta.url)), "fake-supabase.mjs");
export const refs = { staging: environments.staging.ref, production: environments.production.ref };
/** Strings the fake CLI prints and that must never appear in anything the tooling returns, shows or stores. */
export const forbidden = ["hunter2", "hunter2-secret", "eyJhbGciOi", "sb_secret_never_show_this", "postgres://"];

/** A scratch folder, removed when the test ends. */
export function scratch(t, prefix = "bellis-release-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A fake CLI in its own folder, linked to `linked` to begin with. Returns the wrapper the tooling uses (pointed at
 * the fake program), plus `state()` to read what the fake saw and `set()` to change how it behaves.
 */
export function fakeCli(t, { linked = refs.staging, ...behaviour } = {}) {
  const workdir = scratch(t); const file = join(workdir, "fake-state.json");
  const initial = { workdir, linked, projects: [{ ref: refs.staging, name: "Bellis Staging" }, { ref: refs.production, name: "Bellis" }], log: [], ...behaviour };
  writeFileSync(file, JSON.stringify(initial));
  if (linked) { mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true }); writeFileSync(join(workdir, "supabase", ".temp", "project-ref"), linked); }
  const environment = { ...process.env, FAKE_SUPABASE_STATE: file, SUPABASE_PROJECT_ID: "" };
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  return { workdir, file, environment, command: [process.execPath, fakeCliPath],
    supabase: createSupabase({ cwd: workdir, command: [process.execPath, fakeCliPath], environment }),
    state: read,
    set(changes) { writeFileSync(file, JSON.stringify({ ...read(), ...changes })); },
    /** What the CLI's own file says right now. */
    linkedFile() { try { return readFileSync(join(workdir, "supabase", ".temp", "project-ref"), "utf8").trim(); } catch { return null; } },
    /** The commands the fake received, in order, as "link staging" / "link production" / "projects list". */
    calls() { return read().log.map((entry) => entry.replace(/^link --project-ref (\S+)$/, (_, ref) => `link ${ref === refs.staging ? "staging" : ref === refs.production ? "production" : ref}`)); } };
}

/** A git repository in a scratch folder with one commit on `main`. */
export function gitRepo(t, { ignoreLinkState = true } = {}) {
  const dir = scratch(t, "bellis-git-");
  const git = (...args) => { const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" }); if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`); return result.stdout.trim(); };
  git("init", "-q", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test"); git("config", "commit.gpgsign", "false"); git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "test\n");
  if (ignoreLinkState) writeFileSync(join(dir, ".gitignore"), "supabase/.temp/\n");
  git("add", "-A"); git("commit", "-q", "-m", "first");
  return { dir, git, write(path, content = "x\n") { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); },
    commit(message = "next") { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); } };
}
