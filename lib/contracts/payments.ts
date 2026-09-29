/** Shared server-side contract. Provider credentials and webhook secrets never reach the browser. */
export type {
  PaymentProvider,
  CheckoutSession,
  ProviderStatus as PaymentStatus,
  VerifiedMercadoPagoPayment as VerifiedPayment,
} from "../../supabase/functions/_shared/mercado-pago";
export {
  MercadoPagoArgentinaProvider,
  ExternalPaymentLinkProvider as ExternalLinkProvider,
} from "../../supabase/functions/_shared/mercado-pago";

export type Money = { amountMinor: number; currency: string };
