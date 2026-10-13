/**
 * The rest of the release tooling's core: exit codes and the report, the git checks (against temporary
 * repositories) and the release state folder (in a temporary folder). Nothing here reaches Supabase.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkGit, createGit, linkStateDir, requireGit, short } from "../scripts/release/lib/git.mjs";
import { CheckFailed, EXIT, FailureAfterProdWrite, HumanActionRequired, PreconditionError, ReleaseError, TargetNotConfirmed, createReport, exitCodeFor, exitName, redact, reportSections, worstExit } from "../scripts/release/lib/report.mjs";
import { createState, findSecrets } from "../scripts/release/lib/state.mjs";
import { forbidden, gitRepo, scratch } from "./fixtures/release-harness.mjs";

const check = (seen, name) => seen.checks.find((item) => item.name === name);

test("exit codes: six, each with one meaning", () => {
  assert.deepEqual(EXIT, { PASS: 0, CHECK_FAILED: 1, PRECONDITION_OR_USAGE: 2, TARGET_NOT_CONFIRMED: 3, HUMAN_ACTION_REQUIRED: 4, FAILURE_AFTER_PROD_WRITE: 5 });
  assert.ok(Object.isFrozen(EXIT));
  for (const [name, code] of Object.entries(EXIT)) assert.equal(exitName(code), name);
  assert.equal(exitName(9), "UNKNOWN");
});

test("exit codes: each kind of error carries its own, and anything else is a failed check", () => {
  assert.equal(exitCodeFor(new CheckFailed("x")), 1); assert.equal(exitCodeFor(new PreconditionError("x")), 2); assert.equal(exitCodeFor(new TargetNotConfirmed("x")), 3);
  assert.equal(exitCodeFor(new HumanActionRequired("x")), 4); assert.equal(exitCodeFor(new FailureAfterProdWrite("x")), 5);
  assert.equal(exitCodeFor(new Error("x")), 1); assert.equal(exitCodeFor("text"), 1); assert.equal(exitCodeFor(undefined), 1);
  // A subclass cannot be talked into another code, and a made-up code is never a pass.
  assert.equal(exitCodeFor(new TargetNotConfirmed("x", { exitCode: 0 })), 3);
  assert.equal(exitCodeFor(new ReleaseError("x", { exitCode: 77 })), 1);
  const error = new CheckFailed("x", { stage: "smokes", details: ["a"] });
  assert.equal(error.name, "CheckFailed"); assert.equal(error.stage, "smokes"); assert.deepEqual(error.details, ["a"]);
});

test("exit codes: when two things went wrong, the more serious one decides", () => {
  assert.equal(worstExit(EXIT.PASS, EXIT.CHECK_FAILED), 1); assert.equal(worstExit(EXIT.CHECK_FAILED, EXIT.TARGET_NOT_CONFIRMED), 3);
  assert.equal(worstExit(EXIT.TARGET_NOT_CONFIRMED, EXIT.FAILURE_AFTER_PROD_WRITE), 5); assert.equal(worstExit(EXIT.HUMAN_ACTION_REQUIRED, EXIT.PRECONDITION_OR_USAGE), 4);
  assert.equal(worstExit(EXIT.PASS, EXIT.PASS), 0); assert.equal(worstExit(), 1); assert.equal(worstExit(42), 1);
});

test("redaction: credentials are removed, and what is left is one short line", () => {
  const text = redact("failed: postgres://postgres:hunter2-secret@db.x.supabase.co:5432/postgres\n token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl key sb_secret_never_show_this Authorization: Bearer abcdefghijklmnop1234 db_password=\"hunter2\" sbp_0123456789abcdef0123");
  for (const secret of [...forbidden, "abcdefghijklmnop1234", "sbp_0123456789abcdef0123"]) assert.ok(!text.includes(secret), secret);
  assert.ok(!text.includes("\n")); assert.match(text, /^failed: \[connection string\]/);
  assert.equal(redact("x".repeat(500), 50).length, 51); assert.equal(redact(null), ""); assert.equal(redact("migration 20261018090000 applied"), "migration 20261018090000 applied");
});

test("report: always the same sections in the same order, N/A when a stage has nothing to say", () => {
  assert.deepEqual([...reportSections], ["TARGET", "GIT", "MIGRATIONS", "DRIFT", "SNAPSHOT", "SMOKES", "DEPLOY", "CLI FINAL TARGET"]);
  const report = createReport("status");
  const empty = report.render();
  assert.deepEqual(empty.split("\n").filter((line) => line.startsWith("## ")), [...reportSections.map((name) => `## ${name}`), "## RESULT"]);
  assert.equal(empty.split("\n").filter((line) => line === "N/A").length, reportSections.length);
  assert.match(empty, /## RESULT\nPASS\n- exit 0 \(PASS\)\n$/); assert.equal(report.exitCode(), 0);
  report.set("TARGET", "PASS", ["linked project: staging", null, ""]).set("SMOKES", "FAIL", ["2 of 28 failed"]);
  assert.deepEqual(report.get("TARGET").lines, ["linked project: staging"]);
  assert.equal(report.exitCode(), EXIT.CHECK_FAILED); assert.equal(report.result(), "FAIL");
  assert.match(report.render(), /## SMOKES\nFAIL\n- 2 of 28 failed\n/); assert.match(report.render(), /## RESULT\nFAIL\n- exit 1 \(CHECK_FAILED\)/);
  assert.throws(() => report.set("EXTRA", "PASS"), PreconditionError); assert.throws(() => report.set("TARGET", "OK"), PreconditionError);
});

test("report: a section waiting for a person is not a pass, and the first failure is the one reported", () => {
  const waiting = createReport("prod-precheck").set("DEPLOY", "HUMAN", ["Preview is protected: HUMAN VERIFICATION REQUIRED"]);
  assert.equal(waiting.exitCode(), EXIT.HUMAN_ACTION_REQUIRED); assert.equal(waiting.result(), "FAIL");
  assert.equal(createReport("x").set("MIGRATIONS", "INFO", ["45 local"]).exitCode(), EXIT.PASS);
  const report = createReport("prod-release").set("SMOKES", "FAIL");
  report.fail(new TargetNotConfirmed("The CLI could not be confirmed on production.", { stage: "confirm production", details: ["no project is marked as linked"] }));
  report.fail(new Error("a later error"));
  assert.equal(report.exitCode(), EXIT.TARGET_NOT_CONFIRMED);
  assert.match(report.render(), /- exit 3 \(TARGET_NOT_CONFIRMED\)\n- failed at confirm production: The CLI could not be confirmed on production\.\n- no project is marked as linked\n$/);
  const json = JSON.parse(JSON.stringify(report.toJSON()));
  assert.equal(json.result, "FAIL"); assert.equal(json.exitCode, 3); assert.equal(json.exit, "TARGET_NOT_CONFIRMED"); assert.equal(json.failure.stage, "confirm production");
  assert.deepEqual(Object.keys(json.sections), [...reportSections]);
});

test("report: nothing secret gets in, whether through a line, an error or its details", () => {
  const leak = "postgres://postgres:hunter2-secret@db.x.supabase.co/postgres sb_secret_never_show_this eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  const report = createReport("status").set("TARGET", "FAIL", [leak]);
  report.fail(new CheckFailed(leak, { details: [leak] }));
  for (const text of [report.render(), JSON.stringify(report.toJSON())]) for (const secret of forbidden) assert.ok(!text.includes(secret), secret);
});

test("git: a clean repository on the expected branch and commit passes", (t) => {
  const repo = gitRepo(t); const git = createGit({ cwd: repo.dir }); const head = repo.git("rev-parse", "HEAD");
  const seen = checkGit(git, { expectBranch: "main", expectCommit: head, expectMain: head.slice(0, 7), fastForwardMainTo: "HEAD" });
  assert.equal(seen.ok, true, JSON.stringify(seen.checks)); assert.deepEqual(seen.checks.map((item) => item.name), ["working tree clean", "link folder not tracked", "link folder ignored", "branch", "commit", "main", "main can fast-forward"]);
  assert.deepEqual({ branch: seen.state.branch, commit: seen.state.commit, main: seen.state.main, clean: seen.state.clean }, { branch: "main", commit: head, main: head, clean: true });
  assert.equal(short(head), head.slice(0, 7)); assert.equal(short(null), "none");
  assert.equal(git.commit("no-such-branch"), null);
});

test("git: a dirty tree fails, whether the change is untracked, modified or staged", (t) => {
  const repo = gitRepo(t); const git = createGit({ cwd: repo.dir });
  repo.write("notes.txt");
  assert.equal(git.isClean(), false); assert.deepEqual(git.changes(), [{ status: "??", path: "notes.txt" }]);
  assert.throws(() => requireGit(git), (error) => error instanceof CheckFailed && exitCodeFor(error) === EXIT.CHECK_FAILED && error.stage === "git" && /working tree clean: 1 changed or untracked: notes\.txt/.test(error.details.join()));
  repo.commit(); assert.equal(requireGit(git).ok, true);
  repo.write("README.md", "changed\n"); assert.equal(check(checkGit(git), "working tree clean").ok, false);
  repo.git("add", "README.md"); assert.equal(check(checkGit(git), "working tree clean").ok, false);
  // Only asked for when it matters: `status` reads a dirty tree without failing on it.
  assert.equal(checkGit(git, { requireClean: false }).ok, true);
});

test("git: the CLI's link folder is fine while ignored, and a failure as soon as it is tracked", (t) => {
  const repo = gitRepo(t); const git = createGit({ cwd: repo.dir });
  repo.write(`${linkStateDir}/project-ref`, "hbvmcvemrkfovzhlpgys");
  assert.equal(requireGit(git).ok, true, "ignored: neither a change nor tracked");
  repo.git("add", "-f", `${linkStateDir}/project-ref`); repo.git("commit", "-q", "-m", "oops");
  assert.deepEqual(git.trackedLinkState(), [`${linkStateDir}/project-ref`]);
  const seen = checkGit(git); assert.equal(seen.ok, false); assert.equal(check(seen, "link folder not tracked").ok, false); assert.equal(check(seen, "working tree clean").ok, true);
  assert.throws(() => requireGit(git), (error) => error instanceof CheckFailed && /link folder not tracked: 1 file\(s\) of supabase\/\.temp are tracked/.test(error.details.join()));
});

test("git: a link folder that is not ignored fails even before anyone adds it", (t) => {
  const repo = gitRepo(t, { ignoreLinkState: false }); const git = createGit({ cwd: repo.dir });
  const seen = checkGit(git); assert.equal(check(seen, "link folder ignored").ok, false); assert.equal(check(seen, "link folder not tracked").ok, true); assert.equal(seen.ok, false);
});

test("git: branch and commit expectations", (t) => {
  const repo = gitRepo(t); const git = createGit({ cwd: repo.dir }); const first = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "-b", "feat/x"); repo.write("a.txt"); const second = repo.commit();
  assert.equal(git.branch(), "feat/x");
  assert.equal(check(checkGit(git, { expectBranch: "main" }), "branch").ok, false);
  assert.equal(check(checkGit(git, { expectCommit: first }), "commit").ok, false); assert.equal(check(checkGit(git, { expectCommit: second }), "commit").ok, true);
  assert.equal(check(checkGit(git, { expectCommit: second.slice(0, 3) }), "commit").ok, false, "too short to mean one commit");
  assert.equal(check(checkGit(git, { expectMain: first }), "main").ok, true); assert.equal(check(checkGit(git, { expectMain: second }), "main").ok, false);
  repo.git("checkout", "-q", "--detach"); assert.equal(git.branch(), null); assert.equal(check(checkGit(git, { expectBranch: "feat/x" }), "branch").ok, false);
});

test("git: whether main could fast-forward is answered without moving anything", (t) => {
  const repo = gitRepo(t); const git = createGit({ cwd: repo.dir }); const first = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "-b", "feat/x"); repo.write("a.txt"); repo.commit(); repo.write("b.txt"); const tip = repo.commit();
  assert.deepEqual(git.canFastForward("main", "feat/x"), { ok: true, reason: "straight line", commits: 2, merges: 0 });
  assert.deepEqual(git.canFastForward("main", "main"), { ok: true, reason: "already there", commits: 0, merges: 0 });
  assert.equal(git.canFastForward("main", "nowhere").ok, false); assert.equal(git.canFastForward("nowhere", "main").ok, false);
  assert.equal(check(checkGit(git, { fastForwardMainTo: tip }), "main can fast-forward").ok, true);
  // main moves on its own: the branch no longer descends from it.
  repo.git("checkout", "-q", "main"); repo.write("c.txt"); const main = repo.commit();
  assert.equal(git.canFastForward("main", "feat/x").ok, false); assert.match(git.canFastForward("main", "feat/x").reason, /does not descend/);
  assert.equal(check(checkGit(git, { fastForwardMainTo: "feat/x" }), "main can fast-forward").ok, false);
  // A merge commit on the way is not a straight line.
  repo.git("checkout", "-q", "feat/x"); repo.git("merge", "-q", "--no-ff", "-m", "merge main", "main");
  const merged = git.canFastForward("main", "feat/x"); assert.equal(merged.ok, true); assert.equal(merged.merges, 1);
  assert.equal(check(checkGit(git, { fastForwardMainTo: "feat/x" }), "main can fast-forward").ok, false);
  assert.equal(repo.git("rev-parse", "main"), main, "main is where it was"); assert.notEqual(main, first);
});

test("git: outside a repository it stops with a precondition, not a wrong answer", (t) => {
  const git = createGit({ cwd: scratch(t), run: () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }) });
  assert.equal(git.isRepository(), false);
  assert.throws(() => checkGit(git), (error) => error instanceof PreconditionError && exitCodeFor(error) === EXIT.PRECONDITION_OR_USAGE);
});

test("state: lives outside the repository, under the user's home by default", (t) => {
  const home = scratch(t), repository = scratch(t);
  assert.equal(createState({ repository, environment: {}, home }).root, join(home, "Bellis-Releases"));
  assert.equal(createState({ repository, environment: { BELLIS_RELEASES_DIR: join(home, "elsewhere") }, home }).root, join(home, "elsewhere"));
  for (const inside of [repository, join(repository, "releases"), join(repository, "a", "b")]) {
    assert.throws(() => createState({ repository, root: inside }), PreconditionError);
    assert.throws(() => createState({ repository, environment: { BELLIS_RELEASES_DIR: inside }, home }), PreconditionError);
  }
  assert.equal(existsSync(join(home, "Bellis-Releases")), false, "nothing is created until something is saved");
});

test("state: create the folder, save, load, and know how old it is", (t) => {
  const home = scratch(t); let clock = new Date("2026-10-13T12:00:00Z");
  const state = createState({ repository: scratch(t), environment: {}, home, now: () => clock });
  assert.equal(state.exists("h2-8c"), false); assert.equal(state.load("h2-8c", "precheck"), null); assert.equal(state.ageMinutes("h2-8c", "precheck"), Infinity);
  assert.equal(state.ensure("h2-8c"), join(home, "Bellis-Releases", "h2-8c")); assert.equal(state.exists("h2-8c"), true);
  const data = { commit: "8e8c395", migrations: ["20261018090000_admin_commercial_actions.sql"], counts: { workspaces: 3 }, ok: true };
  const file = state.save("h2-8c", "precheck", data);
  assert.equal(file, join(home, "Bellis-Releases", "h2-8c", "precheck.json"));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { release: "h2-8c", name: "precheck", savedAt: "2026-10-13T12:00:00.000Z", data });
  assert.deepEqual(state.load("h2-8c", "precheck"), { savedAt: "2026-10-13T12:00:00.000Z", data });
  clock = new Date("2026-10-13T12:45:00Z"); assert.equal(state.ageMinutes("h2-8c", "precheck"), 45);
  assert.equal(state.load("h2-8c", "other"), null); assert.equal(state.load("h2-9", "precheck"), null);
});

test("state: a save replaces the file in one step and a failed save leaves the previous one", (t) => {
  const state = createState({ repository: scratch(t), environment: {}, home: scratch(t) });
  state.save("h2-8c", "snapshot", { version: 1 }); state.save("h2-8c", "snapshot", { version: 2 });
  assert.deepEqual(state.load("h2-8c", "snapshot").data, { version: 2 });
  assert.throws(() => state.save("h2-8c", "snapshot", { version: 3n }), PreconditionError, "something that cannot be written");
  assert.deepEqual(state.load("h2-8c", "snapshot").data, { version: 2 });
  assert.deepEqual(readdirSync(state.releaseDir("h2-8c")), ["snapshot.json"], "no temporary file is left behind");
});

test("state: credentials are refused, by field name or by what the value looks like", (t) => {
  const state = createState({ repository: scratch(t), environment: {}, home: scratch(t) });
  const refused = [{ db_password: "x" }, { nested: { list: [{ serviceRoleKey: "x" }] } }, { accessToken: "x" }, { note: "postgres://postgres:hunter2@db.x.supabase.co/postgres" },
    { lines: ["ok", "Authorization: Bearer abcdefghijklmnop1234"] }, { jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl" }, { key: "sb_secret_abcdefgh" }, { env: { SUPABASE_SECRET_KEY: "" } }, "sbp_0123456789abcdef0123"];
  for (const data of refused) assert.throws(() => state.save("h2-8c", "report", data), (error) => error instanceof PreconditionError && !forbidden.some((secret) => JSON.stringify([error.message, error.details]).includes(secret)), JSON.stringify(data));
  assert.equal(state.exists("h2-8c"), false, "a refused save does not even create the folder");
  assert.deepEqual(findSecrets({ a: { b: [{ password: "x" }] }, c: "fine" }), ["a.b[0].password"]);
  assert.deepEqual(findSecrets({ ref: "hbvmcvemrkfovzhlpgys", commit: "8e8c395", url: "https://bellis.vercel.app/api/version", fingerprint: "9f31e5dc0a", count: 3, ok: null }), []);
});

test("state: a release id or a name cannot walk out of the folder", (t) => {
  const state = createState({ repository: scratch(t), environment: {}, home: scratch(t) });
  for (const id of ["../x", "a/b", "a\\b", "", ".", "..", "X", "h2 8c", null, "C:"]) { assert.throws(() => state.save(id, "report", {}), PreconditionError, String(id)); assert.throws(() => state.ensure(id), PreconditionError); }
  for (const name of ["../x", "a/b", "", "..\\x", "report.json/.."]) assert.throws(() => state.save("h2-8c", name, {}), PreconditionError, name);
  assert.equal(state.load("h2-8c", "../x"), null);
});
