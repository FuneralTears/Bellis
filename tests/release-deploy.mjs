/**
 * `bellis:deploy-check`, against local HTTP servers that answer the way a deployment does: /api/version is made with
 * the very function the real endpoint uses (lib/supabase-target.ts). GitHub's deployments API is answered locally
 * too. Nothing here reaches Vercel, GitHub or Supabase.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { checkVersion, discoverDeployment, fetchPage, secretsIn, verifyDeployment } from "../scripts/release/deploy/verify.mjs";
import { EXIT } from "../scripts/release/lib/report.mjs";
import { versionPayload } from "../lib/supabase-target.ts";
import { releaseCli, releaseProject } from "./fixtures/release-project.mjs";
import { forbidden, refs } from "./fixtures/release-harness.mjs";

const sha = "e44ff17a8f7af3ff0dba04f1a2e385b57790a1ca"; const old = "8e8c3958b903c6734d861a0f72e7c6f26667b616";
const prodUrl = `https://${refs.production}.supabase.co`, stagingUrl = `https://${refs.staging}.supabase.co`;
const version = (env, { commit = sha, url = env === "production" ? prodUrl : stagingUrl, branch = env === "production" ? "main" : "feat/x" } = {}) => versionPayload({ VERCEL: "1", VERCEL_ENV: env, VERCEL_GIT_COMMIT_SHA: commit, VERCEL_GIT_COMMIT_REF: branch, SUPABASE_URL: url });
const json = (body, status = 200) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const html = (body, status = 200) => ({ status, headers: { "content-type": "text/html" }, body });
/** The pages a healthy deployment answers. */
const site = (env, overrides = {}) => ({ "/api/version": json(version(env)), "/": html("<html>Bellis</html>"), "/ingresar": html("<html>Ingresar</html>"),
  "/api/supabase-config": json({ url: env === "production" ? prodUrl : stagingUrl, publishableKey: "sb_publishable_abcdefghijklmnop" }), ...overrides });

/** A local server answering `routes` ({ path: { status, headers, body, delay } }). Closed when the test ends. */
async function serve(t, routes) {
  const server = createServer((request, response) => {
    const route = routes[request.url.split("?")[0]] ?? { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
    setTimeout(() => { response.writeHead(route.status, route.headers ?? {}); response.end(route.body ?? ""); }, route.delay ?? 0);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const expected = (env, extra = {}) => ({ commit: sha, environment: env, supabaseRef: env === "production" ? refs.production : refs.staging, ...extra });
const assertClean = (text) => { for (const secret of [...forbidden, "sb_publishable_abcdefghijklmnop"]) assert.ok(!text.includes(secret), `leaked: ${secret}`); };

test("valid production and preview deployments pass, pages included", async (t) => {
  const production = await serve(t, site("production"));
  let seen = await verifyDeployment({ url: production, alias: production, expected: expected("production") });
  assert.equal(seen.status, "PASS", seen.problems.join()); assert.equal(seen.exact.observed.commit, sha); assert.equal(seen.alias.ok, true); assert.deepEqual(seen.pages.map((page) => [page.path, page.ok]), [["/", true], ["/ingresar", true], ["/api/supabase-config", true]]);
  const preview = await serve(t, site("preview"));
  seen = await verifyDeployment({ url: preview, expected: expected("preview") }); assert.equal(seen.status, "PASS", seen.problems.join()); assert.equal(seen.alias, null);
});

test("commit, environment and project mismatches fail; UNKNOWN fails closed", async (t) => {
  const check = async (routes, want, pattern) => { const seen = await verifyDeployment({ url: await serve(t, routes), expected: want }); assert.equal(seen.status, "FAIL"); assert.match(seen.problems.join(" | "), pattern); };
  await check(site("preview", { "/api/version": json(version("preview", { commit: old })) }), expected("preview"), /commit 8e8c395, expected e44ff17/);
  await check(site("preview"), expected("production", { supabaseRef: refs.staging }), /environment preview, expected production/);
  await check(site("preview"), expected("preview", { supabaseRef: refs.production }), /Supabase project hbvmcvemrkfovzhlpgys, expected pinfdbvfzoratsntjgah/);
  await check(site("preview", { "/api/version": json(versionPayload({ VERCEL: "1", VERCEL_ENV: "preview", SUPABASE_URL: stagingUrl })) }), expected("preview"), /the commit is UNKNOWN/);
  await check(site("production", { "/api/version": json(version("production", { url: stagingUrl })) }), expected("production", { supabaseRef: refs.staging }), /a production deployment on the staging project.*not consistent \(production_without_production_project\)/);
  await check(site("preview", { "/api/version": json(version("preview", { url: prodUrl, branch: "main" })) }), expected("preview", { supabaseRef: refs.production }), /a preview deployment on the production project/);
  await check(site("preview", { "/api/supabase-config": json({ url: prodUrl, publishableKey: "sb_publishable_x" }) }), expected("preview"), /hands out project pinfdbvfzoratsntjgah, expected hbvmcvemrkfovzhlpgys/);
});

test("broken answers fail: malformed JSON, another shape, HTML, 404, 500, a redirect, a timeout", async (t) => {
  const check = async (route, pattern) => { const seen = await verifyDeployment({ url: await serve(t, site("preview", { "/api/version": route })), expected: expected("preview"), timeoutMs: 300 }); assert.equal(seen.status, "FAIL", JSON.stringify(route).slice(0, 60)); assert.match(seen.problems.join(), pattern); };
  await check({ status: 200, headers: { "content-type": "application/json" }, body: "{ not json" }, /could not be read/);
  await check(json({ ...version("preview"), extra: 1 }), /not the shape/);
  await check(json({ commit: sha }), /not the shape/);
  await check(html("<html>hello</html>"), /not JSON \(text\/html\)/);
  await check({ status: 404, body: "" }, /HTTP 404/); await check({ status: 500, body: "" }, /HTTP 500/);
  await check({ status: 302, headers: { location: "/elsewhere" } }, /HTTP 302/);
  await check({ ...json(version("preview")), delay: 1_000 }, /no answer in time/);
});

test("Vercel's login (redirect, 401 or its page) is never a pass: it needs a person", async (t) => {
  for (const route of [{ status: 307, headers: { location: "https://vercel.com/login?next=%2Fsso-api" } }, { status: 401, headers: { "content-type": "text/html" }, body: "<html>Authentication Required</html>" }, html("<html><title>Vercel Authentication</title>vercel-authentication</html>")]) {
    const seen = await verifyDeployment({ url: await serve(t, { "/api/version": route }), expected: expected("preview") });
    assert.equal(seen.status, "HUMAN"); assert.equal(seen.protected, true); assert.match(seen.problems[0], /behind Vercel's login/);
  }
});

test("production: the exact deployment and the alias have to serve the same commit and project", async (t) => {
  const exact = await serve(t, site("production"));
  let seen = await verifyDeployment({ url: exact, alias: await serve(t, site("production", { "/api/version": json(version("production", { commit: old })) })), expected: expected("production") });
  assert.equal(seen.status, "FAIL"); assert.match(seen.problems.join(), /production alias: commit 8e8c395, expected e44ff17/); assert.equal(seen.exact.ok, true, "the exact deployment itself is fine");
  seen = await verifyDeployment({ url: exact, alias: await serve(t, site("production", { "/api/version": json(version("production", { url: stagingUrl })) })), expected: expected("production") });
  assert.equal(seen.status, "FAIL"); assert.match(seen.problems.join(), /production alias: Supabase project hbvmcvemrkfovzhlpgys/);
  seen = await verifyDeployment({ url: await serve(t, site("production", { "/api/version": json(version("production", { commit: old })) })), alias: exact, expected: expected("production") });
  assert.equal(seen.status, "FAIL"); assert.match(seen.problems.join(), /exact deployment: commit 8e8c395/); assert.equal(seen.alias.ok, true);
});

test("secrets: found in what a deployment answers, and never repeated", async (t) => {
  const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.c2lnbmF0dXJlc2lnbg`;
  assert.deepEqual(secretsIn(`{"key":"${jwt("anon")}"}`), []); assert.ok(secretsIn(`{"key":"${jwt("service_role")}"}`).length);
  assert.ok(secretsIn("sb_secret_abcdef").length); assert.ok(secretsIn("postgres://postgres:hunter2@db/x").length); assert.ok(secretsIn('{"SUPABASE_SECRET_KEY": "x"}').length);
  assert.deepEqual(secretsIn('{"url":"https://x.supabase.co","publishableKey":"sb_publishable_abc"}'), []);
  const leaky = await serve(t, site("preview", { "/api/supabase-config": json({ url: stagingUrl, publishableKey: "sb_publishable_x", serviceKey: "sb_secret_never_show_this" }), "/": html(`<script>window.k="${jwt("service_role")}"</script>`) }));
  const seen = await verifyDeployment({ url: leaky, expected: expected("preview") });
  assert.equal(seen.status, "FAIL"); assert.match(seen.problems.join(), /\/: it carries something secret/); assert.match(seen.problems.join(), /\/api\/supabase-config: it carries something secret/);
  assertClean(JSON.stringify(seen));
  assert.equal((await fetchPage("http://127.0.0.1:1/never")).kind, "network");
  assert.deepEqual(checkVersion({ kind: "ok", status: 200, contentType: "application/json", text: JSON.stringify(version("preview")) }, expected("preview")).problems, []);
});

/** GitHub's deployments API, answered locally: `deployments` for the commit, and statuses per deployment. */
function github({ deployments = [], statuses = {} } = {}) {
  return async (url, options) => {
    const target = String(url);
    if (!target.startsWith("https://api.github.com/")) return fetch(url, options);
    const status = /\/deployments\/(\d+)\/statuses/.exec(target);
    const body = status ? statuses[status[1]] ?? [] : deployments;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("discovery: the newest successful deployment of the commit, or a reason for a person", async (t) => {
  const url = await serve(t, site("preview"));
  const fetchImpl = github({ deployments: [{ id: 1, sha, environment: "Preview", created_at: "2026-10-14T10:00:00Z" }, { id: 2, sha, environment: "Preview", created_at: "2026-10-14T11:00:00Z" }], statuses: { 2: [{ state: "success", environment_url: url }], 1: [{ state: "success", environment_url: "https://old.example" }] } });
  assert.deepEqual(await discoverDeployment({ commit: sha, environment: "preview", fetchImpl }), { ok: true, url });
  assert.match((await discoverDeployment({ commit: sha, environment: "preview", fetchImpl: github() })).reason, /lists no Preview deployment/);
  assert.match((await discoverDeployment({ commit: sha, environment: "preview", fetchImpl: github({ deployments: [{ id: 3, sha, environment: "Preview", created_at: "x" }], statuses: { 3: [{ state: "pending" }] } }) })).reason, /has not succeeded \(pending\)/);
  assert.match((await discoverDeployment({ commit: sha, environment: "production", fetchImpl: github({ deployments: [{ id: 4, sha, environment: "Preview", created_at: "x" }] }) })).reason, /lists no Production deployment/);
});

/** A release at STAGING_COMPLETE, through the fake CLI, for the command's tests. */
async function stagedRelease(t) {
  const made = releaseProject(t); const cli = releaseCli(t);
  const run = await main(["staging", "--release", "h2-9"], { root: made.root, environment: cli.environment, home: made.home, write: () => {}, supabase: cli.supabase, git: made.git, signals: { on() {}, off() {} }, runLocal: () => ({ ok: true, summary: "fine" }) });
  assert.equal(run, EXIT.PASS); return { made, cli, head: made.git.commit("HEAD") };
}
async function invoke(argv, { made, cli, fetchImpl = fetch }) {
  let output = ""; const code = await main(argv, { root: made.root, environment: cli.environment, home: made.home, write: (text) => { output += text; }, supabase: cli.supabase, git: made.git, fetchImpl });
  return { code, output };
}
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
const statusOf = (output, name) => sectionOf(output, name).split("\n")[1];
const deployState = (made) => { const path = join(made.home, "Bellis-Releases", "h2-9", "deploy-state.json"); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).data : null; };

test("command: a preview verified automatically is recorded as DEPLOY_PREVIEW_VERIFIED", async (t) => {
  const { made, cli, head } = await stagedRelease(t);
  const url = await serve(t, site("preview", { "/api/version": json(version("preview", { commit: head })) }));
  const out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "preview", "--url", url], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output);
  for (const [section, status] of Object.entries({ DEPLOYMENT: "INFO", HTTP: "PASS", COMMIT: "PASS", ENVIRONMENT: "PASS", "SUPABASE REF": "PASS", ALIAS: "N/A", "PREVIEW PROTECTION": "NONE", "VERIFICATION MODE": "AUTOMATIC", STATE: "DEPLOY_PREVIEW_VERIFIED" })) assert.equal(statusOf(out.output, section), status, section);
  assert.match(sectionOf(out.output, "COMMIT"), new RegExp(`expected ${head}\\n- observed ${head}`));
  const saved = deployState(made).preview; assert.equal(saved.mode, "automatic"); assert.equal(saved.url, url); assert.equal(saved.observedCommit, head); assert.equal(saved.supabaseRef, refs.staging);
  assertClean(out.output); for (const file of readdirSync(join(made.home, "Bellis-Releases", "h2-9"))) assertClean(readFileSync(join(made.home, "Bellis-Releases", "h2-9", file), "utf8"));
});

test("command: a protected preview asks for a person, who confirms it with the release id", async (t) => {
  const { made, cli, head } = await stagedRelease(t);
  const url = await serve(t, { "/api/version": { status: 401, headers: { "content-type": "text/html" }, body: "<html>Authentication Required</html>" } });
  let out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "preview", "--url", url], { made, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED); assert.equal(statusOf(out.output, "PREVIEW PROTECTION"), "HUMAN_ACTION_REQUIRED"); assert.match(sectionOf(out.output, "PREVIEW PROTECTION"), /--confirm-human h2-9/);
  assert.match(out.output, /## RESULT\nHUMAN ACTION REQUIRED\n/); assert.equal(deployState(made), null, "nothing recorded");
  out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "preview", "--url", url, "--confirm-human", "h2-8"], { made, cli });
  assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE); assert.match(out.output, /type the release id again/); assert.equal(deployState(made), null);
  out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "production", "--url", url, "--confirm-human", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE, "production is never confirmed by hand");
  out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "preview", "--url", url, "--confirm-human", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(statusOf(out.output, "VERIFICATION MODE"), "HUMAN CONFIRMED"); assert.equal(statusOf(out.output, "STATE"), "DEPLOY_PREVIEW_VERIFIED");
  const saved = deployState(made).preview; assert.deepEqual([saved.mode, saved.actor, saved.observedCommit, saved.expectedCommit], ["human", "human-confirmed", null, head]);
});

test("command: production checks the exact deployment and the alias; a release needs staging done", async (t) => {
  const { made, cli, head } = await stagedRelease(t);
  const exact = await serve(t, site("production", { "/api/version": json(version("production", { commit: head })) }));
  const oldAlias = await serve(t, site("production", { "/api/version": json(version("production", { commit: old })) }));
  let out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "production", "--url", exact, "--alias", oldAlias], { made, cli });
  assert.equal(out.code, EXIT.CHECK_FAILED); assert.equal(statusOf(out.output, "ALIAS"), "FAIL"); assert.equal(statusOf(out.output, "COMMIT"), "PASS"); assert.equal(deployState(made), null);
  out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "production", "--url", exact, "--alias", exact], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(statusOf(out.output, "STATE"), "DEPLOY_PROD_VERIFIED"); assert.equal(deployState(made).production.alias, exact);
  const fresh = releaseProject(t);
  out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "preview", "--url", exact], { made: fresh, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED); assert.match(out.output, /has not completed staging/);
});

test("command: without a release, an explicit commit; discovery that fails asks for a person; development works", async (t) => {
  const { made, cli, head } = await stagedRelease(t);
  const local = await serve(t, site("development", { "/api/version": json(versionPayload({ SUPABASE_URL: stagingUrl }, { localCommit: head })) }));
  let out = await invoke(["deploy-check", "--expected-env", "development", "--url", local, "--expected-commit", "HEAD"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output); assert.match(sectionOf(out.output, "STATE"), /nothing recorded/);
  out = await invoke(["deploy-check", "--expected-env", "development", "--url", local], { made, cli }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE);
  out = await invoke(["deploy-check", "--expected-env", "staging", "--url", local, "--expected-commit", "HEAD"], { made, cli }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE);
  out = await invoke(["deploy-check", "--expected-env", "preview", "--url", "https://user:pass@example.com", "--expected-commit", "HEAD"], { made, cli }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE);
  out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "preview"], { made, cli, fetchImpl: github() });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED); assert.equal(statusOf(out.output, "DEPLOYMENT"), "HUMAN"); assert.match(sectionOf(out.output, "DEPLOYMENT"), /give the exact deployment URL with --url/);
  const found = await serve(t, site("preview", { "/api/version": json(version("preview", { commit: head })) }));
  out = await invoke(["deploy-check", "--release", "h2-9", "--expected-env", "preview"], { made, cli, fetchImpl: github({ deployments: [{ id: 9, sha: head, environment: "Preview", created_at: "2026-10-14T10:00:00Z" }], statuses: { 9: [{ state: "success", environment_url: found }] } }) });
  assert.equal(out.code, EXIT.PASS, out.output); assert.match(sectionOf(out.output, "DEPLOYMENT"), /found through GitHub's deployments of this commit/);
});
