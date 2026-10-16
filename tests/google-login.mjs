/**
 * H3.1A.1 sign-in with Google: identity only. The flow's rules are tested directly; the pages are checked by what
 * they contain (they are client components). Nothing here reaches Google or Supabase.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { finishGoogleSignIn, googleCallbackPath, googleCallbackUrl, googleSignInMessage, googleSignInOptions, parseGoogleCallback } from "../lib/auth/google-flow.ts";
import { landingRouteForUser } from "../lib/auth/navigation.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const login = read("app/ingresar/page.tsx"), register = read("app/registro/page.tsx"), callback = read("app/auth/callback/page.tsx");
const googleClient = read("lib/auth/google.ts"), flow = read("lib/auth/google-flow.ts"), button = read("components/auth/GoogleSignIn.tsx") + read("components/auth/GoogleSignInButton.tsx"), complete = read("app/registro/completar/page.tsx");
const calendarScopes = /calendar\.app\.created|calendar\.freebusy|auth\/calendar|calendar\.events|calendar\.readonly/;

test("demo: the auth showroom shows the same Google button and the account completion, with no Supabase", () => {
  const demo = read("app/demo/auth/auth-demo.tsx"), view = read("components/auth/GoogleSignInButton.tsx");
  assert.ok(demo.includes('import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";'));
  assert.ok(demo.includes('{ key: "completar", label: "Completar (Google)" }'));
  assert.doesNotMatch(demo + view, /getSupabase|supabase|signInWithOAuth|lib\/auth\/google/);
});

test("1-2: login and register offer 'Continuar con Google' above the email form; register says Calendar is not touched", () => {
  assert.ok(login.indexOf("<GoogleSignIn />") > 0 && login.indexOf("<GoogleSignIn />") < login.indexOf("<form"), "login: above the form");
  assert.ok(register.includes('<GoogleSignIn note="Usamos Google solo para iniciar sesión. No accedemos a tu calendario." />'));
  assert.ok(register.indexOf("<GoogleSignIn") < register.indexOf("<form"));
  assert.match(button, />\{busy \? "Abriendo Google…" : "Continuar con Google"\}/);
  assert.match(button, /<p className="auth-divider"><span>o<\/span><\/p>/);
  assert.doesNotMatch(button + login + register, /Conectar Google/);
  // Only offered where the environment has Google enabled: never a button that cannot work.
  assert.match(button, /if \(!available\) return null;/);
  assert.match(googleClient, /external\?\.google === true/);
  // Not on password recovery.
  assert.doesNotMatch(read("app/recuperar/page.tsx"), /GoogleSignIn|signInWithOAuth/);
});

test("3, 14, 17: the sign-in starts with PKCE on its own client, to the fixed callback, and asks for no Calendar scope", () => {
  const options = googleSignInOptions("http://localhost:5173");
  assert.deepEqual(options, { provider: "google", options: { redirectTo: "http://localhost:5173/auth/callback", queryParams: { prompt: "select_account" } } });
  assert.equal("scopes" in options.options, false, "Supabase's own openid email profile, nothing more");
  assert.equal(googleCallbackUrl("http://localhost:5173"), "http://localhost:5173/auth/callback");
  assert.equal(googleCallbackPath, "/auth/callback");
  assert.match(googleClient, /flowType: "pkce"/);
  assert.match(googleClient, /storage: tabStorage, storageKey/);
  for (const source of [googleClient, flow, button, callback, complete, login, register]) {
    assert.doesNotMatch(source, calendarScopes); assert.doesNotMatch(source, /scopes\s*:/); assert.doesNotMatch(source, /bellis-google-oauth|google_calendar/);
  }
  // Bellis's own client keeps its flow: email confirmation and password recovery links are untouched.
  assert.doesNotMatch(read("lib/supabase/browser.ts"), /flowType/);
});

test("4-7: the callback query: a code, a cancellation, a provider error, or something invalid", () => {
  assert.deepEqual(parseGoogleCallback(new URLSearchParams("code=abcDEF123-_.~xyz")), { kind: "code", code: "abcDEF123-_.~xyz" });
  assert.deepEqual(parseGoogleCallback(new URLSearchParams("error=access_denied&error_description=User+cancelled")), { kind: "cancelled" });
  assert.deepEqual(parseGoogleCallback(new URLSearchParams("error=server_error&error_description=Unable+to+exchange")), { kind: "error" });
  for (const query of ["", "code=", "code=short", "code=<script>alert(1)</script>", `code=${"a".repeat(600)}`]) assert.deepEqual(parseGoogleCallback(new URLSearchParams(query)), { kind: "invalid" }, query);
});

/** The callback's dependencies, recorded. */
function deps({ exchange, current = null, landing = "/dashboard" } = {}) {
  const log = { adopted: [], discarded: [], landed: [] };
  return { log, deps: {
    exchange: exchange ?? (async () => ({ access_token: "access-token-x", refresh_token: "refresh-token-x", user: { id: "u-1", email_confirmed_at: "2026-10-16T00:00:00Z" } })),
    currentUser: async () => current, adopt: async (session) => { log.adopted.push(session.user.id); },
    discard: async (session) => { log.discarded.push(session.user.id); }, landing: async (id) => { log.landed.push(id); return landing; },
  } };
}

test("4, 9, 10: a verified Google account gets its session on Bellis's client and goes where its account says", async () => {
  for (const landing of ["/registro/completar", "/onboarding", "/dashboard"]) {
    const { log, deps: d } = deps({ landing });
    assert.deepEqual(await finishGoogleSignIn({ kind: "code", code: "abcdefgh" }, d), { route: landing });
    assert.deepEqual(log.adopted, ["u-1"]); assert.deepEqual(log.landed, ["u-1"]); assert.deepEqual(log.discarded, []);
  }
});

test("5-6: cancelled, failed or invalid callbacks end on the login page with a calm message and no session", async () => {
  for (const kind of ["cancelled", "error", "invalid"]) {
    const { log, deps: d } = deps();
    assert.deepEqual(await finishGoogleSignIn({ kind }, d), { problem: kind });
    assert.deepEqual(log.adopted, []);
    assert.ok(googleSignInMessage(kind));
  }
  assert.match(callback, /`\/ingresar\?google=\$\{outcome\.problem\}`/);
  assert.match(login, /googleSignInMessage\(useSyncExternalStore\(subscribeToNothing, googleProblem, \(\) => null\)\)/);
});

test("7: an email Google did not verify never becomes a Bellis session; the session is discarded", async () => {
  const { log, deps: d } = deps({ exchange: async () => ({ access_token: "a", refresh_token: "r", user: { id: "u-2", email_confirmed_at: null } }) });
  assert.deepEqual(await finishGoogleSignIn({ kind: "code", code: "abcdefgh" }, d), { problem: "unverified" });
  assert.deepEqual(log.adopted, []); assert.deepEqual(log.discarded, ["u-2"]); assert.deepEqual(log.landed, []);
  assert.match(googleSignInMessage("unverified").text, /no tiene el email verificado/);
});

test("11: a repeated callback (refresh, second tab) finds the session already there and goes on; without one it is refused", async () => {
  const failing = async () => { throw new Error("code already used"); };
  const again = deps({ exchange: failing, current: { id: "u-1", email_confirmed_at: "2026-10-16T00:00:00Z" }, landing: "/onboarding" });
  assert.deepEqual(await finishGoogleSignIn({ kind: "code", code: "abcdefgh" }, again.deps), { route: "/onboarding" });
  assert.deepEqual(again.log.adopted, [], "nothing new is adopted");
  const none = deps({ exchange: failing });
  assert.deepEqual(await finishGoogleSignIn({ kind: "code", code: "abcdefgh" }, none.deps), { problem: "invalid" });
  const unverified = deps({ exchange: failing, current: { id: "u-2", email_confirmed_at: null } });
  assert.deepEqual(await finishGoogleSignIn({ kind: "code", code: "abcdefgh" }, unverified.deps), { problem: "invalid" });
  // The callback page hands the code over once and takes it out of the address bar at once.
  assert.match(callback, /if \(started\.current\) return;\s*started\.current = true;\s*const query = new URLSearchParams\(window\.location\.search\);\s*window\.history\.replaceState\(null, "", window\.location\.pathname\);/);
});

/** A stand-in for the browser client's query builder: answers each table from `rows`. */
function client(rows) {
  const builder = (table) => { const filters = {}; const api = {
    select: () => api, order: () => api, limit: () => api,
    eq: (column, value) => { filters[column] = value; return api; },
    maybeSingle: async () => ({ data: (rows[table] ?? []).find((row) => Object.entries(filters).every(([k, v]) => row[k] === v)) ?? null, error: null }),
    single: async () => { const data = (rows[table] ?? []).find((row) => Object.entries(filters).every(([k, v]) => row[k] === v)) ?? null; return { data, error: data ? null : { message: "none" } }; },
  }; return api; };
  return { from: builder };
}

test("8-10, 18: where a person lands depends on the account, never on how they signed in", async () => {
  assert.equal(await landingRouteForUser(client({}), "u-new"), "/registro/completar", "no workspace yet: complete the account");
  const member = { workspace_members: [{ user_id: "u", workspace_id: "w" }], professionals: [{ user_id: "u", workspace_id: "w", id: "p" }] };
  assert.equal(await landingRouteForUser(client({ ...member, workspaces: [{ id: "w", onboarding_completed_at: null }] }), "u"), "/onboarding");
  assert.equal(await landingRouteForUser(client({ ...member, workspaces: [{ id: "w", onboarding_completed_at: "2026-10-01" }] }), "u"), "/dashboard");
  // No page asks which provider was used; the guards that expect the dashboard send anything else back through it.
  for (const path of ["app/dashboard/page.tsx", "app/pacientes/crm.ts", "app/mis-formularios/FormsWorkspace.tsx", "lib/auth/navigation.ts", "app/onboarding/page.tsx"]) {
    const source = read(path);
    assert.doesNotMatch(source, /app_metadata\??\.provider|provider === "google"|identities/, path);
  }
  assert.match(read("app/dashboard/page.tsx"), /landingRouteForUser\(client, auth\.user\.id\) !== "\/dashboard"\) throw new Error\("onboarding_required"\)/);
  assert.match(read("app/onboarding/page.tsx"), /if \(destination !== "\/onboarding"\) window\.location\.replace\(destination\);/);
  // The account is created by the server for the session's person; the page sends the form's fields only.
  assert.match(complete, /client\.rpc\("complete_bellis_account", \{ p_document: \{\s*name: form\.name\.trim\(\), business: form\.business\.trim\(\), specialty: form\.specialty, province: form\.province, city: form\.city\.trim\(\), timezone: DEFAULT_MARKET\.timezone \} \}\)/);
});

test("12-13: email and password, sign-up with the form, and sign-out work as before", () => {
  assert.match(login, /client\.auth\.signInWithPassword\(\{ email: email\.trim\(\), password \}\)/);
  assert.match(register, /client\.auth\.signUp\(\{/); assert.match(register, /bellis_signup: "1"/);
  assert.match(read("app/dashboard/page.tsx"), /client\.auth\.signOut\(/);
});

test("15: no token, code or provider message is logged or shown", () => {
  for (const source of [googleClient, flow, button, callback, complete]) assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)\(/);
  for (const code of ["cancelled", "error", "invalid", "unverified", "unavailable", "network"]) assert.doesNotMatch(googleSignInMessage(code).text, /token|code|supabase|oauth|provider|error_description/i);
  assert.equal(googleSignInMessage("access_denied"), null); assert.equal(googleSignInMessage("<script>"), null); assert.equal(googleSignInMessage(null), null);
});

test("16: no open redirect: the callback goes only where the account says; nothing in the URL chooses the destination", () => {
  assert.doesNotMatch(callback + googleClient + flow, /get\("(next|redirect|redirect_to|returnTo)"\)/);
  assert.match(callback, /window\.location\.replace\("route" in outcome \? outcome\.route : `\/ingresar\?google=\$\{outcome\.problem\}`\)/);
  const navigation = read("lib/auth/navigation.ts");
  assert.match(navigation, /Promise<"\/registro\/completar" \| "\/onboarding" \| "\/dashboard">/);
});
