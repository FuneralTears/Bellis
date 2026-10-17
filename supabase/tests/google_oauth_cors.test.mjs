import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { configuredOrigins, sessionCorsHeaders } from "../functions/_shared/origin-policy.ts";

// Staging as it is configured: its stable site origin, and no additional (Preview) origins.
const site = "https://bellis-git-staging-team.vercel.app";
const staging = configuredOrigins(site, "");
const withPreview = configuredOrigins(site, "https://bellis-abc123def-team.vercel.app");
const source = readFileSync(new URL("../functions/bellis-google-oauth/index.ts", import.meta.url), "utf8");
const mercadoPago = readFileSync(new URL("../functions/bellis-mp-oauth/index.ts", import.meta.url), "utf8");

test("CORS: local development (localhost:5173) is echoed back", () => {
  const headers = sessionCorsHeaders("http://localhost:5173", staging, site);
  assert.equal(headers["Access-Control-Allow-Origin"], "http://localhost:5173");
  assert.equal(headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
  assert.equal(headers["Access-Control-Allow-Headers"], "content-type, apikey, authorization");
  assert.equal(headers.Vary, "Origin");
});

test("CORS: the stable staging origin is allowed; an OAuth Preview only when listed exactly", () => {
  assert.equal(sessionCorsHeaders(site, staging, site)["Access-Control-Allow-Origin"], site);
  const h31b = "https://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app";
  assert.equal(sessionCorsHeaders(h31b, staging, site)["Access-Control-Allow-Origin"], site, "Calendar OAuth remains exact-list only");
  assert.equal(sessionCorsHeaders("https://bellis-abc123def-team.vercel.app", withPreview, site)["Access-Control-Allow-Origin"], "https://bellis-abc123def-team.vercel.app");
  assert.equal(sessionCorsHeaders("https://bellis-zzz999zzz-team.vercel.app", withPreview, site)["Access-Control-Allow-Origin"], site, "another team is refused");
});

test("CORS: an unknown origin is refused (the site's own origin is answered, never the caller's)", () => {
  for (const origin of ["https://evil.example", "http://bellis-git-staging-team.vercel.app", "https://bellis-git-staging-team.vercel.app.evil.example", "https://another-project-bellis1.vercel.app", "null", "", null, "http://localhost:5173.evil.example"]) {
    assert.equal(sessionCorsHeaders(origin, staging, site)["Access-Control-Allow-Origin"], site, String(origin));
  }
});

test("CORS: never a wildcard, whatever the caller or the configuration", () => {
  for (const origin of ["*", "https://evil.example", "http://localhost:5173", site, null]) {
    for (const origins of [staging, configuredOrigins(site, "*"), configuredOrigins(site, "https://*.vercel.app")]) {
      const headers = sessionCorsHeaders(origin, origins, site);
      assert.notEqual(headers["Access-Control-Allow-Origin"], "*"); assert.ok(!Object.values(headers).some((value) => value === "*"));
    }
  }
  assert.doesNotMatch(source, /Allow-Origin"?\s*:\s*"\*"/);
});

test("the function answers every request, error or success, with the same CORS headers; the preflight does nothing else", () => {
  // The preflight is answered first, before the session, the settings or OAuth.
  const handler = source.slice(source.indexOf("Deno.serve("));
  assert.match(handler, /^Deno\.serve\(async \(request\) => \{\s*if \(request\.method === "OPTIONS"\) return new Response\(null, \{ status: 204, headers: cors\(request\) \}\);/);
  // Every other answer goes through json(), which always adds them.
  assert.match(source, /function json\(request: Request, data: unknown, status = 200\) \{\s*return new Response\(JSON\.stringify\(data\), \{ status, headers: \{ \.\.\.cors\(request\), "Content-Type": "application\/json" \} \}\);/);
  assert.equal((source.match(/new Response\(/g) ?? []).length, 2, "only the preflight and json() build responses");
  for (const status of [401, 403, 404, 413, 429, 500, 503]) assert.ok(source.includes(`, ${status})`), `the ${status} answer goes through json()`);
  // An origin that is not allowed is refused before anything else happens.
  assert.match(handler, /if \(origin && !isAllowedOrigin\(origin, allowedOrigins\)\) return json\(request, \{ error: "Origen no permitido" \}, 403\);/);
});

test("the CORS answer is the one Mercado Pago's connection already uses", () => {
  const mpCors = mercadoPago.slice(mercadoPago.indexOf("function cors("), mercadoPago.indexOf("function json("));
  for (const line of ['"Access-Control-Allow-Origin": isAllowedOrigin(origin, allowedOrigins) ? origin : siteOrigin', '"Access-Control-Allow-Methods": "POST, OPTIONS"', '"Access-Control-Allow-Headers": "content-type, apikey, authorization"', '"Vary": "Origin"'])
    assert.ok(mpCors.includes(line), line);
  const shared = readFileSync(new URL("../functions/_shared/origin-policy.ts", import.meta.url), "utf8");
  for (const line of ['"Access-Control-Allow-Origin": isAllowedOrigin(caller, origins) ? caller : primary', '"Access-Control-Allow-Methods": "POST, OPTIONS"', '"Access-Control-Allow-Headers": "content-type, apikey, authorization"', '"Vary": "Origin"'])
    assert.ok(shared.includes(line), line);
});

test("no secret reaches a log line or a CORS header", () => {
  assert.doesNotMatch(source, /console\.(log|info|warn|error)\(/);
  assert.doesNotMatch(source, /log\([^)]*(GOOGLE_CLIENT_SECRET|clientSecret|access_token|refresh_token|code_verifier|authorization)/i);
  const headers = sessionCorsHeaders("http://localhost:5173", staging, site);
  assert.doesNotMatch(JSON.stringify(headers), /secret|token|Bearer/i);
});
