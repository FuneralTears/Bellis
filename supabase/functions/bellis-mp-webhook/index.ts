import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { recordVerifiedPayment, withSellerAccount } from "../_shared/bellis-payment.ts";
import { answerNotification } from "../_shared/bellis-webhook.ts";
import { getValidMercadoPagoAccessToken, oauthConfigFromEnv, supabaseConnectionStore } from "../_shared/mercado-pago-oauth.ts";
import { logEvent } from "../_shared/payment-errors.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } });
// Reading the payment back from Mercado Pago needs the seller's token, renewed here when it is about to expire.
const connections = supabaseConnectionStore(db);
const oauth = oauthConfigFromEnv((name) => Deno.env.get(name), Deno.env.get("BELLIS_SITE_ORIGIN") ?? "");

Deno.serve(async (request) => {
  // What to answer is decided in answerNotification. The log gets ids and codes only: never a body, a token or patient data.
  const result = await answerNotification(request, Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") ?? "", {
    findIntent: async (intentId) => {
      const { data, error } = await db.from("booking_intents")
        .select("id,workspace_id,price_minor,currency_code").eq("id", intentId).maybeSingle();
      if (error) throw error;
      return data;
    },
    account: (workspaceId) => getValidMercadoPagoAccessToken(connections, oauth, workspaceId),
    getPayment: (workspaceId, account, paymentId) =>
      withSellerAccount(connections, workspaceId, account, (provider) => provider.getPayment(paymentId)),
    record: (intent, account, payment, eventId) => recordVerifiedPayment(db, intent, account, payment, eventId),
  });
  logEvent("bellis-mp-webhook", result.level, result.event, result.fields);
  return new Response(null, { status: result.status });
});
