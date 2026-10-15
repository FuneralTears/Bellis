/**
 * Release tooling: which commit, environment and Supabase project a deployment is really serving. It only looks:
 * it never pushes, deploys, promotes, changes an alias or touches Vercel's settings.
 *
 * The truth is /api/version (lib/supabase-target.ts `versionPayload`), read from the exact URL of the deployment of a
 * commit, and for production also from the production alias, which has to serve the same thing. A few pages are
 * opened without credentials to see they answer and carry nothing secret. A deployment behind Vercel's login cannot
 * be read from here: that is reported as needing a person, never as a pass, and no cookie or token is used or kept.
 *
 * The exact URL can be given, or found through GitHub's public deployments API (the deployments Vercel reports for
 * a commit), which needs no token. If it cannot be found without doubt, a person gives it.
 */
import { environments } from "../lib/target.mjs";

export const productionAlias = "https://bellis-six.vercel.app";
export const repository = "FuneralTears/Bellis";
const versionKeys = ["branch", "commit", "consistent", "deploymentId", "environment", "problem", "service", "supabaseRef"];
export const expectedRefFor = (environment) => (environment === "production" ? environments.production.ref : environments.staging.ref);
const secretPatterns = [/sb_secret_[A-Za-z0-9_-]+/, /service_role/i, /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"']+:[^\s/@"']+@/i, /\b(SUPABASE_[A-Z_]+|VERCEL_[A-Z_]+|DATABASE_URL|POSTGRES_[A-Z_]+)\b\s*["']?\s*[:=]/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

/** The origin of a URL, http(s) only, with no credentials in it. Null otherwise. */
export function cleanOrigin(url) {
  try { const parsed = new URL(String(url)); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null; return parsed.origin; } catch { return null; }
}
/** Whether a piece of text carries something secret. A JWT counts only when it says it is for service_role. */
export function secretsIn(text) {
  const found = secretPatterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source.slice(0, 20));
  for (const token of String(text).match(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) ?? []) {
    try { const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); if (payload?.role && payload.role !== "anon") found.push(`a JWT for ${payload.role === "service_role" ? "service_role" : "a role that is not anon"}`); } catch { /* not a JWT */ }
  }
  return found;
}

/**
 * GET a URL without following redirects, with a time limit. Returns { kind, status, contentType, text } where kind is
 * "ok", "protected" (Vercel's login or SSO: 401, 403, or a redirect to it), "redirect", "http" (another status),
 * "timeout" or "network". Cookies are never sent or kept.
 */
export async function fetchPage(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "manual", signal: controller.signal, headers: { accept: "application/json, text/html;q=0.5" } });
    const status = response.status; const location = response.headers.get("location") ?? ""; const contentType = response.headers.get("content-type") ?? "";
    const text = status >= 300 && status < 400 ? "" : await response.text();
    if (status === 401 || status === 403 || (status >= 300 && status < 400 && /vercel\.com\/(login|sso)|_vercel_sso|sso-api/i.test(location)) || /vercel-authentication|Authentication Required|_vercel_sso/i.test(text.slice(0, 4000)))
      return { kind: "protected", status, contentType, text: "" };
    if (status >= 300 && status < 400) return { kind: "redirect", status, contentType, text: "", location: cleanOrigin(location) ? location : "(not shown)" };
    if (status !== 200) return { kind: "http", status, contentType, text: "" };
    return { kind: "ok", status, contentType, text };
  } catch (error) { return { kind: error?.name === "AbortError" ? "timeout" : "network", status: null, contentType: "", text: "" }; }
  finally { clearTimeout(timer); }
}

/**
 * Checks what /api/version said. Returns { ok, problems, observed }: the shape has to be exactly the expected one,
 * and commit, environment and project have to be the expected ones, consistent with each other.
 */
export function checkVersion(page, expected) {
  const problems = []; let body = null;
  if (page.kind !== "ok") return { ok: false, problems: [page.kind === "protected" ? "behind Vercel's login" : page.kind === "timeout" ? "no answer in time" : page.kind === "network" ? "could not be reached" : `HTTP ${page.status}`], observed: null };
  if (!/application\/json/i.test(page.contentType)) return { ok: false, problems: [`not JSON (${page.contentType.split(";")[0] || "no content type"})`], observed: null };
  try { body = JSON.parse(page.text); } catch { return { ok: false, problems: ["the JSON could not be read"], observed: null }; }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== versionKeys.join()) return { ok: false, problems: ["the answer is not the shape /api/version answers with"], observed: null };
  if (secretsIn(page.text).length) problems.push("the answer carries something secret");
  const observed = { commit: String(body.commit), environment: String(body.environment), supabaseRef: String(body.supabaseRef), branch: body.branch === null ? null : String(body.branch), deploymentId: body.deploymentId === null ? null : String(body.deploymentId) };
  if (body.service !== "bellis") problems.push("it is not Bellis");
  if (!/^[0-9a-f]{40}$/.test(observed.commit)) problems.push("the commit is UNKNOWN: the deployment cannot say what it serves");
  else if (observed.commit !== expected.commit) problems.push(`commit ${observed.commit.slice(0, 7)}, expected ${String(expected.commit).slice(0, 7)}`);
  if (observed.environment !== expected.environment) problems.push(`environment ${observed.environment}, expected ${expected.environment}`);
  if (observed.supabaseRef !== expected.supabaseRef) problems.push(`Supabase project ${observed.supabaseRef}, expected ${expected.supabaseRef}`);
  // The same rules as the deployment's own guard, checked again from outside.
  if (observed.environment === "production" && observed.supabaseRef === environments.staging.ref) problems.push("a production deployment on the staging project");
  if (observed.environment === "preview" && observed.supabaseRef === environments.production.ref) problems.push("a preview deployment on the production project");
  if (body.consistent !== true) problems.push(`the deployment says it is not consistent (${/^[a-z_]{1,60}$/.test(String(body.problem)) ? body.problem : "no reason"})`);
  return { ok: problems.length === 0, problems, observed };
}

/** The pages a person would open, opened without credentials: they have to answer, and carry nothing secret. */
export async function checkPages(origin, expected, options = {}) {
  const results = [];
  for (const path of ["/", "/ingresar", "/api/supabase-config"]) {
    const page = await fetchPage(`${origin}${path}`, options); const problems = [];
    if (page.kind === "protected") { results.push({ path, ok: false, protected: true, problems: ["behind Vercel's login"] }); continue; }
    if (page.kind !== "ok" && !(page.kind === "redirect" && path !== "/api/supabase-config")) problems.push(page.kind === "http" ? `HTTP ${page.status}` : page.kind);
    if (page.text && secretsIn(page.text).length) problems.push("it carries something secret");
    if (path === "/api/supabase-config" && page.kind === "ok") {
      let body = null; try { body = JSON.parse(page.text); } catch { /* reported below */ }
      const ref = /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)\/?$/.exec(String(body?.url ?? ""))?.[1];
      if (!body || typeof body.publishableKey !== "string") problems.push("it does not answer with an address and a publishable key");
      else if (ref !== expected.supabaseRef) problems.push(`it hands out project ${ref ?? "unknown"}, expected ${expected.supabaseRef}`);
    }
    results.push({ path, ok: problems.length === 0, problems, status: page.status });
  }
  return results;
}

/**
 * The exact URL of the deployment Vercel made for `commit` in `environment` ("production" or "preview"), from
 * GitHub's public deployments API: the newest deployment of that commit and environment, and its newest successful
 * status. Returns { ok, url } or { ok: false, reason }. Nothing is guessed: no deployment, no success, or an answer
 * that cannot be read is a reason for a person to give the URL.
 */
export async function discoverDeployment({ commit, environment, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const name = environment === "production" ? "Production" : "Preview";
  const read = async (url) => { const page = await fetchPage(url, { fetchImpl, timeoutMs }); if (page.kind !== "ok") return null; try { return JSON.parse(page.text); } catch { return null; } };
  const list = await read(`https://api.github.com/repos/${repository}/deployments?sha=${commit}&environment=${encodeURIComponent(name)}&per_page=20`);
  if (!Array.isArray(list)) return { ok: false, reason: "GitHub's deployments could not be read" };
  const mine = list.filter((item) => item?.sha === commit && item?.environment === name).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!mine.length) return { ok: false, reason: `GitHub lists no ${name} deployment of ${commit.slice(0, 7)} (yet)` };
  const statuses = await read(`https://api.github.com/repos/${repository}/deployments/${Number(mine[0].id)}/statuses?per_page=20`);
  if (!Array.isArray(statuses)) return { ok: false, reason: "the deployment's status could not be read" };
  const success = statuses.find((item) => item?.state === "success");
  if (!success) return { ok: false, reason: `the newest ${name} deployment of ${commit.slice(0, 7)} has not succeeded (${statuses[0]?.state ?? "no status"})` };
  const origin = cleanOrigin(success.environment_url || success.target_url);
  return origin ? { ok: true, url: origin } : { ok: false, reason: "the deployment's URL could not be read" };
}

/**
 * Verifies a deployment. `url` is its exact URL; `alias` (production) is checked too and has to serve the same.
 * Returns { status, protected, exact, alias, pages, problems }, where status is:
 *   "PASS"     the exact deployment and the alias (if any) serve what was expected
 *   "PARTIAL"  the exact URL is behind Vercel's login, so it was not read, but the alias was, and it serves exactly
 *              what was expected: a person still has to confirm the exact deployment
 *   "HUMAN"    the exact URL is behind Vercel's login and there is no alias to read (a Preview)
 *   "FAIL"     anything else
 * The alias is always read, whatever happened with the exact URL. A protected URL is never reported as verified.
 */
export async function verifyDeployment({ url, alias = null, expected, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const origin = cleanOrigin(url); if (!origin) return { status: "FAIL", protected: false, problems: ["the deployment URL is not an http(s) address without credentials"], exact: null, alias: null, pages: [] };
  const options = { fetchImpl, timeoutMs };
  const exactPage = await fetchPage(`${origin}/api/version`, options); const isProtected = exactPage.kind === "protected";
  const exact = { url: origin, http: exactPage.kind === "ok" ? "PASS" : "FAIL", status: exactPage.status, ...checkVersion(exactPage, expected) };
  let aliasResult = null;
  if (alias) {
    const aliasOrigin = cleanOrigin(alias);
    const page = aliasOrigin ? await fetchPage(`${aliasOrigin}/api/version`, options) : { kind: "network", status: null, contentType: "", text: "" };
    aliasResult = { url: aliasOrigin, status: page.status, ...checkVersion(page, expected) };
  }
  const humanLine = "the exact deployment is behind Vercel's login: a person has to confirm it";
  if (isProtected) {
    if (!aliasResult) return { status: "HUMAN", protected: true, exact, alias: null, pages: [], problems: ["the deployment is behind Vercel's login: a person has to look at it"] };
    if (!aliasResult.ok) return { status: "FAIL", protected: true, exact, alias: aliasResult, pages: [], problems: [`exact deployment: ${humanLine}`, ...aliasResult.problems.map((item) => `production alias: ${item}`)] };
    const pages = await checkPages(aliasResult.url, expected, options);
    const pageProblems = pages.filter((page) => !page.ok).map((page) => `${page.path}: ${page.problems.join(", ")}`);
    return { status: pageProblems.length ? "FAIL" : "PARTIAL", protected: true, exact, alias: aliasResult, pages, problems: [`exact deployment: ${humanLine}`, ...pageProblems] };
  }
  const pages = exact.ok ? await checkPages(origin, expected, options) : [];
  const problems = [...exact.problems.map((item) => `exact deployment: ${item}`), ...(aliasResult ? aliasResult.problems.map((item) => `production alias: ${item}`) : []), ...pages.filter((page) => !page.ok).map((page) => `${page.path}: ${page.problems.join(", ")}`)];
  return { status: problems.length ? "FAIL" : "PASS", protected: false, exact, alias: aliasResult, pages, problems };
}

/** The pages of a release's technical QA, opened without a login. */
export const qaPaths = Object.freeze(["/", "/ingresar", "/registro", "/dashboard", "/pro", "/pacientes", "/seguimientos", "/automatizaciones", "/notificaciones", "/admin", "/api/version", "/api/supabase-config"]);
/** Every QA page has to answer (a redirect counts) and carry nothing secret. Returns { ok, results }. */
export async function techQa(origin, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const results = [];
  for (const path of qaPaths) { const page = await fetchPage(`${origin}${path}`, { fetchImpl, timeoutMs }); const ok = (page.kind === "ok" || page.kind === "redirect") && !(page.text && secretsIn(page.text).length); results.push({ path, ok, status: page.status ?? page.kind }); }
  return { ok: results.every((item) => item.ok), results };
}
