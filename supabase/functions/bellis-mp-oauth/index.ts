import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { completeOAuth, oauthConfigFromEnv, sha256Hex, startOAuth, supabaseConnectionStore } from "../_shared/mercado-pago-oauth.ts";
import { configuredOrigins, isAllowedOrigin } from "../_shared/origin-policy.ts";

// Both actions need a signed-in person. Deployed with verify_jwt=false only because the browser's CORS
// preflight carries no session; the session is verified here, against Supabase Auth, on every call.
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } });
const store = supabaseConnectionStore(db);
const siteOrigin = Deno.env.get("BELLIS_SITE_ORIGIN") ?? "";
const allowedOrigins = configuredOrigins(siteOrigin, Deno.env.get("BELLIS_ADDITIONAL_ORIGINS") ?? "");
const config = oauthConfigFromEnv((name) => Deno.env.get(name), siteOrigin);
const configured = !!(siteOrigin && config.clientId && config.clientSecret);

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
    if (!configured) return json(request, { error: "Mercado Pago todavía no está disponible." }, 503);
    const session = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data, error } = session ? await db.auth.getUser(session) : { data: { user: null }, error: null };
    if (error || !data.user) return json(request, { error: "Tu sesión venció. Volvé a iniciar sesión." }, 401);
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
    const outcome = await completeOAuth(store, config, { userId, code: body?.code, state: body?.state });
    if (outcome !== "connected") console.warn(`bellis-mp-oauth complete: ${outcome}`);
    return json(request, { outcome });
  } catch (caught) {
    // Short code only: never the request, a token or the authorization code.
    console.error(`bellis-mp-oauth failed: ${caught instanceof Error ? caught.message.slice(0, 60) : "unknown"}`);
    return json(request, { error: "No pudimos completar la solicitud. Intentá nuevamente." }, 500);
  }
});
