/**
 * Release tooling: what the repository looks like, read with local git commands. Nothing here fetches, pushes,
 * commits or moves a branch: it only looks.
 */
import { spawnSync } from "node:child_process";
import { CheckFailed, PreconditionError, redact } from "./report.mjs";

/** The folder the CLI keeps its link in. It must never be committed. */
export const linkStateDir = "supabase/.temp";

export function createGit({ cwd = process.cwd(), run } = {}) {
  const exec = run ?? ((args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", spawnError: result.error?.code ?? null };
  });
  const out = (args) => { const result = exec(args); return result.code === 0 ? result.stdout.trim() : null; };
  const resolve = (name) => out(["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  const git = {
    isRepository() { return out(["rev-parse", "--is-inside-work-tree"]) === "true"; },
    /** The current branch, or null on a detached HEAD. */
    branch() { const name = out(["rev-parse", "--abbrev-ref", "HEAD"]); return name && name !== "HEAD" ? name : null; },
    /** The full commit a name points to, or null when it does not exist. */
    commit(name = "HEAD") { return resolve(name); },
    /** Files changed, staged or untracked (ignored files do not count). Paths only: never their content. */
    changes() {
      const result = exec(["status", "--porcelain=v1", "--untracked-files=all"]);
      if (result.code !== 0) throw new PreconditionError("git status could not be read.", { details: [redact(result.stderr, 200)] });
      return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
    },
    isClean() { return git.changes().length === 0; },
    /** Files of the CLI's link folder that are tracked by git. There must be none. */
    trackedLinkState() { return (out(["ls-files", "--", linkStateDir]) ?? "").split(/\r?\n/).filter(Boolean); },
    /** Whether the link folder is ignored, so it cannot be added by accident. */
    linkStateIgnored() { return exec(["check-ignore", "-q", `${linkStateDir}/project-ref`]).code === 0; },
    isAncestor(ancestor, descendant) { return exec(["merge-base", "--is-ancestor", ancestor, descendant]).code === 0; },
    /** The paths that differ between two commits. Names only. */
    changedFiles(from, to) {
      const result = exec(["diff", "--name-only", "--no-renames", from, to]);
      if (result.code !== 0) throw new PreconditionError("git diff could not be read.", { details: [redact(result.stderr, 200)] });
      return result.stdout.split(/\r?\n/).filter(Boolean);
    },
    /**
     * Whether `branch` could be moved to `target` without a merge: `target` has to descend from it, in a straight
     * line. It only answers the question; nothing is moved.
     */
    canFastForward(branch, target) {
      const from = resolve(branch), to = resolve(target);
      if (!from || !to) return { ok: false, reason: `${!from ? branch : target} does not exist`, commits: 0, merges: 0 };
      if (from === to) return { ok: true, reason: "already there", commits: 0, merges: 0 };
      if (!git.isAncestor(from, to)) return { ok: false, reason: `${target} does not descend from ${branch}`, commits: 0, merges: 0 };
      const commits = Number(out(["rev-list", "--count", `${from}..${to}`]) ?? 0);
      const merges = (out(["rev-list", "--merges", `${from}..${to}`]) ?? "").split(/\r?\n/).filter(Boolean).length;
      return { ok: true, reason: merges ? "contains merge commits" : "straight line", commits, merges };
    },
    /*
     * Remote operations. Only prod-release uses them, to move main forward to a commit that descends from it. There is
     * no force anywhere: the server itself refuses a push that is not a fast-forward.
     */
    /**
     * Fetches origin's main into the local copy of it (refs/remotes/origin/main), so what git status and the reports
     * show is current. `git fetch origin main` alone only fills FETCH_HEAD and can leave that copy days old. The "+"
     * is about that local copy only; decisions are still taken with remoteMain(), asked to the remote itself.
     */
    fetchMain() { const result = exec(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]); return result.code === 0 ? { ok: true } : { ok: false, reason: redact(result.stderr || `exit ${result.code}`, 200) }; },
    /** Where origin's main is right now (asked to the remote, not to the local copy), or null. */
    remoteMain() { const line = out(["ls-remote", "origin", "refs/heads/main"]); const sha = line?.split(/\s+/)[0]; return /^[0-9a-f]{40}$/.test(sha ?? "") ? sha : null; },
    /** Pushes `sha` to origin's main as a fast-forward. Returns { ok, reason }. */
    pushMain(sha) {
      if (!/^[0-9a-f]{40}$/.test(String(sha))) return { ok: false, reason: "not a commit" };
      const args = ["push", "--porcelain", "origin", `${sha}:refs/heads/main`];
      if (args.some((arg) => /^(-f|--force.*|\+.*)$/.test(arg) || arg.startsWith("+"))) return { ok: false, reason: "a forced push is never made" };
      const result = exec(args); return result.code === 0 ? { ok: true } : { ok: false, reason: redact(result.stderr || result.stdout || `exit ${result.code}`, 200) };
    },
    /** Moves the local main from `from` to `to`, only if it is still at `from`. */
    updateLocalMain(to, from) { return exec(["update-ref", "refs/heads/main", to, from]).code === 0; },
    /** Everything the reports show about the repository, in one read. */
    state() {
      if (!git.isRepository()) throw new PreconditionError("This is not a git repository.");
      const changes = git.changes();
      return { branch: git.branch(), commit: git.commit("HEAD"), main: git.commit("main"), clean: changes.length === 0, changes, trackedLinkState: git.trackedLinkState(), linkStateIgnored: git.linkStateIgnored() };
    },
  };
  return git;
}
export const short = (commit) => (commit ? String(commit).slice(0, 7) : "none");

/**
 * The git checks of a release, as a list of { name, ok, detail }. Each expectation is only checked when given:
 * a clean tree, the branch, the exact commit (full or abbreviated), where main is, and that main can be
 * fast-forwarded to the commit. The link folder is always checked.
 */
export function checkGit(git, { requireClean = true, expectBranch, expectCommit, expectMain, fastForwardMainTo } = {}) {
  const state = git.state(); const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const matches = (commit, expected) => !!commit && !!expected && String(expected).length >= 7 && commit.startsWith(String(expected));
  if (requireClean) add("working tree clean", state.clean, state.clean ? "no changes" : `${state.changes.length} changed or untracked: ${state.changes.slice(0, 5).map((item) => item.path).join(", ")}${state.changes.length > 5 ? "…" : ""}`);
  add("link folder not tracked", state.trackedLinkState.length === 0, state.trackedLinkState.length ? `${state.trackedLinkState.length} file(s) of ${linkStateDir} are tracked` : `${linkStateDir} is not in git`);
  add("link folder ignored", state.linkStateIgnored, state.linkStateIgnored ? `${linkStateDir}/ is in .gitignore` : `${linkStateDir}/ is not ignored`);
  if (expectBranch) add("branch", state.branch === expectBranch, `on ${state.branch ?? "a detached HEAD"}, expected ${expectBranch}`);
  if (expectCommit) add("commit", matches(state.commit, expectCommit), `HEAD is ${short(state.commit)}, expected ${short(expectCommit)}`);
  if (expectMain) add("main", matches(state.main, expectMain), `main is ${short(state.main)}, expected ${short(expectMain)}`);
  if (fastForwardMainTo) { const forward = git.canFastForward("main", fastForwardMainTo); add("main can fast-forward", forward.ok && forward.merges === 0, `${forward.reason}${forward.ok ? ` (${forward.commits} commit(s))` : ""}`); }
  return { state, checks, ok: checks.every((item) => item.ok) };
}
/** Throws CheckFailed with the checks that failed. */
export function requireGit(git, expectations = {}) {
  const seen = checkGit(git, expectations);
  if (!seen.ok) throw new CheckFailed("The repository is not in the expected state.", { stage: "git", details: seen.checks.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`) });
  return seen;
}
