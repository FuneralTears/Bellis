export type ProviderStatus = "pending" | "approved" | "rejected" | "cancelled" | "refunded" | "expired";
export type CheckoutSession = { providerOrderId: string; redirectUrl: string };
export interface PaymentProvider {
  readonly id: string;
  createCheckout(order: {
    intentId: string; serviceId: string; title: string; amountMinor: number;
    currency: string; returnUrl: string; notificationUrl: string; environment: "test" | "production";
    expiresAt?: string; returnUrls?: { success: string; pending: string; failure: string };
  }): Promise<CheckoutSession>;
}
export type VerifiedMercadoPagoPayment = {
  id: string;
  preferenceId: string;
  intentId: string;
  sellerUserId: string;
  amountMinor: number;
  currency: string;
  status: ProviderStatus;
};
type PreferenceResponse = { id?: unknown; init_point?: unknown; sandbox_init_point?: unknown };
// A payment names its seller in `collector_id` and its merchant order in `order`. It does not carry the preference.
type PaymentResponse = {
  id?: unknown; external_reference?: unknown; collector_id?: unknown; order?: { id?: unknown; type?: unknown };
  transaction_amount?: unknown; currency_id?: unknown; status?: unknown;
};
type MerchantOrderResponse = { id?: unknown; preference_id?: unknown; external_reference?: unknown; collector?: { id?: unknown } };
const numericId = (value: unknown) =>
  (typeof value === "number" || typeof value === "string") && /^\d{1,24}$/.test(String(value)) ? String(value) : "";

function paymentStatus(value: string): ProviderStatus {
  if (value === "approved") return "approved";
  if (["pending", "in_process", "authorized"].includes(value)) return "pending";
  if (value === "rejected") return "rejected";
  if (value === "cancelled") return "cancelled";
  if (["refunded", "charged_back"].includes(value)) return "refunded";
  if (value === "expired") return "expired";
  throw new Error("unsupported_payment_status");
}

function moneyMinor(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_payment_amount");
  const minor = Math.round(value * 100);
  if (Math.abs(value * 100 - minor) > 0.000001) throw new Error("invalid_payment_amount");
  return minor;
}

export class MercadoPagoArgentinaProvider implements PaymentProvider {
  readonly id = "mercado_pago_ar";
  private readonly accessToken: string;
  constructor(accessToken: string) {
    if (!accessToken) throw new Error("mercado_pago_not_configured");
    this.accessToken = accessToken;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.mercadopago.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`mercado_pago_http_${response.status}`);
    return response.json() as Promise<T>;
  }

  async createCheckout(order: {
    intentId: string; serviceId: string; title: string; amountMinor: number;
    currency: string; returnUrl: string; notificationUrl: string; environment: "test" | "production";
    expiresAt?: string; returnUrls?: { success: string; pending: string; failure: string };
  }): Promise<{ providerOrderId: string; redirectUrl: string }> {
    if (order.currency.trim() !== "ARS" || order.amountMinor <= 0 || !Number.isInteger(order.amountMinor))
      throw new Error("invalid_mercado_pago_amount");
    const result = await this.api<PreferenceResponse>("/checkout/preferences", {
      method: "POST",
      body: JSON.stringify({
        items: [{ id: order.serviceId, title: order.title, quantity: 1, currency_id: "ARS",
          unit_price: order.amountMinor / 100 }],
        external_reference: order.intentId,
        notification_url: order.notificationUrl,
        back_urls: order.returnUrls ?? { success: order.returnUrl, pending: order.returnUrl, failure: order.returnUrl },
        auto_return: "approved",
        // The checkout stops accepting payments when the request it belongs to expires.
        ...(order.expiresAt && Number.isFinite(Date.parse(order.expiresAt))
          ? { expires: true, expiration_date_to: new Date(order.expiresAt).toISOString().replace("Z", "+00:00") } : {}),
      }),
    });
    const redirectUrl = order.environment === "test" ? result.sandbox_init_point : result.init_point;
    if (typeof result.id !== "string" || typeof redirectUrl !== "string")
      throw new Error("invalid_mercado_pago_preference");
    const checkoutUrl = new URL(redirectUrl);
    if (checkoutUrl.protocol !== "https:" ||
      !["www.mercadopago.com", "sandbox.mercadopago.com", "www.mercadopago.com.ar",
        "sandbox.mercadopago.com.ar"].includes(checkoutUrl.hostname))
      throw new Error("invalid_mercado_pago_checkout_url");
    return { providerOrderId: result.id, redirectUrl };
  }

  async getPayment(paymentId: string): Promise<VerifiedMercadoPagoPayment> {
    if (!/^\d{1,24}$/.test(paymentId)) throw new Error("invalid_payment_id");
    const payment = await this.api<PaymentResponse>(`/v1/payments/${paymentId}`);
    const sellerUserId = numericId(payment.collector_id);
    const orderId = numericId(payment.order?.id);
    if (String(payment.id) !== paymentId || typeof payment.external_reference !== "string" || !sellerUserId ||
      typeof payment.currency_id !== "string" || typeof payment.status !== "string" ||
      !orderId || (payment.order?.type !== undefined && payment.order.type !== "mercadopago"))
      throw new Error("invalid_mercado_pago_payment");
    // The preference is read from the payment's merchant order. An order that cannot be read, has no preference,
    // or belongs to another seller or another request leaves the payment unverified: it is never recorded.
    const order = await this.api<MerchantOrderResponse>(`/merchant_orders/${orderId}`);
    if (numericId(order.id) !== orderId || typeof order.preference_id !== "string" || !order.preference_id ||
      (order.collector?.id !== undefined && numericId(order.collector.id) !== sellerUserId) ||
      (order.external_reference !== undefined && order.external_reference !== payment.external_reference))
      throw new Error("invalid_mercado_pago_payment");
    return {
      id: paymentId,
      preferenceId: order.preference_id,
      intentId: payment.external_reference,
      sellerUserId,
      amountMinor: moneyMinor(payment.transaction_amount),
      currency: payment.currency_id,
      status: paymentStatus(payment.status),
    };
  }

  async findPayments(intentId: string): Promise<VerifiedMercadoPagoPayment[]> {
    const result = await this.api<{ results?: Array<{ id?: number | string }> }>(
      `/v1/payments/search?external_reference=${encodeURIComponent(intentId)}&limit=10`);
    const ids = (Array.isArray(result.results) ? result.results : []).map((item) => String(item.id ?? ""))
      .filter((id: string) => /^\d{1,24}$/.test(id));
    return Promise.all(ids.map((id: string) => this.getPayment(id)));
  }
}

export class ExternalPaymentLinkProvider implements PaymentProvider {
  readonly id = "external_link";
  private readonly paymentUrl: string;
  constructor(paymentUrl: string) { this.paymentUrl = paymentUrl; }
  async createCheckout(order: { intentId: string }): Promise<CheckoutSession> {
    const url = new URL(this.paymentUrl);
    if (url.protocol !== "https:") throw new Error("invalid_external_payment_url");
    return { providerOrderId: order.intentId, redirectUrl: url.toString() };
  }
}

export async function verifyMercadoPagoSignature(request: Request, secret: string): Promise<string | null> {
  const url = new URL(request.url);
  const paymentId = url.searchParams.get("data.id") ?? "";
  const requestId = request.headers.get("x-request-id") ?? "";
  const parts: Record<string, string> = Object.fromEntries((request.headers.get("x-signature") ?? "").split(",")
    .map((part) => part.trim().split("=", 2)));
  const timestamp = parts.ts ?? "";
  const signature = parts.v1 ?? "";
  if (!secret || !/^\d{1,24}$/.test(paymentId) || !requestId || !/^\d{10,13}$/.test(timestamp) ||
    !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const seconds = Number(timestamp.slice(0, 10));
  if (Math.abs(Date.now() / 1000 - seconds) > 600) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = new Uint8Array(signature.match(/.{2}/g)!.map((pair) => parseInt(pair, 16)));
  const manifest = new TextEncoder().encode(`id:${paymentId};request-id:${requestId};ts:${timestamp};`);
  return await crypto.subtle.verify("HMAC", key, bytes, manifest) ? paymentId : null;
}
