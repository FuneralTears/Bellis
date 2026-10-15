/**
 * H2.8C.1: a production deployment whose exact URL is behind Vercel's login while its alias is public, and the
 * local copy of origin/main. The deployment is local HTTP servers, the database the fake Supabase CLI, origin a
 * local bare repository. Nothing here reaches Vercel, GitHub or Supabase.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { verifyDeployment } from "../scripts/release/deploy/verify.mjs";
import { createGit } from "../scripts/release/lib/git.mjs";
import { EXIT } from "../scripts/release/lib/report.mjs";
import { backups } from "./fixtures/release-backups.mjs";
import { forbidden, gitRepo, refs, scratch } from "./fixtures/release-harness.mjs";
import { github, html, json, login, prodSite, prodVersion, serve, stagingUrl } from "./fixtures/release-http.mjs";
import { releaseCli, releaseProject } from "./fixtures/release-project.mjs";

const quiet = { on() {}, off() {} };
const fast = { deployTimeoutMs: 3, deployIntervalMs: 1, aliasAttempts: 3, aliasIntervalMs: 1 };
const sha = "93256e2d5e80a6ce8458aa5de0fec08431106c78", old = "8e8c3958b903c6734d861a0f72e7c6f26667b616";
const expected = { commit: sha, environment: "production", supabaseRef: refs.production };
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
const statusOf = (output, name) => sectionOf(output, name).split("\n")[1];

test("verifier: exact URL and alias both answering is a pass", async (t) => {
  const site = await serve(t, prodSite(sha));
  const seen = await verifyDeployment({ url: site, alias: site, expected });
  assert.equal(seen.status, "PASS"); assert.equal(seen.protected, false); assert.equal(seen.exact.ok, true); assert.equal(seen.alias.ok, true);
});

test("verifier: exact URL behind the login, alias right: partial, alias verified, exact never said to be", async (t) => {
  const seen = await verifyDeployment({ url: await serve(t, { "/api/version": login }), alias: await serve(t, prodSite(sha)), expected });
  assert.equal(seen.status, "PARTIAL"); assert.equal(seen.protected, true); assert.equal(seen.exact.ok, false); assert.equal(seen.alias.ok, true);
  assert.equal(seen.alias.observed.commit, sha); assert.equal(seen.alias.observed.deploymentId, "dpl_7dQx2AbCdEf");
  assert.deepEqual(seen.pages.map((page) => [page.path, page.ok]), [["/", true], ["/ingresar", true], ["/api/supabase-config", true]], "pages read through the alias");
  assert.match(seen.problems[0], /exact deployment: the exact deployment is behind Vercel's login: a person has to confirm it/);
});

test("verifier: exact URL behind the login and the alias wrong, missing or leaking: fail", async (t) => {
  const exact = await serve(t, { "/api/version": login });
  const check = async (aliasRoutes, pattern, options = {}) => { const seen = await verifyDeployment({ url: exact, alias: aliasRoutes ? await serve(t, aliasRoutes) : "http://127.0.0.1:1", expected, timeoutMs: 500, ...options }); assert.equal(seen.status, "FAIL", String(pattern)); assert.match(seen.problems.join(" | "), pattern); };
  await check(prodSite(old), /production alias: commit 8e8c395, expected 93256e2/);
  await check(prodSite(sha, { versionRoute: json(prodVersion(sha, { url: stagingUrl })) }), /production alias: Supabase project hbvmcvemrkfovzhlpgys.*a production deployment on the staging project/);
  await check(prodSite(sha, { versionRoute: { status: 404, body: "" } }), /production alias: HTTP 404/);
  await check(prodSite(sha, { versionRoute: { status: 500, body: "" } }), /production alias: HTTP 500/);
  await check(prodSite(sha, { versionRoute: login }), /production alias: behind Vercel's login/);
  await check(null, /production alias: could not be reached/);
  await check({ ...prodSite(sha), "/": html(`<script>"sb_secret_never_show_this"</script>`) }, /\/: it carries something secret/);
  const preview = await verifyDeployment({ url: exact, expected: { ...expected, environment: "preview", supabaseRef: refs.staging } });
  assert.equal(preview.status, "HUMAN", "without an alias (a Preview) it is a question for a person, as before");
});

/** A release prechecked through the fake CLI, with a local origin, ready for prod-release. Production is on the base. */
async function prechecked(t) {
  const made = releaseProject(t, { migrations: [] });
  const origin = scratch(t, "bellis-origin-"); spawnSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  made.repo.git("remote", "add", "origin", origin); made.repo.git("push", "-q", "origin", "main", "feat/release");
  const cli = releaseCli(t, { pending: [], schemaAfterPush: undefined });
  const run = (argv, extra = {}) => main(argv, { root: made.root, environment: cli.environment, home: made.home, write: () => {}, supabase: cli.supabase, git: made.git, signals: quiet, runLocal: () => ({ ok: true, summary: "fine" }), ...extra });
  assert.equal(await run(["staging", "--release", "h2-9"]), EXIT.PASS);
  cli.set({ appliedByRef: { [refs.production]: ["20261017090000"] }, pushableByRef: { [refs.production]: [], [refs.staging]: [] } });
  const dir = join(made.home, "Bellis-Backups"); mkdirSync(dir, { recursive: true });
  const dumps = backups({ after() {} }, { dir, captureOf: () => JSON.parse(readFileSync(join(made.home, "Bellis-Releases", "h2-9", "schema-base.json"), "utf8")).data });
  assert.equal(await run(["prod-precheck", "--release", "h2-9"], { listToc: dumps.listToc }), EXIT.PASS);
  const head = made.git.commit("HEAD");
  return { made, cli, head, approval: `h2-9@${head.slice(0, 7)}`, originMain: () => spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim(), folder: join(made.home, "Bellis-Releases", "h2-9") };
}
const stateOf = (context) => JSON.parse(readFileSync(join(context.folder, "release-state.json"), "utf8")).data.state;
const deployOf = (context) => JSON.parse(readFileSync(join(context.folder, "deploy-state.json"), "utf8")).data.production;
async function prodRelease(context, { exact, alias }) {
  let output = "";
  const code = await main(["prod-release", "--release", "h2-9"], { root: context.made.root, environment: { ...context.cli.environment, CONFIRM_PROD_RELEASE: context.approval }, home: context.made.home, write: (text) => { output += text; },
    supabase: context.cli.supabase, git: context.made.git, signals: quiet, prompt: async () => "h2-9", fetchImpl: github({ commit: context.head, url: exact }), aliasUrl: alias, sleep: async () => {}, timings: fast });
  return { code, output };
}
async function deployCheck(context, argv, alias) {
  let output = "";
  const code = await main(["deploy-check", "--release", "h2-9", "--expected-env", "production", "--alias", alias, ...argv], { root: context.made.root, environment: context.cli.environment, home: context.made.home, write: (text) => { output += text; }, supabase: context.cli.supabase, git: context.made.git });
  return { code, output };
}

test("prod-release: exact URL behind the login, alias right: it stops recoverably, and a person's confirmation closes it", async (t) => {
  const context = await prechecked(t);
  const exact = await serve(t, { "/api/version": login }); const alias = await serve(t, prodSite(context.head));
  const out = await prodRelease(context, { exact, alias });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, out.output); assert.match(out.output, /## RESULT\nHUMAN ACTION REQUIRED\n/);
  assert.equal(statusOf(out.output, "PROD VERSION"), "HUMAN VERIFICATION REQUIRED"); assert.equal(statusOf(out.output, "PROD ALIAS"), "PASS"); assert.equal(statusOf(out.output, "DEPLOYMENT"), "READY");
  assert.match(out.output, new RegExp(`--url ${exact} --confirm-human h2-9`)); assert.equal(stateOf(context), "MAIN_ADVANCED"); assert.equal(context.originMain(), context.head);
  assert.deepEqual([deployOf(context).state, deployOf(context).scope, deployOf(context).url, deployOf(context).observedCommit], ["DEPLOY_PROD_PARTIAL_VERIFIED", "alias", exact, context.head]);
  assert.equal(context.cli.linkedFile(), refs.staging);

  const before = { calls: context.cli.calls().length, pushes: context.cli.state().pushes ?? 0 };
  let done = await deployCheck(context, ["--url", exact, "--confirm-human", "h2-8"], alias); assert.equal(done.code, EXIT.PRECONDITION_OR_USAGE, "another release id");
  done = await deployCheck(context, ["--url", exact, "--confirm-human", "h2-9", "--expected-commit", context.made.mainBase], alias); assert.equal(done.code, EXIT.PRECONDITION_OR_USAGE, "another commit");
  done = await deployCheck(context, ["--url", "https://another.example", "--confirm-human", "h2-9"], alias); assert.equal(done.code, EXIT.PRECONDITION_OR_USAGE, "a deployment other than the one verified");
  done = await deployCheck(context, ["--url", exact, "--confirm-human", "h2-9"], await serve(t, prodSite(old))); assert.equal(done.code, EXIT.CHECK_FAILED, "the alias is read again, and no longer serves the release");
  assert.equal(stateOf(context), "MAIN_ADVANCED", "nothing moved after the refusals");

  done = await deployCheck(context, ["--url", exact, "--confirm-human", "h2-9"], alias);
  assert.equal(done.code, EXIT.PASS, done.output);
  for (const [section, status] of Object.entries({ HTTP: "PASS", COMMIT: "PASS", ENVIRONMENT: "PASS", "SUPABASE REF": "PASS", ALIAS: "PASS", "VERIFICATION MODE": "HUMAN CONFIRMED", "TECH QA": "PASS", STATE: "RELEASE_COMPLETE" })) assert.equal(statusOf(done.output, section), status, section);
  const record = deployOf(context);
  assert.deepEqual([record.state, record.mode, record.actor, record.url, record.alias, record.expectedCommit, record.environment, record.supabaseRef, record.deploymentId, record.aliasVerification.mode], ["DEPLOY_PROD_VERIFIED", "human", "human-confirmed", exact, alias, context.head, "production", refs.production, "dpl_7dQx2AbCdEf", "automatic"]);
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(readFileSync(join(context.folder, "release-state.json"), "utf8")).data.history.filter((entry) => !entry.rerun && entry.result === "PASS").map((entry) => entry.state).slice(-3), ["MAIN_ADVANCED", "DEPLOY_PROD_VERIFIED", "RELEASE_COMPLETE"]);
  assert.equal(context.cli.calls().length, before.calls, "Supabase was not touched"); assert.equal(context.cli.state().pushes ?? 0, before.pushes, "nothing applied again"); assert.equal(context.originMain(), context.head, "main untouched");
  for (const file of readdirSync(context.folder)) { const text = readFileSync(join(context.folder, file), "utf8"); for (const secret of [...forbidden, "sb_publishable_abcdefghijklmnop", context.approval]) assert.ok(!text.includes(secret), `${file} holds ${secret}`); }
  for (const secret of [...forbidden, "sb_publishable_abcdefghijklmnop"]) assert.ok(!done.output.includes(secret));
  done = await deployCheck(context, ["--url", exact, "--confirm-human", "h2-9"], alias); assert.equal(done.code, EXIT.PRECONDITION_OR_USAGE, "only once"); assert.match(done.output, /already has its production deployment verified/);
});

test("prod-release: exact URL behind the login and the alias wrong: exit 5, nothing recorded as verified", async (t) => {
  for (const aliasRoutes of [() => prodSite(old), (head) => prodSite(head, { versionRoute: json(prodVersion(head, { url: stagingUrl })) })]) {
    const context = await prechecked(t);
    const out = await prodRelease(context, { exact: await serve(t, { "/api/version": login }), alias: await serve(t, aliasRoutes(context.head)) });
    assert.equal(out.code, EXIT.FAILURE_AFTER_PROD_WRITE, out.output); assert.equal(statusOf(out.output, "PROD ALIAS"), "FAIL"); assert.equal(stateOf(context), "MAIN_ADVANCED");
    const recorded = existsSync(join(context.folder, "deploy-state.json")) ? JSON.parse(readFileSync(join(context.folder, "deploy-state.json"), "utf8")).data.production?.state : null;
    assert.ok(!["DEPLOY_PROD_VERIFIED", "DEPLOY_PROD_PARTIAL_VERIFIED"].includes(recorded), `nothing recorded as verified (${recorded})`);
  }
});

test("git: a stale local origin/main is brought up to date by the fetch, and the remote stays the truth", (t) => {
  const repo = gitRepo(t); const origin = scratch(t, "bellis-origin-"); spawnSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  repo.git("remote", "add", "origin", origin); repo.git("push", "-q", "origin", "main"); repo.git("fetch", "-q", "origin");
  const first = repo.git("rev-parse", "main");
  const other = scratch(t, "bellis-other-"); spawnSync("git", ["clone", "-q", origin, other]);
  for (const args of [["config", "user.email", "x@example.invalid"], ["config", "user.name", "X"], ["commit", "-q", "--allow-empty", "-m", "elsewhere"], ["push", "-q", "origin", "main"]]) spawnSync("git", args, { cwd: other });
  const newer = spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim();
  const used = []; const git = createGit({ cwd: repo.dir, run: (args) => { used.push(args); const result = spawnSync("git", args, { cwd: repo.dir, encoding: "utf8" }); return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }; } });
  assert.equal(git.commit("refs/remotes/origin/main"), first, "the local copy is stale"); assert.equal(git.remoteMain(), newer, "the remote itself says where main is");
  assert.deepEqual(git.fetchMain(), { ok: true }); assert.equal(git.commit("refs/remotes/origin/main"), newer, "the fetch brought the local copy up to date");
  // Fast-forward safety: a commit that does not descend from the remote main is refused by the server; nothing is forced.
  repo.write("mine.txt"); const mine = repo.commit("mine");
  const pushed = git.pushMain(mine); assert.equal(pushed.ok, false); assert.equal(spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim(), newer, "origin's main did not move");
  assert.equal(used.flat().some((arg) => /^(-f|--force.*)$/.test(arg)), false); assert.equal(used.filter((args) => args[0] === "push").flat().some((arg) => arg.startsWith("+")), false, "never a forced push");
  assert.deepEqual(git.pushMain("not-a-sha"), { ok: false, reason: "not a commit" });
});
