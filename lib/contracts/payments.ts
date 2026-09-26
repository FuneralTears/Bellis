/** Server-side contract. Provider credentials and webhook secrets never reach the browser. */
export type Money = { amountMinor: number; currency: string };
export type PaymentOrder = { id: string; bookingIntentId: string; amount: Money; returnUrl: string };
export type CheckoutSession = { providerOrderId: string; redirectUrl: string };
export type PaymentStatus = "pending" | "approved" | "rejected" | "refunded" | "cancelled" | "expired";
export type VerifiedPayment = { providerEventId: string; providerOrderId: string; status: PaymentStatus; amount: Money };
export interface PaymentProvider {
  readonly id: string;
  createCheckout(order: PaymentOrder): Promise<CheckoutSession>;
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedPayment>;
}

/** Argentina-first adapter boundary. The supplied adapter must verify webhook signatures and query Mercado Pago server-side. */
export class MercadoPagoArgentinaProvider implements PaymentProvider {
  readonly id = "mercado_pago_ar";
  constructor(private readonly adapter: {
    createCheckout(order: PaymentOrder): Promise<CheckoutSession>;
    verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedPayment>;
  }) {}
  createCheckout(order: PaymentOrder): Promise<CheckoutSession> {
    if (order.amount.currency !== "ARS") throw new Error("Mercado Pago Argentina requires ARS in the MVP");
    return this.adapter.createCheckout(order);
  }
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedPayment> {
    return this.adapter.verifyWebhook(rawBody, headers);
  }
}

/** An external URL alone cannot prove payment. Keep intent pending until a trusted callback or manual server-side verification. */
export class ExternalLinkProvider implements PaymentProvider {
  readonly id = "external_link";
  constructor(private readonly paymentUrl: string) {}
  async createCheckout(order: PaymentOrder): Promise<CheckoutSession> {
    const url = new URL(this.paymentUrl);
    if (url.protocol !== "https:") throw new Error("Invalid external payment URL");
    return { providerOrderId: order.id, redirectUrl: url.toString() };
  }
  async verifyWebhook(): Promise<VerifiedPayment> {
    throw new Error("External links have no verifiable webhook; payment must remain pending");
  }
}
