#!/usr/bin/env node
/**
 * Safe checks for the payment functions of one environment. Nothing here needs a secret or a session, and nothing
 * is written: every request is one a stranger could send. Meant for after a deploy, and before any real test.
 *
 *   BELLIS_SUPABASE_URL=https://<ref>.supabase.co BELLIS_SITE_URL=https://<site> node scripts/payments-health.mjs
 *
 * BELLIS_SITE_URL is optional. With it, the script also checks that the site talks to that same Supabase project,
 * which is what catches a staging site pointed at production (or the other way round).
 */
const supabaseUrl = (process.env.BELLIS_SUPABASE_URL ?? "").replace(/\/+$/, "");
const siteUrl = (process.env.BELLIS_SITE_URL ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl)) {
  console.error("Set BELLIS_SUPABASE_URL to https://<project-ref>.supabase.co");
  process.exit(2);
}
const fn = (name, query = "") => `${supabaseUrl}/functions/v1/${name}${query}`;
const results = [];
async function check(name, run) {
  try {
    const outcome = await run();
    results.push({ name, ok: outcome === true, detail: outcome === true ? "" : String(outcome) });
  } catch (caught) { results.push({ name, ok: false, detail: `request failed: ${caught instanceof Error ? caught.message : "unknown"}` }); }
}
const send = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
const body = async (response) => { try { return await response.json(); } catch { return {}; } };

await check("bellis-public answers and reaches the database (unknown profile → 404)", async () => {
  const response = await send(fn("bellis-public", "?action=profile&slug=health-check-no-such-profile"));
  return response.status === 404 || `expected 404, got ${response.status}`;
});
await check("bellis-public refuses an unknown action (404)", async () => {
  const response = await send(fn("bellis-public", "?action=health-check"));
  return response.status === 404 || `expected 404, got ${response.status}`;
});
await check("bellis-public refuses a foreign origin (403)", async () => {
  const response = await send(fn("bellis-public", "?action=profile&slug=health-check-no-such-profile"), { headers: { origin: "https://not-bellis.example" } });
  return response.status === 403 || `expected 403, got ${response.status}`;
});
await check("bellis-public does not recover a made-up return token (404, code booking_resume_invalid)", async () => {
  const response = await send(fn("bellis-public", "?action=resume"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume: "0".repeat(64), slug: "health-check-no-such-profile" }) });
  const { code } = await body(response);
  if (response.status !== 404) return `expected 404, got ${response.status}`;
  return code === "booking_resume_invalid" || `answered 404 with code "${code}": an older version of the function is deployed`;
});
await check("bellis-public needs a request token for status (404)", async () => {
  const response = await send(fn("bellis-public", "?action=status"));
  return response.status === 404 || `expected 404, got ${response.status}`;
});
await check("bellis-mp-oauth without a session → 401", async () => {
  const response = await send(fn("bellis-mp-oauth", "?action=start"), { method: "POST" });
  if (response.status === 503) return "503 before checking the session: an older version of the function is deployed, and it is not configured";
  return response.status === 401 || `expected 401, got ${response.status}`;
});
await check("bellis-mp-oauth with a made-up session → 401", async () => {
  const response = await send(fn("bellis-mp-oauth", "?action=complete"), { method: "POST", headers: { authorization: "Bearer not-a-session", "content-type": "application/json" }, body: "{}" });
  if (response.status === 503) return "503 before checking the session: an older version of the function is deployed, and it is not configured";
  return response.status === 401 || `expected 401, got ${response.status}`;
});
await check("bellis-mp-webhook without a signature → 401", async () => {
  const response = await send(fn("bellis-mp-webhook", "?data.id=1&type=payment"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "payment", data: { id: "1" } }) });
  if (response.status === 503) return "503: MERCADO_PAGO_WEBHOOK_SECRET is not set";
  return response.status === 401 || `expected 401, got ${response.status}`;
});
await check("bellis-mp-webhook with a forged signature → 401", async () => {
  const response = await send(fn("bellis-mp-webhook", "?data.id=1&type=payment"), { method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "health-check", "x-signature": `ts=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: JSON.stringify({ type: "payment", data: { id: "1" } }) });
  if (response.status === 503) return "503: MERCADO_PAGO_WEBHOOK_SECRET is not set";
  return response.status === 401 || `expected 401, got ${response.status}`;
});
await check("bellis-mp-webhook only takes POST (405)", async () => {
  const response = await send(fn("bellis-mp-webhook"));
  return response.status === 405 || `expected 405, got ${response.status}`;
});
if (siteUrl) {
  await check("site loads", async () => {
    const response = await send(`${siteUrl}/`);
    return response.ok || `expected 200, got ${response.status}`;
  });
  await check("Mercado Pago callback page loads", async () => {
    const response = await send(`${siteUrl}/mercado-pago/callback`);
    return response.ok || `expected 200, got ${response.status}`;
  });
  await check("site talks to this same Supabase project (no crossed environments)", async () => {
    const response = await send(`${siteUrl}/api/supabase-config`);
    if (!response.ok) return `expected 200, got ${response.status}`;
    // Only the project address is compared. The key is never printed.
    const { url } = await body(response);
    return String(url ?? "").replace(/\/+$/, "") === supabaseUrl || "the site is configured with a different Supabase project";
  });
  await check("bellis-public accepts the site's origin", async () => {
    const response = await send(fn("bellis-public", "?action=profile&slug=health-check-no-such-profile"), { headers: { origin: siteUrl } });
    if (response.status === 403) return "403: BELLIS_SITE_ORIGIN of the functions is not this site";
    return response.status === 404 || `expected 404, got ${response.status}`;
  });
}
for (const item of results) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
const failed = results.filter((item) => !item.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed for ${new URL(supabaseUrl).hostname}${siteUrl ? ` and ${new URL(siteUrl).hostname}` : ""}`);
process.exit(failed ? 1 : 0);
