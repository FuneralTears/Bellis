/**
 * `bellis:prod-release`, end to end, with nothing real: a scratch repository whose origin is a local bare repository,
 * the fake Supabase CLI (staging and production answering separately), fake backups, local HTTP servers for the
 * deployment and its alias, and GitHub's deployments API answered locally. Nothing here reaches Supabase, GitHub,
 * Vercel or any network beyond 127.0.0.1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { createGit } from "../scripts/release/lib/git.mjs";
import { isGranted, withProdWriteAuthorization, WriteRefused } from "../scripts/release/lib/guard.mjs";
import { EXIT, ReleaseError } from "../scripts/release/lib/report.mjs";
import { assertWritable } from "../scripts/release/lib/target.mjs";
import { versionPayload } from "../lib/supabase-target.ts";
import { backups } from "./fixtures/release-backups.mjs";
import { database, releaseCli, releaseMigration, releaseProject, schemaAnswer } from "./fixtures/release-project.mjs";
import { fakeCli, forbidden, refs, scratch } from "./fixtures/release-harness.mjs";

const quiet = { on() {}, off() {} };
const fast = { deployTimeoutMs: 3, deployIntervalMs: 1, aliasAttempts: 3, aliasIntervalMs: 1 };
const prodUrl = `https://${refs.production}.supabase.co`, stagingUrl = `https://${refs.staging}.supabase.co`;
const old = "8e8c3958b903c6734d861a0f72e7c6f26667b616";
const json = (body) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const html = (body) => ({ status: 200, headers: { "content-type": "text/html" }, body });
const version = (commit, { url = prodUrl } = {}) => versionPayload({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: commit, VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: url });
/** Production as a person would see it, serving `commit`. `versionRoute` replaces /api/version. */
const site = (commit, { versionRoute } = {}) => ({ "/api/version": versionRoute ?? json(version(commit)), "/api/supabase-config": json({ url: prodUrl, publishableKey: "sb_publishable_abcdefghijklmnop" }),
  ...Object.fromEntries(["/", "/ingresar", "/registro", "/dashboard", "/pro", "/pacientes", "/seguimientos", "/automatizaciones", "/notificaciones", "/admin"].map((path) => [path, html(`<html>${path}</html>`)])) });
async function serve(t, routes) {
  const server = createServer((request, response) => { const found = routes[request.url.split("?")[0]]; const route = typeof found === "function" ? found() : found ?? { status: 404, body: "" }; response.writeHead(route.status, route.headers ?? {}); response.end(route.body ?? ""); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
/** GitHub's deployments API, answered locally; anything else goes to the local servers. */
const github = ({ commit, url, state = "success" } = {}) => async (target, options) => {
  if (!String(target).startsWith("https://api.github.com/")) return fetch(target, options);
  const body = /\/statuses/.test(target) ? (url ? [{ state, environment_url: url }] : []) : (url ? [{ id: 77, sha: commit, environment: "Production", created_at: "2026-10-14T12:00:00Z" }] : []);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
const savedCapture = (made, name) => JSON.parse(readFileSync(join(made.home, "Bellis-Releases", "h2-9", `${name}.json`), "utf8")).data;
const folder = (made) => join(made.home, "Bellis-Releases", "h2-9");
const stateOf = (made) => JSON.parse(readFileSync(join(folder(made), "release-state.json"), "utf8")).data;
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
const statusOf = (output, name) => sectionOf(output, name).split("\n")[1];

/**
 * A release taken through staging and the production precheck, with an origin to push main to. Production is still on
 * the base; applying the release there moves it to what staging is.
 */
async function prechecked(t, { migrations } = {}) {
  const made = releaseProject(t, migrations ? { migrations } : {});
  const origin = scratch(t, "bellis-origin-"); spawnSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  made.repo.git("remote", "add", "origin", origin); made.repo.git("push", "-q", "origin", "main", "feat/release");
  const files = migrations ?? [releaseMigration];
  const cli = releaseCli(t, files.length ? {} : { pending: [], schemaAfterPush: undefined });
  const run = (argv, extra = {}) => main(argv, { root: made.root, environment: cli.environment, home: made.home, write: () => {}, supabase: cli.supabase, git: made.git, signals: quiet, runLocal: () => ({ ok: true, summary: "fine" }), ...extra });
  assert.equal(await run(["staging", "--release", "h2-9"]), EXIT.PASS);
  cli.set({ appliedByRef: { [refs.production]: ["20261017090000"] }, pushableByRef: { [refs.production]: files, [refs.staging]: [] }, ...(files.length ? { schemaAfterPushByRef: { [refs.production]: schemaAnswer({ migrated: true }) } } : {}) });
  const dir = join(made.home, "Bellis-Backups"); mkdirSync(dir, { recursive: true });
  const dumps = backups({ after() {} }, { dir, captureOf: () => savedCapture(made, "schema-base") });
  assert.equal(await run(["prod-precheck", "--release", "h2-9"], { listToc: dumps.listToc }), EXIT.PASS);
  const head = made.git.commit("HEAD");
  return { made, cli, dumps, head, origin, approval: `h2-9@${head.slice(0, 7)}`, originMain: () => spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim() };
}
/** Runs prod-release. Everything that would reach the world is local; nothing waits. */
async function release(context, { env, prompt = async () => "h2-9", fetchImpl, aliasUrl, now, git } = {}) {
  const { made, cli } = context; let output = ""; const before = cli.calls().length;
  const code = await main(["prod-release", "--release", "h2-9"], { root: made.root, environment: { ...cli.environment, CONFIRM_PROD_RELEASE: context.approval, ...(env ?? {}) }, home: made.home, write: (text) => { output += text; },
    supabase: cli.supabase, git: git ?? made.git, signals: quiet, prompt, fetchImpl: fetchImpl ?? github(), aliasUrl, now, sleep: async () => {}, timings: fast });
  return { code, output, calls: cli.calls().slice(before) };
}
/** A healthy production for `context`: the exact deployment and its alias, both serving the release commit. */
async function healthy(t, context) { const url = await serve(t, site(context.head)); return { fetchImpl: github({ commit: context.head, url }), aliasUrl: url, url }; }
function assertSafe(context, out, { prodWrites = 0 } = {}) {
  assert.equal(context.cli.linkedFile(), refs.staging, "the CLI ends on staging"); assert.equal(statusOf(out.output, "CLI FINAL TARGET"), "STAGING");
  assert.equal((context.cli.state().pushLog ?? []).filter((ref) => ref === refs.production).length, prodWrites, "writes to production");
  for (const secret of [...forbidden, "sb_publishable_abcdefghijklmnop", context.approval]) assert.ok(!out.output.includes(secret) || secret === context.approval && out.output.includes(`CONFIRM_PROD_RELEASE=${context.approval}`) === false, `leaked: ${secret}`);
  for (const file of readdirSync(folder(context.made))) { const text = readFileSync(join(folder(context.made), file), "utf8"); for (const secret of [...forbidden, context.approval]) assert.ok(!text.includes(secret), `${file} holds ${secret}`); }
}

test("the write grant: production is written only inside withProdWriteAuthorization, for a listed operation", async (t) => {
  const onProduction = fakeCli(t, { linked: refs.production });
  assert.throws(() => assertWritable(onProduction.supabase, "production", { environment: onProduction.environment, operation: "applying migrations" }), (error) => error instanceof ReleaseError && /outside prod-release's authorization/.test(error.message));
  await assert.rejects(withProdWriteAuthorization({ approved: false, precheckValid: true, onProduction: true, operations: ["applying migrations"] }, async () => {}), WriteRefused);
  await assert.rejects(withProdWriteAuthorization({ approved: true, precheckValid: false, onProduction: true, operations: ["applying migrations"] }, async () => {}), WriteRefused);
  await assert.rejects(withProdWriteAuthorization({ approved: true, precheckValid: true, onProduction: false, operations: ["applying migrations"] }, async () => {}), WriteRefused);
  await assert.rejects(withProdWriteAuthorization({ approved: true, precheckValid: true, onProduction: true, operations: ["deleting data"] }, async () => {}), WriteRefused);
  let kept = null;
  await withProdWriteAuthorization({ approved: true, precheckValid: true, onProduction: true, operations: ["applying migrations"] }, async (grant) => {
    kept = grant; assertWritable(onProduction.supabase, "production", { environment: onProduction.environment, operation: "applying migrations", grant });
    assert.throws(() => assertWritable(onProduction.supabase, "production", { environment: onProduction.environment, operation: "running SQL", grant }), ReleaseError);
  });
  assert.equal(isGranted(kept, "applying migrations"), false, "a grant does not outlive its block");
  assert.throws(() => assertWritable(onProduction.supabase, "production", { environment: onProduction.environment, operation: "applying migrations", grant: kept }), ReleaseError);
  assert.equal(isGranted({ operations: ["applying migrations"] }, "applying migrations"), false, "a grant cannot be made by hand");
});

test("a release with a migration goes all the way: apply, verify, main, deployment, alias, QA, and the CLI ends on staging", async (t) => {
  const context = await prechecked(t); const prod = await healthy(t, context);
  const used = []; const git = createGit({ cwd: context.made.root, run: (args) => { used.push(args); const result = spawnSync("git", args, { cwd: context.made.root, encoding: "utf8" }); return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }; } });
  const out = await release(context, { ...prod, git });
  assert.equal(out.code, EXIT.PASS, out.output);
  const expected = { "HUMAN APPROVAL": "PASS", PRECHECK: "VALID", "PROD TARGET": "PASS", "PROD MIGRATIONS": "PASS", "PROD APPLY": "PASS", "PROD SCHEMA": "MATCH", "PROD SMOKES": "PASS", "PROD SNAPSHOT": "IDENTICAL", MAIN: "PASS", DEPLOYMENT: "READY", "PROD VERSION": "PASS", "PROD ALIAS": "PASS", "TECH QA": "PASS", "CLI FINAL TARGET": "STAGING", STATE: "RELEASE_COMPLETE" };
  for (const [section, status] of Object.entries(expected)) assert.equal(statusOf(out.output, section), status, section);
  assert.match(sectionOf(out.output, "MAIN"), new RegExp(`${context.made.mainBase.slice(0, 7)} -> ${context.head.slice(0, 7)}`)); assert.match(sectionOf(out.output, "PROD SMOKES"), /1\/1 PASS, self-test 3\/3, rollbacks verified/);
  assert.equal(context.originMain(), context.head, "origin/main is the release commit"); assert.equal(context.made.git.commit("main"), context.head, "and so is the local main");
  assert.equal(used.flat().some((arg) => /^(-f|--force.*)$/.test(arg) || arg.startsWith("+")), false, "never a forced push"); assert.ok(used.some((args) => args[0] === "push" && args.at(-1) === `${context.head}:refs/heads/main`));
  const history = stateOf(context.made).history.filter((entry) => !entry.rerun).map((entry) => entry.state);
  assert.deepEqual(history.slice(-6), ["PROD_PRECHECK_COMPLETE", "PROD_APPLIED", "PROD_VERIFIED", "MAIN_ADVANCED", "DEPLOY_PROD_VERIFIED", "RELEASE_COMPLETE"]);
  const deploy = JSON.parse(readFileSync(join(folder(context.made), "deploy-state.json"), "utf8")).data.production;
  assert.deepEqual([deploy.state, deploy.mode, deploy.url, deploy.observedCommit, deploy.supabaseRef], ["DEPLOY_PROD_VERIFIED", "automatic", prod.url, context.head, refs.production]);
  assertSafe(context, out, { prodWrites: 1 });
});

test("a release without migrations: nothing applied, everything else the same", async (t) => {
  const context = await prechecked(t, { migrations: [] }); const prod = await healthy(t, context);
  const out = await release(context, prod);
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(statusOf(out.output, "PROD APPLY"), "NOT NEEDED"); assert.equal(context.originMain(), context.head);
  assert.deepEqual(stateOf(context.made).history.filter((entry) => !entry.rerun).map((entry) => entry.state).slice(-5), ["PROD_PRECHECK_COMPLETE", "PROD_VERIFIED", "MAIN_ADVANCED", "DEPLOY_PROD_VERIFIED", "RELEASE_COMPLETE"]);
  assertSafe(context, out, { prodWrites: 0 });
});

test("without the approval, the typed id or a valid precheck, nothing is touched: exit 4", async (t) => {
  const context = await prechecked(t);
  const cases = [["no approval", { env: { CONFIRM_PROD_RELEASE: "" } }], ["approval for another commit", { env: { CONFIRM_PROD_RELEASE: "h2-9@0000000" } }], ["approval for another release", { env: { CONFIRM_PROD_RELEASE: `h2-8@${context.head.slice(0, 7)}` } }],
    ["no terminal to type in", { prompt: async () => null }], ["the wrong id typed", { prompt: async () => "h2-9 " }], ["an expired precheck", { now: () => new Date(Date.now() + 3 * 3_600_000) }]];
  for (const [name, options] of cases) {
    const out = await release(context, options);
    assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, `${name}\n${out.output}`); assert.deepEqual(out.calls, [], `${name}: Supabase was not touched`);
    assert.equal(context.originMain(), context.made.mainBase, `${name}: main was not moved`); assert.equal(stateOf(context.made).state, "PROD_PRECHECK_COMPLETE");
  }
  const expired = await release(context, { now: () => new Date(Date.now() + 3 * 3_600_000) }); assert.equal(statusOf(expired.output, "PRECHECK"), "EXPIRED");
  const noApproval = await release(context, { env: { CONFIRM_PROD_RELEASE: "" } }); assert.equal(statusOf(noApproval.output, "HUMAN APPROVAL"), "REQUIRED"); assert.match(noApproval.output, /## RESULT\nHUMAN ACTION REQUIRED\n/);
  let asked = 0; await release(context, { env: { CONFIRM_PROD_RELEASE: "" }, prompt: async () => { asked++; return "h2-9"; } }); assert.equal(asked, 0, "the id is only asked for when everything else is in order");
  const fresh = releaseProject(t); const cli = releaseCli(t); let output = "";
  const code = await main(["prod-release", "--release", "h2-9"], { root: fresh.root, environment: { ...cli.environment, CONFIRM_PROD_RELEASE: `h2-9@${fresh.git.commit("HEAD").slice(0, 7)}` }, home: fresh.home, write: (text) => { output += text; }, supabase: cli.supabase, git: fresh.git, signals: quiet, prompt: async () => "h2-9" });
  assert.equal(code, EXIT.HUMAN_ACTION_REQUIRED); assert.equal(statusOf(output, "PRECHECK"), "REQUIRED"); assert.deepEqual(cli.calls(), [], "without a precheck nothing is linked");
});

test("before any write: a changed backup, production or staging changed, an extra pending migration, a moving target", async (t) => {
  const changedBackup = await prechecked(t); touchBackup(changedBackup);
  let out = await release(changedBackup); assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(out.output, /backup is not the file the precheck checked/); assert.deepEqual(out.calls, []);
  const cases = [
    ["production's schema changed", { schemaByRef: { [refs.production]: schemaAnswer({ extraTable: true }) } }, EXIT.CHECK_FAILED, /schema changed since the precheck/],
    ["production's data changed", { dbByRef: { [refs.production]: { ...database(), "public.patients": { ...database()["public.patients"], rows: [{ id: "p1", first_name: "Ana" }] } } } }, EXIT.CHECK_FAILED, /data changed since the precheck/],
    ["staging changed", { schemaAfterPush: schemaAnswer({ migrated: true, extraTable: true }) }, EXIT.CHECK_FAILED, /Staging changed since the precheck/],
    ["an extra pending migration", { appliedByRef: { [refs.production]: [] } }, EXIT.CHECK_FAILED, /migrations changed since the precheck/],
    ["a dry run with more", { dryRunExtra: ["20261021090000_second.sql"] }, EXIT.CHECK_FAILED, /dry run is not exactly the release/],
    ["the link moving away before the apply", { moveOnDryRun: refs.staging }, EXIT.TARGET_NOT_CONFIRMED, /could not be confirmed on production|no longer on production/],
  ];
  for (const [name, behaviour, code, pattern] of cases) {
    const context = await prechecked(t); const prod = await healthy(t, context); context.cli.set(behaviour);
    out = await release(context, prod);
    assert.equal(out.code, code, `${name}\n${out.output}`); assert.match(out.output, pattern, name);
    assert.equal(context.originMain(), context.made.mainBase, `${name}: main was not moved`); assertSafe(context, out, { prodWrites: 0 });
    assert.equal(stateOf(context.made).state, "PROD_PRECHECK_COMPLETE", name);
  }
});
function touchBackup(context) { const [file] = Object.values(context.dumps.files); spawnSync(process.execPath, ["-e", `require("fs").appendFileSync(${JSON.stringify(file)}, "x")`]); }

test("after the apply, every failure is exit 5, main is not moved, and the state says how far it got", async (t) => {
  const changedData = { ...database(), "public.patients": { ...database()["public.patients"], rows: [{ id: "p1", first_name: "Ana" }] } };
  const cases = [
    ["the history does not show it", { pushNoHistory: true }, /migration history is not what it should be/, "PROD MIGRATIONS"],
    ["the schema is not the expected one", { schemaAfterPushByRef: { [refs.production]: schemaAnswer({ migrated: true, extraTable: true }) } }, /not exactly what the release was rehearsed to be/, "PROD SCHEMA"],
    ["a smoke fails on production", { behaviourOnRef: { [refs.production]: { a_one: "error" } } }, /smokes failed on production/, "PROD SMOKES"],
    ["the data changed", { dbAfterPushByRef: { [refs.production]: changedData } }, /data is not what it was before/, "PROD SNAPSHOT"],
    ["residue left", { residueByRef: { [refs.production]: { users_example_invalid: 1, users_with_smoke_ids: 1, workspaces_with_smoke_ids: 0, workspaces_with_smoke_slugs: 0 } } }, /left something behind on production/, "PROD SNAPSHOT"],
    ["the apply fails", { pushFails: true }, /Applying the migrations to production failed/, "PROD APPLY"],
  ];
  for (const [name, behaviour, pattern, section] of cases) {
    const context = await prechecked(t); const prod = await healthy(t, context); context.cli.set(behaviour);
    const out = await release(context, prod);
    assert.equal(out.code, EXIT.FAILURE_AFTER_PROD_WRITE, `${name}\n${out.output}`); assert.match(out.output, pattern, name); assert.ok(["FAIL", "DRIFT", "DIFFERENT"].includes(statusOf(out.output, section)), `${name}: ${section}`);
    assert.equal(context.originMain(), context.made.mainBase, `${name}: main was not moved`); assertSafe(context, out, { prodWrites: behaviour.pushFails ? 0 : 1 });
    assert.equal(stateOf(context.made).state, behaviour.pushFails ? "PROD_PRECHECK_COMPLETE" : "PROD_APPLIED", name); assert.equal(stateOf(context.made).history.at(-1).result, "FAIL");
  }
});

test("main: a remote that moved is never pushed over", async (t) => {
  const context = await prechecked(t, { migrations: [] }); const prod = await healthy(t, context);
  const other = scratch(t, "bellis-other-"); spawnSync("git", ["clone", "-q", context.origin, other]);
  for (const args of [["config", "user.email", "x@example.invalid"], ["config", "user.name", "X"], ["commit", "-q", "--allow-empty", "-m", "someone else"], ["push", "-q", "origin", "main"]]) spawnSync("git", args, { cwd: other });
  const moved = context.originMain(); assert.notEqual(moved, context.made.mainBase);
  const out = await release(context, prod);
  assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(sectionOf(out.output, "MAIN"), new RegExp(`origin/main is ${moved.slice(0, 7)}, expected ${context.made.mainBase.slice(0, 7)}`));
  assert.equal(context.originMain(), moved, "nothing was pushed"); assert.equal(stateOf(context.made).state, "PROD_VERIFIED"); assertSafe(context, out);
});

test("the deployment: found and waited for; the alias may lag a little, but not for ever, and never on another project", async (t) => {
  // Never found: main has moved already, so it is exit 5 and says so.
  let context = await prechecked(t, { migrations: [] });
  let out = await release(context, { fetchImpl: github(), aliasUrl: (await healthy(t, context)).url });
  assert.equal(out.code, EXIT.FAILURE_AFTER_PROD_WRITE); assert.equal(statusOf(out.output, "MAIN"), "PASS"); assert.equal(statusOf(out.output, "DEPLOYMENT"), "FAIL"); assert.match(sectionOf(out.output, "DEPLOYMENT"), /main is already at/);
  assert.equal(stateOf(context.made).state, "MAIN_ADVANCED"); assertSafe(context, out);
  // The alias serves the old commit twice, then the new one.
  context = await prechecked(t, { migrations: [] }); const exact = await serve(t, site(context.head)); let served = 0;
  const alias = await serve(t, site(context.head, { versionRoute: () => (served++ < 2 ? json(version(old)) : json(version(context.head))) }));
  out = await release(context, { fetchImpl: github({ commit: context.head, url: exact }), aliasUrl: alias });
  assert.equal(out.code, EXIT.PASS, out.output); assert.ok(served >= 3); assert.equal(statusOf(out.output, "PROD ALIAS"), "PASS");
  // The alias never catches up.
  context = await prechecked(t, { migrations: [] });
  out = await release(context, { fetchImpl: github({ commit: context.head, url: await serve(t, site(context.head)) }), aliasUrl: await serve(t, site(old)) });
  assert.equal(out.code, EXIT.FAILURE_AFTER_PROD_WRITE); assert.equal(statusOf(out.output, "PROD ALIAS"), "FAIL"); assert.equal(stateOf(context.made).state, "MAIN_ADVANCED");
  // The alias on the wrong project.
  context = await prechecked(t, { migrations: [] });
  out = await release(context, { fetchImpl: github({ commit: context.head, url: await serve(t, site(context.head)) }), aliasUrl: await serve(t, site(context.head, { versionRoute: json(version(context.head, { url: stagingUrl })) })) });
  assert.equal(out.code, EXIT.FAILURE_AFTER_PROD_WRITE); assert.match(sectionOf(out.output, "PROD ALIAS"), /Supabase project hbvmcvemrkfovzhlpgys/);
  // The exact deployment does not serve the commit.
  context = await prechecked(t, { migrations: [] }); const stale = await serve(t, site(old));
  out = await release(context, { fetchImpl: github({ commit: context.head, url: stale }), aliasUrl: stale });
  assert.equal(out.code, EXIT.FAILURE_AFTER_PROD_WRITE); assert.equal(statusOf(out.output, "PROD VERSION"), "FAIL"); assert.match(sectionOf(out.output, "PROD VERSION"), /commit 8e8c395/);
  // A public page that does not answer.
  context = await prechecked(t, { migrations: [] }); const routes = site(context.head); routes["/pacientes"] = { status: 500, body: "" }; const broken = await serve(t, routes);
  out = await release(context, { fetchImpl: github({ commit: context.head, url: broken }), aliasUrl: broken });
  assert.equal(out.code, EXIT.FAILURE_AFTER_PROD_WRITE); assert.match(sectionOf(out.output, "TECH QA"), /\/pacientes: 500/); assert.equal(stateOf(context.made).state, "DEPLOY_PROD_VERIFIED");
});

test("once it went further than the precheck, it does not start again on its own", async (t) => {
  const context = await prechecked(t); context.cli.set({ pushNoHistory: true });
  assert.equal((await release(context, await healthy(t, context))).code, EXIT.FAILURE_AFTER_PROD_WRITE);
  context.cli.set({ pushNoHistory: false });
  const out = await release(context, await healthy(t, context));
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED); assert.match(out.output, /already went further on production \(PROD_APPLIED\)/); assert.deepEqual(out.calls, []);
});
