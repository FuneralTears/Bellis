import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { MercadoPagoArgentinaProvider, type VerifiedMercadoPagoPayment } from "./mercado-pago.ts";
import { MercadoPagoOAuthError, type ConnectionStore, type ValidAccount } from "./mercado-pago-oauth.ts";

export type MercadoPagoAccount = { seller_user_id: string; access_token: string; environment: "test" | "production" };
/** Whether the workspace has a connected account at all. For a token that is safe to use, see getValidMercadoPagoAccessToken. */
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

/**
 * Runs a call to Mercado Pago with the workspace's seller token. If Mercado Pago no longer accepts that token
 * (the person removed Bellis from their account), the connection is marked as failed so the panel asks to
 * reconnect, instead of every later checkout failing without anyone knowing why.
 */
export async function withSellerAccount<T>(
  store: ConnectionStore, workspaceId: string, account: ValidAccount,
  work: (provider: MercadoPagoArgentinaProvider) => Promise<T>,
): Promise<T> {
  try {
    return await work(new MercadoPagoArgentinaProvider(account.access_token));
  } catch (caught) {
    if (caught instanceof Error && caught.message === "mercado_pago_http_401") {
      await store.failRefresh(workspaceId, true).catch(() => undefined);
      throw new MercadoPagoOAuthError("mercado_pago_token_rejected", true);
    }
    throw caught;
  }
}

/**
 * Creates the checkout for a request that already exists on the server. Everything that matters comes from
 * that stored request (amount, currency, service, workspace) and from the workspace's own connected account;
 * nothing here is taken from the browser.
 * If the checkout cannot be created or recorded, `closeRequest` is called so the request is not left
 * waiting for a payment nobody can make.
 */
export async function createMercadoPagoCheckout(
  store: ConnectionStore, account: ValidAccount,
  order: {
    intentId: string; workspaceId: string; serviceId: string; title: string; amountMinor: number;
    currency: string; expiresAt?: string; returnUrl: string; notificationUrl: string;
    returnUrls?: { success: string; pending: string; failure: string };
  },
  saveCheckout: (preferenceId: string, checkoutUrl: string) => Promise<void>,
  closeRequest: (intentId: string) => Promise<void> = async () => {},
): Promise<string> {
  try {
    const checkout = await withSellerAccount(store, order.workspaceId, account, (provider) => provider.createCheckout({
      intentId: order.intentId, serviceId: order.serviceId, title: order.title, amountMinor: order.amountMinor,
      currency: order.currency, expiresAt: order.expiresAt, returnUrl: order.returnUrl, returnUrls: order.returnUrls,
      notificationUrl: order.notificationUrl, environment: account.environment,
    }));
    await saveCheckout(checkout.providerOrderId, checkout.redirectUrl);
    return checkout.redirectUrl;
  } catch (caught) {
    await closeRequest(order.intentId).catch(() => undefined);
    throw caught;
  }
}
