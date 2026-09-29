import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { MercadoPagoArgentinaProvider, type VerifiedMercadoPagoPayment } from "./mercado-pago.ts";

export type MercadoPagoAccount = { seller_user_id: string; access_token: string; environment: "test" | "production" };
export async function mercadoPagoAccount(db: SupabaseClient, workspaceId: string): Promise<MercadoPagoAccount | null> {
  const { data, error } = await db.rpc("mercado_pago_account", { p_workspace: workspaceId });
  if (error) throw error;
  return (data?.[0] as MercadoPagoAccount | undefined) ?? null;
}

export async function recordVerifiedPayment(
  db: SupabaseClient,
  intent: { id: string; workspace_id: string; price_minor: number; currency_code: string },
  account: MercadoPagoAccount,
  providerPayment: VerifiedMercadoPagoPayment,
  eventId: string,
) {
  const { data: stored, error } = await db.from("payments")
    .select("id,workspace_id,provider,provider_order_id,amount_minor,currency_code")
    .eq("booking_intent_id", intent.id).maybeSingle();
  if (error) throw error;
  if (!stored || stored.workspace_id !== intent.workspace_id || stored.provider !== "mercado_pago_ar" ||
    !stored.provider_order_id || stored.provider_order_id !== providerPayment.preferenceId ||
    stored.amount_minor !== intent.price_minor || stored.currency_code !== intent.currency_code ||
    providerPayment.intentId !== intent.id || providerPayment.sellerUserId !== account.seller_user_id ||
    providerPayment.amountMinor !== intent.price_minor || providerPayment.currency !== intent.currency_code.trim())
    throw new Error("payment_verification_mismatch");
  const { error: recordError } = await db.rpc("record_mercado_pago_payment", {
    p_intent: intent.id,
    p_preference: providerPayment.preferenceId,
    p_payment_id: providerPayment.id,
    p_event_id: eventId,
    p_status: providerPayment.status,
    p_amount_minor: providerPayment.amountMinor,
    p_currency: providerPayment.currency,
  });
  if (recordError) throw recordError;
}

export function mercadoPagoProvider(account: MercadoPagoAccount) {
  return new MercadoPagoArgentinaProvider(account.access_token);
}
