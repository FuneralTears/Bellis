import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projects } from "../scripts/assert-staging-env.mjs";
import { deploymentEnvironment, deploymentTargetProblem, projectRefFromUrl, stagingProjectRef, versionPayload } from "../lib/supabase-target.ts";

const sha = "e44ff17a8f7af3ff0dba04f1a2e385b57790a1ca";
const prodUrl = `https://${projects.production}.supabase.co`, stagingUrl = `https://${projects.staging}.supabase.co`;
const key = "sb_publishable_abcdefghijklmnopqrstuv";
const vercel = (extra) => ({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: sha, SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_SECRET_KEY: "sb_secret_never", DATABASE_URL: "postgres://postgres:hunter2@db.x/postgres", ...extra });

test("/api/version: production on main with the production project", () => {
  const body = versionPayload(vercel({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: prodUrl, VERCEL_DEPLOYMENT_ID: "dpl_7dQx2AbCdEf" }));
  assert.deepEqual(body, { service: "bellis", commit: sha, environment: "production", supabaseRef: projects.production, branch: "main", deploymentId: "dpl_7dQx2AbCdEf", consistent: true, problem: null });
});

test("/api/version: a preview on staging, and the two mixes that must never happen", () => {
  assert.deepEqual(versionPayload(vercel({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/x", SUPABASE_URL: stagingUrl })), { service: "bellis", commit: sha, environment: "preview", supabaseRef: projects.staging, branch: "feat/x", deploymentId: null, consistent: true, problem: null });
  const previewOnProduction = versionPayload(vercel({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/x", SUPABASE_URL: prodUrl }));
  assert.equal(previewOnProduction.consistent, false); assert.equal(previewOnProduction.problem, "production_project_outside_main");
  assert.equal(versionPayload(vercel({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: prodUrl })).problem, "preview_with_production_project");
  assert.equal(versionPayload(vercel({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: stagingUrl })).problem, "production_without_production_project");
});

test("/api/version: development, outside Vercel, takes the commit from git and never from a guess", () => {
  assert.deepEqual(versionPayload({ SUPABASE_URL: stagingUrl }, { localCommit: `${sha}\n` }), { service: "bellis", commit: sha, environment: "development", supabaseRef: projects.staging, branch: null, deploymentId: null, consistent: true, problem: null });
  assert.equal(versionPayload({ SUPABASE_URL: stagingUrl }).commit, "UNKNOWN"); assert.equal(versionPayload({ SUPABASE_URL: stagingUrl }).problem, "unknown_commit");
  assert.equal(versionPayload({ SUPABASE_URL: stagingUrl, VERCEL_GIT_COMMIT_SHA: sha }).commit, "UNKNOWN", "outside Vercel, Vercel's variables are not trusted");
  assert.equal(versionPayload(vercel({ VERCEL_ENV: "preview", SUPABASE_URL: stagingUrl }), { localCommit: "0".repeat(40) }).commit, sha, "on Vercel, git is never read");
});

test("/api/version: missing or malformed metadata is UNKNOWN and inconsistent", () => {
  for (const commit of [undefined, "", "e44ff17", "not-a-sha", `${sha}x`, "E".repeat(41)]) { const body = versionPayload(vercel({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: commit, SUPABASE_URL: stagingUrl })); assert.equal(body.commit, "UNKNOWN", String(commit)); assert.equal(body.consistent, false); }
  assert.equal(versionPayload(vercel({ VERCEL_GIT_COMMIT_SHA: sha.toUpperCase(), VERCEL_ENV: "preview", SUPABASE_URL: stagingUrl })).commit, sha);
  const noEnv = versionPayload(vercel({ SUPABASE_URL: stagingUrl })); assert.equal(noEnv.environment, "unknown"); assert.equal(noEnv.problem, "unknown_environment");
  assert.equal(versionPayload(vercel({ VERCEL_ENV: "staging", SUPABASE_URL: stagingUrl })).environment, "unknown", "only the three names are environments");
  const noProject = versionPayload(vercel({ VERCEL_ENV: "preview" })); assert.equal(noProject.supabaseRef, "UNKNOWN"); assert.equal(noProject.problem, "no_supabase_project");
  assert.equal(versionPayload(vercel({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/<script>", VERCEL_DEPLOYMENT_ID: "x; drop", SUPABASE_URL: stagingUrl })).branch, null);
});

test("/api/version: the project ref only, derived from the address the app uses", () => {
  assert.equal(projectRefFromUrl(prodUrl), projects.production); assert.equal(projectRefFromUrl(`${stagingUrl}/`), projects.staging);
  for (const url of [undefined, "", "http://x.supabase.co", `${prodUrl}.evil.example`, `https://user:pass@${projects.production}.supabase.co`]) assert.equal(projectRefFromUrl(url), null, String(url));
  assert.equal(stagingProjectRef, projects.staging);
  assert.equal(deploymentEnvironment({}), "development"); assert.equal(deploymentEnvironment({ VERCEL: "1", VERCEL_ENV: "production" }), "production");
  assert.equal(deploymentTargetProblem(stagingUrl, {}), null); assert.equal(deploymentTargetProblem(prodUrl, {}), null, "local work is checked before dev and build");
});

test("/api/version: no key, no address, no setting and nothing that looks secret in the answer", () => {
  const body = versionPayload(vercel({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: prodUrl, VERCEL_DEPLOYMENT_ID: "dpl_7dQx2AbCdEf" }));
  const text = JSON.stringify(body);
  assert.deepEqual(Object.keys(body).sort(), ["branch", "commit", "consistent", "deploymentId", "environment", "problem", "service", "supabaseRef"]);
  for (const needle of [key, "sb_", "supabase.co", "hunter2", "postgres://", "SUPABASE", "VERCEL", "eyJ", "secret", "password", "token"]) assert.ok(!text.includes(needle), needle);
  const route = readFileSync(new URL("../app/api/version/route.ts", import.meta.url), "utf8");
  assert.match(route, /versionPayload\(process\.env/); assert.doesNotMatch(route, /PUBLISHABLE_KEY|SECRET|process\.env\)\s*\)/);
  assert.match(route, /if \(process\.env\.VERCEL\) return undefined;/, "git is read only outside Vercel");
});
