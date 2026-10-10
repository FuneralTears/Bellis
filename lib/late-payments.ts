/**
 * A late payment: Mercado Pago approved it after its request ran out of time or was closed. The payment is on
 * record as approved and the request stays cancelled, so there is money received and no appointment.
 * That pair of states only comes from `record_mercado_pago_payment` (audit `mercado_pago_late_payment_approved`):
 * a payment approved in time moves its request forward, and a refund moves both to refunded.
 * Nothing here changes a request. It only tells the panel what to show for a person to review.
 */

export const latePaymentLabel = "Pago recibido fuera de término";
/** For a row under a "Pagos" heading, where the tag column is narrow. */
export const latePaymentTag = "Fuera de término";

type RequestState = { id: string; status?: string | null };
type PaymentState = { booking_intent_id: string; status: string; provider?: string | null; approved_at?: string | null };

/**
 * Only a payment known to be from Mercado Pago can be late. A charge the practice recorded (provider 'offline'),
 * a payment through an external link, or one whose provider was not loaded is never treated as one: whoever
 * shows late payments has to load the provider.
 */
export function isLatePayment(payment: PaymentState, intent: RequestState | undefined): boolean {
  return payment.status === "approved" && intent?.status === "cancelled" && payment.provider === "mercado_pago_ar";
}

/** The late payments among `payments`, each with its request, most recently approved first. */
export function latePayments<I extends RequestState, P extends PaymentState>(intents: I[], payments: P[]): { intent: I; payment: P }[] {
  const byId = new Map(intents.map((intent) => [intent.id, intent]));
  return payments.flatMap((payment) => {
    const intent = byId.get(payment.booking_intent_id);
    return intent && isLatePayment(payment, intent) ? [{ intent, payment }] : [];
  }).sort((a, b) => (b.payment.approved_at ?? "").localeCompare(a.payment.approved_at ?? ""));
}
