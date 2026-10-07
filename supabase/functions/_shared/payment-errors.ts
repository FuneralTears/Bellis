/**
 * One vocabulary for what can go wrong with payments, and one way to log it.
 * A code is technical and goes to the log and, as `code`, to the page. The sentence a patient reads is separate
 * and never carries the technical detail.
 */

export type PaymentErrorCode =
  | "mp_config_missing" | "mp_unavailable"
  | "mp_oauth_invalid_state" | "mp_oauth_exchange_failed"
  | "mp_connection_missing" | "mp_connection_expired" | "mp_connection_revoked" | "mp_refresh_failed"
  | "mp_preference_failed" | "mp_payment_lookup_failed" | "mp_payment_mismatch" | "mp_payment_status_unsupported"
  | "mp_webhook_invalid_signature" | "mp_webhook_malformed"
  | "booking_resume_invalid" | "booking_resume_expired" | "booking_intent_invalid"
  | "booking_payment_pending" | "booking_payment_rejected" | "booking_slot_unavailable"
  | "rate_limited" | "internal_error";

/** The short internal messages thrown by the payment modules and the database, and the code each one means. */
const known: Record<string, PaymentErrorCode> = {
  mercado_pago_not_connected: "mp_connection_missing",
  mercado_pago_token_expired: "mp_connection_expired",
  mercado_pago_token_rejected: "mp_connection_revoked",
  mercado_pago_seller_mismatch: "mp_connection_revoked",
  mercado_pago_oauth_not_configured: "mp_config_missing",
  mercado_pago_oauth_invalid_client: "mp_config_missing",
  mercado_pago_not_configured: "mp_config_missing",
  webhook_secret_missing: "mp_config_missing",
  mercado_pago_refresh_in_progress: "mp_refresh_failed",
  invalid_mercado_pago_oauth_response: "mp_refresh_failed",
  payment_verification_mismatch: "mp_payment_mismatch",
  payment_mismatch: "mp_payment_mismatch",
  refund_mismatch: "mp_payment_mismatch",
  invalid_mercado_pago_payment: "mp_payment_mismatch",
  invalid_payment_amount: "mp_payment_mismatch",
  invalid_payment_id: "mp_payment_mismatch",
  unsupported_payment_status: "mp_payment_status_unsupported",
  invalid_mercado_pago_preference: "mp_preference_failed",
  invalid_mercado_pago_checkout_url: "mp_preference_failed",
  invalid_mercado_pago_amount: "mp_preference_failed",
  checkout_not_saved: "mp_preference_failed",
  checkout_unavailable: "mp_preference_failed",
  payment_not_confirmed: "booking_payment_pending",
  slot_unavailable: "booking_slot_unavailable",
};

/**
 * The code for something that was thrown. `fallback` says what was being attempted, for failures that carry
 * no meaning of their own (a 404 from Mercado Pago, a network error, a database error).
 */
export function paymentErrorCode(caught: unknown, fallback: PaymentErrorCode = "internal_error"): PaymentErrorCode {
  const message = String((caught as { message?: unknown } | null)?.message ?? "");
  if (known[message]) return known[message];
  const http = /^mercado_pago(_oauth)?_http_(\d{3})$/.exec(message);
  if (http) {
    const status = Number(http[2]);
    if (status === 429 || status >= 500) return "mp_unavailable";
    return http[1] ? "mp_refresh_failed" : fallback;
  }
  return fallback;
}

/** A failure that will be the same however many times it is retried. Everything else may pass on its own. */
export function isPermanentPaymentError(code: PaymentErrorCode): boolean {
  return code === "mp_payment_mismatch" || code === "mp_payment_status_unsupported";
}

const startAgain = "No pudimos iniciar el pago en este momento. Intentá nuevamente más tarde.";
const patientMessages: Partial<Record<PaymentErrorCode, string>> = {
  booking_resume_invalid: "No pudimos recuperar esta reserva.",
  booking_resume_expired: "Esta reserva venció. Empezá de nuevo para elegir un turno.",
  booking_intent_invalid: "La solicitud venció o no existe",
  booking_payment_pending: "El pago todavía no está confirmado",
  booking_payment_rejected: "El pago no se aprobó. Podés intentarlo de nuevo.",
  booking_slot_unavailable: "Ese horario ya no está disponible. Elegí otro.",
  rate_limited: "Intentá nuevamente más tarde",
};
/** What a patient reads for a code. Anything about Mercado Pago or the connection reads the same: they cannot act on it. */
export function patientMessage(code: PaymentErrorCode): string {
  return patientMessages[code] ?? (code.startsWith("mp_") ? startAgain : "No pudimos completar la solicitud. Intentá nuevamente.");
}

export type LogFields = {
  workspace_id?: string | null; intent_id?: string | null; payment_id?: string | null;
  provider?: string; status?: string; error_code?: PaymentErrorCode; action?: string; topic?: string;
  http_status?: number; retry?: boolean; changed?: boolean; environment?: string;
};
const allowedFields = ["workspace_id", "intent_id", "payment_id", "provider", "status", "error_code", "action", "topic",
  "http_status", "retry", "changed", "environment"] as const;
// Ids and short codes only. A token, an authorization code or a return token never fits: too long, or a known shape.
const safeText = /^[A-Za-z0-9_.:-]{1,48}$/;
const secretShape = /^(APP_USR|TEST|TG)-/i;

/** The log entry for an event: a fixed set of fields, each one checked. Anything else given is dropped. */
export function logEntry(fn: string, event: string, fields: LogFields = {}, now: () => number = Date.now): Record<string, unknown> {
  const entry: Record<string, unknown> = { ts: new Date(now()).toISOString(), fn, event: safeText.test(event) ? event : "unknown" };
  for (const key of allowedFields) {
    const value = (fields as Record<string, unknown>)[key];
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) entry[key] = value;
    else if (typeof value === "string" && safeText.test(value) && !secretShape.test(value)) entry[key] = value;
  }
  return entry;
}

/** Writes one structured line. Never pass a request, a response body or anything read from Mercado Pago beyond ids and statuses. */
export function logEvent(fn: string, level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  console[level](JSON.stringify(logEntry(fn, event, fields)));
}
