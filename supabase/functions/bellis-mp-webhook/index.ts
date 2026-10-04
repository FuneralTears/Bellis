import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { recordVerifiedPayment, withSellerAccount } from "../_shared/bellis-payment.ts";
import { verifyMercadoPagoSignature } from "../_shared/mercado-pago.ts";
import { getValidMercadoPagoAccessToken, oauthConfigFromEnv, supabaseConnectionStore, type ValidAccount } from "../_shared/mercado-pago-oauth.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } });
// Reading the payment back from Mercado Pago needs the seller's token, renewed here when it is about to expire.
const connections = supabaseConnectionStore(db);
const oauth = oauthConfigFromEnv((name) => Deno.env.get(name), Deno.env.get("BELLIS_SITE_ORIGIN") ?? "");

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (Number(request.headers.get("content-length") ?? "0") > 10000) return new Response(null, { status: 413 });
  const paymentId = await verifyMercadoPagoSignature(request, Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") ?? "");
  if (!paymentId) return new Response(null, { status: 401 });
  const intentId = new URL(request.url).searchParams.get("intent") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(intentId)) return new Response(null, { status: 400 });
  let event: { id?: number | string; type?: string; data?: { id?: number | string } };
  try { event = await request.json(); } catch { return new Response(null, { status: 400 }); }
  if (event.type !== "payment" || String(event.data?.id ?? "") !== paymentId) return new Response(null, { status: 400 });
  try {
    const { data: intent, error } = await db.from("booking_intents")
      .select("id,workspace_id,price_minor,currency_code").eq("id", intentId).maybeSingle();
    if (error) throw error;
    if (!intent) return new Response(null, { status: 200 });
    // No usable account right now (disconnected, renewal failing): answer 503 so Mercado Pago sends the notification again.
    let account: ValidAccount;
    try { account = await getValidMercadoPagoAccessToken(connections, oauth, intent.workspace_id); }
    catch { return new Response(null, { status: 503 }); }
    const payment = await withSellerAccount(connections, intent.workspace_id, account, (provider) => provider.getPayment(paymentId));
    await recordVerifiedPayment(db, intent, account, payment, `webhook:${String(event.id ?? paymentId)}`);
    return new Response(null, { status: 200 });
  } catch {
    // Do not log request bodies, access tokens or patient information.
    return new Response(null, { status: 409 });
  }
});
