import assert from "node:assert/strict";
import test from "node:test";
import { checkoutReturnOrigin, configuredOrigins, isAllowedOrigin } from "../functions/_shared/origin-policy.ts";

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
