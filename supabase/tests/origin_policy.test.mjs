import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkoutReturnOrigin, configuredOrigins, isAllowedOrigin, isBellisVercelOrigin, isGoogleCalendarOAuthOriginAllowed, isPublicOriginAllowed, publicCorsHeaders } from "../functions/_shared/origin-policy.ts";

test("only configured HTTPS origins and local development can call the public function", () => {
  const primary = "https://bellis.vercel.app";
  const origins = configuredOrigins(primary,
    "https://preview-a.vercel.app, https://preview-b.vercel.app/, https://evil.example/path, http://preview-c.vercel.app");
  assert.equal(isAllowedOrigin(primary, origins), true);
  assert.equal(isAllowedOrigin("https://preview-a.vercel.app", origins), true);
  assert.equal(isAllowedOrigin("https://preview-b.vercel.app", origins), false);
  assert.equal(isAllowedOrigin("https://evil.example", origins), false);
  assert.equal(isAllowedOrigin("http://localhost:5173", origins), true);
  assert.equal(isAllowedOrigin("https://unlisted.vercel.app", origins), false);
  assert.equal(checkoutReturnOrigin("https://preview-a.vercel.app", primary, origins), "https://preview-a.vercel.app");
  assert.equal(checkoutReturnOrigin("https://unlisted.vercel.app", primary, origins), primary);
  assert.equal(checkoutReturnOrigin("http://localhost:5173", primary, origins), primary);
});

test("Bellis Vercel Preview recognition is restricted to the Bellis project in the bellis1 team", () => {
  const h31b = "https://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app";
  const deployment = "https://bellis-2obl8m6in-bellis1.vercel.app";
  const origins = configuredOrigins("https://bellis-git-staging-bellis1.vercel.app", "");

  for (const origin of [h31b, deployment]) {
    assert.equal(isBellisVercelOrigin(origin), true, origin);
    assert.equal(isAllowedOrigin(origin, origins), false, "session endpoints still require an exact configured origin");
  }

  for (const origin of [
    "https://another-project-bellis1.vercel.app",
    "https://bellis-git-feat-h3-1b-google-calendar-events-other-team.vercel.app",
    "http://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app",
    "https://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app.evil.example",
    "https://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app/path",
    "https://bellis1.vercel.app",
  ]) {
    assert.equal(isBellisVercelOrigin(origin), false, origin);
    assert.equal(isAllowedOrigin(origin, origins), false, origin);
  }

  const prod = "https://bellis-six.vercel.app";
  const previewHeaders = publicCorsHeaders(h31b, configuredOrigins(prod, ""));
  assert.equal(isPublicOriginAllowed(h31b, origins), true);
  assert.equal(previewHeaders["Access-Control-Allow-Origin"], h31b);
  assert.equal(publicCorsHeaders(prod, configuredOrigins(prod, ""))["Access-Control-Allow-Origin"], prod);

  const invalidHeaders = publicCorsHeaders("https://evil.example", configuredOrigins(prod, ""));
  assert.equal(invalidHeaders["Access-Control-Allow-Origin"], undefined);
  assert.equal(Object.values(invalidHeaders).includes("*"), false);

  const publicFunction = readFileSync(new URL("../functions/bellis-public/index.ts", import.meta.url), "utf8");
  assert.match(publicFunction, /return isPublicOriginAllowed\(origin, allowedOrigins\);/);
  assert.match(publicFunction, /status: origin && publicOriginAllowed\(origin\) \? 204 : 403/);
  assert.doesNotMatch(publicFunction, /"Access-Control-Allow-Origin": publicOriginAllowed\(origin\) \? origin : siteOrigin/);
  assert.match(publicFunction, /if \(origin && !publicOriginAllowed\(origin\)\)/);
});

test("Calendar Preview may only run the read-only connection check", () => {
  const primary = "https://bellis-git-staging-bellis1.vercel.app";
  const preview = "https://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app";
  const deployment = "https://bellis-pgl756w98-bellis1.vercel.app";
  const origins = configuredOrigins(primary, "");

  for (const origin of [preview, deployment]) {
    assert.equal(isGoogleCalendarOAuthOriginAllowed("check", origin, origins), true, origin);
    for (const action of ["start", "complete", "disconnect", "status", ""]) {
      assert.equal(isGoogleCalendarOAuthOriginAllowed(action, origin, origins), false, `${action}:${origin}`);
    }
  }
  for (const action of ["check", "start", "complete", "disconnect"]) {
    assert.equal(isGoogleCalendarOAuthOriginAllowed(action, primary, origins), true, action);
  }
  for (const origin of [
    "https://another-project-bellis1.vercel.app",
    "https://bellis-git-feat-h3-1b-google-calendar-events-other-team.vercel.app",
    "http://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app",
    "https://bellis-git-feat-h3-1b-google-calendar-events-bellis1.vercel.app.evil.example",
  ]) assert.equal(isGoogleCalendarOAuthOriginAllowed("check", origin, origins), false, origin);

  const oauthFunction = readFileSync(new URL("../functions/bellis-google-oauth/index.ts", import.meta.url), "utf8");
  assert.match(oauthFunction, /isGoogleCalendarOAuthOriginAllowed\(requestAction\(request\), origin, allowedOrigins\)/);
  assert.match(oauthFunction, /!isGoogleCalendarOAuthOriginAllowed\(action, origin, allowedOrigins\)/);
});
