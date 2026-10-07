import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { completeOAuth, oauthConfigFromEnv, sha256Hex, startOAuth, supabaseConnectionStore } from "../_shared/mercado-pago-oauth.ts";
import { configuredOrigins, isAllowedOrigin } from "../_shared/origin-policy.ts";
import { logEvent, paymentErrorCode, type LogFields } from "../_shared/payment-errors.ts";

// Both actions need a signed-in person. Deployed with verify_jwt=false only because the browser's CORS
// preflight carries no session; the session is verified here, against Supabase Auth, on every call.
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } });
const store = supabaseConnectionStore(db);
const siteOrigin = Deno.env.get("BELLIS_SITE_ORIGIN") ?? "";
const allowedOrigins = configuredOrigins(siteOrigin, Deno.env.get("BELLIS_ADDITIONAL_ORIGINS") ?? "");
const config = oauthConfigFromEnv((name) => Deno.env.get(name), siteOrigin);
const configured = !!(siteOrigin && config.clientId && config.clientSecret);
/** Ids and codes only: never the request, a token, the state or the authorization code. */
const log = (level: "info" | "warn" | "error", event: string, fields: LogFields = {}) => logEvent("bellis-mp-oauth", level, event, fields);
if (!configured) log("error", "config_missing", { error_code: "mp_config_missing" });

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
  const { data, error } = await db.rpc("consume_public_request_limit", {
    p_fingerprint: await sha256Hex(key), p_max: max, p_window_minutes: 10,
  });
  return !error && data === true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  const action = new URL(request.url).searchParams.get("action") ?? "";
  try {
    if (request.method !== "POST" || (action !== "start" && action !== "complete"))
      return json(request, { error: "Acción no disponible" }, 404);
    const origin = request.headers.get("origin");
    if (origin && !isAllowedOrigin(origin, allowedOrigins)) return json(request, { error: "Origen no permitido" }, 403);
    // The session comes first: without one, nothing is said about how this environment is set up.
    const session = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data, error } = session ? await db.auth.getUser(session) : { data: { user: null }, error: null };
    if (error || !data.user) return json(request, { error: "Tu sesión venció. Volvé a iniciar sesión." }, 401);
    if (!configured) return json(request, { error: "Mercado Pago todavía no está disponible." }, 503);
    const userId = data.user.id;

    if (action === "start") {
      if (!await limit(`mp_oauth_start:${userId}`, 10)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      try {
        return json(request, { authorizationUrl: await startOAuth(store, config, userId) });
      } catch (caught) {
        if (caught instanceof Error && caught.message.includes("not_authorized"))
          return json(request, { error: "Solo quien administra el espacio puede conectar Mercado Pago." }, 403);
        throw caught;
      }
    }

    if (!await limit(`mp_oauth_complete:${userId}`, 20)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
    if (Number(request.headers.get("content-length") ?? "0") > 4000) return json(request, { error: "Solicitud inválida" }, 413);
    let body: { code?: unknown; state?: unknown };
    try { body = await request.json(); } catch { return json(request, { error: "Solicitud inválida" }, 400); }
    // The person is the verified session. Nothing in the body says who they are or which workspace this is for.
    let reason = "";
    const outcome = await completeOAuth(store, config, { userId, code: body?.code, state: body?.state },
      { report: (value) => { reason = value; } });
    if (outcome === "connected") log("info", "oauth_connected", { action, provider: "mercado_pago_ar", status: outcome });
    else log("warn", "oauth_not_connected", { action, provider: "mercado_pago_ar", status: outcome,
      error_code: outcome === "invalid_state" ? "mp_oauth_invalid_state" : paymentErrorCode({ message: reason }, "mp_oauth_exchange_failed") });
    return json(request, { outcome });
  } catch (caught) {
    log("error", "request_failed", { action: action || "none", error_code: paymentErrorCode(caught) });
    return json(request, { error: "No pudimos completar la solicitud. Intentá nuevamente." }, 500);
  }
});
