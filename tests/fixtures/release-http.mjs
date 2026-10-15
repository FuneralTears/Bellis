/**
 * Deployments for the tests of the release tooling: local HTTP servers that answer the way a Bellis deployment does
 * (/api/version made with the very function the real endpoint uses), and GitHub's deployments API answered locally.
 * Nothing here reaches Vercel or GitHub.
 */
import { createServer } from "node:http";
import { versionPayload } from "../../lib/supabase-target.ts";
import { refs } from "./release-harness.mjs";

export const prodUrl = `https://${refs.production}.supabase.co`;
export const stagingUrl = `https://${refs.staging}.supabase.co`;
export const json = (body, status = 200) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const html = (body, status = 200) => ({ status, headers: { "content-type": "text/html" }, body });
export const login = { status: 401, headers: { "content-type": "text/html" }, body: "<html>Authentication Required</html>" };
/** What /api/version answers for a production deployment of `commit`. */
export const prodVersion = (commit, { url = prodUrl, deploymentId = "dpl_7dQx2AbCdEf" } = {}) => versionPayload({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: commit, VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: url, VERCEL_DEPLOYMENT_ID: deploymentId });
/** Production as a person would see it without a login, serving `commit`. `versionRoute` replaces /api/version. */
export const prodSite = (commit, { versionRoute, deploymentId } = {}) => ({ "/api/version": versionRoute ?? json(prodVersion(commit, { deploymentId })), "/api/supabase-config": json({ url: prodUrl, publishableKey: "sb_publishable_abcdefghijklmnop" }),
  ...Object.fromEntries(["/", "/ingresar", "/registro", "/dashboard", "/pro", "/pacientes", "/seguimientos", "/automatizaciones", "/notificaciones", "/admin"].map((path) => [path, html(`<html>${path}</html>`)])) });

/** A local server answering `routes` (a route can be a function, called on each request). Closed when the test ends. */
export async function serve(t, routes) {
  const server = createServer((request, response) => { const found = routes[request.url.split("?")[0]]; const route = typeof found === "function" ? found() : found ?? { status: 404, body: "" }; response.writeHead(route.status, route.headers ?? {}); response.end(route.body ?? ""); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
/** GitHub's deployments API, answered locally with one Production deployment of `commit` at `url`; anything else goes through. */
export const github = ({ commit, url, state = "success" } = {}) => async (target, options) => {
  if (!String(target).startsWith("https://api.github.com/")) return fetch(target, options);
  const body = /\/statuses/.test(target) ? (url ? [{ state, environment_url: url }] : []) : (url ? [{ id: 77, sha: commit, environment: "Production", created_at: "2026-10-14T12:00:00Z" }] : []);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
