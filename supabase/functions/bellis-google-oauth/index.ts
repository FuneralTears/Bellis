import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import * as jose from "npm:jose@6.2.12";
import { completeGoogleOAuth, disconnectGoogle, googleIdTokenVerifier, googleOAuthConfigFromEnv, missingGoogleConfig, sha256Hex, startGoogleOAuth, supabaseGoogleConnectionStore } from "../_shared/google-calendar-oauth.ts";
import { configuredOrigins, isAllowedOrigin } from "../_shared/origin-policy.ts";
import { logEvent, type LogFields } from "../_shared/payment-errors.ts";

// Every action needs a signed-in person. Deployed with verify_jwt=false only because the browser's CORS preflight
// carries no session; the session is verified here, against Supabase Auth, on every call.
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } });
const store = supabaseGoogleConnectionStore(db);
const siteOrigin = Deno.env.get("BELLIS_SITE_ORIGIN") ?? "";
const allowedOrigins = configuredOrigins(siteOrigin, Deno.env.get("BELLIS_ADDITIONAL_ORIGINS") ?? "");
const config = googleOAuthConfigFromEnv((name) => Deno.env.get(name), siteOrigin);
// Names of what is missing, never values. Connecting needs all of it; disconnecting does not.
const missing = missingGoogleConfig(config);
const configured = !!siteOrigin && missing.length === 0;
// One verifier per instance, so Google's signing keys stay cached across requests (and are fetched again on rotation).
const verifyIdToken = googleIdTokenVerifier(jose, { clientId: config.clientId, jwksUrl: config.endpoints.jwks });
/** Ids and codes only: never the request, a token, the state, the verifier or the authorization code. */
// The same checked log line as the payment functions; Google's codes are short ids of their own (google_*).
type Fields = Omit<LogFields, "error_code"> & { error_code?: string };
const log = (level: "info" | "warn" | "error", event: string, fields: Fields = {}) => logEvent("bellis-google-oauth", level, event, fields as LogFields);
const errorCode = (caught: unknown) => { const message = String((caught as { message?: unknown } | null)?.message ?? ""); return /^[a-z0-9_]{1,48}$/.test(message) ? message : "internal_error"; };
if (!configured) for (const name of siteOrigin ? missing : ["BELLIS_SITE_ORIGIN", ...missing]) log("error", "config_missing", { error_code: "google_config_missing", status: name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48) });

function cors(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin, allowedOrigins) ? origin : siteOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}
function json(request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(request), "Content-Type": "application/json" } });
}
async function limit(key: string, max: number) {
  const { data, error } = await db.rpc("consume_public_request_limit", { p_fingerprint: await sha256Hex(key), p_max: max, p_window_minutes: 10 });
  return !error && data === true;
}
const has = (caught: unknown, code: string) => caught instanceof Error && caught.message.includes(code);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  const action = new URL(request.url).searchParams.get("action") ?? "";
  try {
    if (request.method !== "POST" || !["start", "complete", "disconnect"].includes(action))
      return json(request, { error: "Acción no disponible" }, 404);
    const origin = request.headers.get("origin");
    if (origin && !isAllowedOrigin(origin, allowedOrigins)) return json(request, { error: "Origen no permitido" }, 403);
    // The session comes first: without one, nothing is said about how this environment is set up.
    const session = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data, error } = session ? await db.auth.getUser(session) : { data: { user: null }, error: null };
    if (error || !data.user) return json(request, { error: "Tu sesión venció. Volvé a iniciar sesión." }, 401);
    const userId = data.user.id;

    if (action === "disconnect") {
      if (!await limit(`google_oauth_disconnect:${userId}`, 10)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      try {
        let reason = "";
        const { revoked } = await disconnectGoogle(store, config, userId, { report: (value) => { reason = value; } });
        log(revoked ? "info" : "warn", "google_disconnected", { action, provider: "google_calendar", status: revoked ? "revoked" : "revoke_failed", error_code: reason || undefined });
        return json(request, { outcome: "disconnected" });
      } catch (caught) {
        if (has(caught, "not_authorized")) return json(request, { error: "No encontramos tu perfil profesional." }, 403);
        throw caught;
      }
    }

    if (!configured) return json(request, { error: "Google Calendar todavía no está disponible." }, 503);

    if (action === "start") {
      if (!await limit(`google_oauth_start:${userId}`, 10)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      try {
        return json(request, { authorizationUrl: await startGoogleOAuth(store, config, userId) });
      } catch (caught) {
        if (has(caught, "not_authorized")) return json(request, { error: "Necesitás un perfil profesional para conectar Google Calendar." }, 403);
        // The database decides what the plan and the rollout include; here it is only told apart from a failure.
        if (has(caught, "pro_access_required")) return json(request, { error: "Google Calendar es parte de Bellis Pro.", code: "plan_required" }, 403);
        if (has(caught, "feature_not_enabled")) return json(request, { error: "Google Calendar todavía no está disponible.", code: "not_enabled" }, 403);
        throw caught;
      }
    }

    if (!await limit(`google_oauth_complete:${userId}`, 20)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
    if (Number(request.headers.get("content-length") ?? "0") > 4000) return json(request, { error: "Solicitud inválida" }, 413);
    let body: { code?: unknown; state?: unknown };
    try { body = await request.json(); } catch { return json(request, { error: "Solicitud inválida" }, 400); }
    // The person is the verified session. Nothing in the body says who they are or which professional this is for.
    let reason = "";
    const outcome = await completeGoogleOAuth(store, config, { userId, code: body?.code, state: body?.state }, { verifyIdToken, report: (value) => { reason = value; } });
    if (outcome === "connected") log("info", "oauth_connected", { action, provider: "google_calendar", status: outcome });
    else log("warn", "oauth_not_connected", { action, provider: "google_calendar", status: outcome,
      error_code: outcome === "invalid_state" ? "google_oauth_invalid_state" : reason || "google_oauth_exchange_failed" });
    return json(request, { outcome });
  } catch (caught) {
    log("error", "request_failed", { action: action || "none", error_code: errorCode(caught) });
    return json(request, { error: "No pudimos completar la solicitud. Intentá nuevamente." }, 500);
  }
});
