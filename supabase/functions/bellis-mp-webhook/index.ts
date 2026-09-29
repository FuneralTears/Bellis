import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { mercadoPagoAccount, mercadoPagoProvider, recordVerifiedPayment } from "../_shared/bellis-payment.ts";
import { verifyMercadoPagoSignature } from "../_shared/mercado-pago.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } });

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
    const account = await mercadoPagoAccount(db, intent.workspace_id);
    if (!account) return new Response(null, { status: 503 });
    const payment = await mercadoPagoProvider(account).getPayment(paymentId);
    await recordVerifiedPayment(db, intent, account, payment, `webhook:${String(event.id ?? paymentId)}`);
    return new Response(null, { status: 200 });
  } catch {
    // Do not log request bodies, access tokens or patient information.
    return new Response(null, { status: 409 });
  }
});
