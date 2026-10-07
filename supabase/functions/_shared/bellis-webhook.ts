import { verifyMercadoPagoSignature, type VerifiedMercadoPagoPayment } from "./mercado-pago.ts";
import type { ValidAccount } from "./mercado-pago-oauth.ts";
import { isPermanentPaymentError, paymentErrorCode, type LogFields } from "./payment-errors.ts";

/**
 * What the webhook answers to a notification, decided apart from the database and from Mercado Pago so every
 * case can be tested. Mercado Pago sends a notification again until it gets a 200 or 201:
 *   401  not signed by Mercado Pago. Nothing is read or written.
 *   400  signed, but the body is not what it claims to be.
 *   200  handled, already handled, or something no retry would ever change (logged as such).
 *   503  could not be handled right now: send it again.
 */

export type WebhookIntent = { id: string; workspace_id: string; price_minor: number; currency_code: string };
export type WebhookDeps = {
  findIntent(intentId: string): Promise<WebhookIntent | null>;
  /** The seller account of the workspace with a usable token. Throws when there is none right now. */
  account(workspaceId: string): Promise<ValidAccount>;
  getPayment(workspaceId: string, account: ValidAccount, paymentId: string): Promise<VerifiedMercadoPagoPayment>;
  /** Records the verified payment. False when that status was already on record. */
  record(intent: WebhookIntent, account: ValidAccount, payment: VerifiedMercadoPagoPayment, eventId: string): Promise<boolean>;
};
export type WebhookAnswer = { status: 200 | 400 | 401 | 405 | 413 | 503; level: "info" | "warn" | "error"; event: string; fields: LogFields };

const answer = (status: WebhookAnswer["status"], level: WebhookAnswer["level"], event: string, fields: LogFields = {}): WebhookAnswer =>
  ({ status, level, event, fields: { ...fields, http_status: status } });
const topicPattern = /^[a-z0-9_.-]{1,40}$/i;

export async function answerNotification(request: Request, secret: string, deps: WebhookDeps): Promise<WebhookAnswer> {
  if (request.method !== "POST") return answer(405, "info", "webhook_wrong_method");
  if (Number(request.headers.get("content-length") ?? "0") > 10000) return answer(413, "warn", "webhook_too_large");
  // Without the secret nothing can be verified. That is Bellis's problem, not a forged request: ask for a retry.
  if (!secret) return answer(503, "error", "webhook_not_configured", { error_code: "mp_config_missing", retry: true });
  const dataId = await verifyMercadoPagoSignature(request, secret);
  if (!dataId) return answer(401, "warn", "webhook_rejected", { error_code: "mp_webhook_invalid_signature" });
  let event: { id?: unknown; type?: unknown; action?: unknown; data?: { id?: unknown } };
  try { event = await request.json(); } catch { return answer(400, "warn", "webhook_rejected", { error_code: "mp_webhook_malformed" }); }
  const topic = typeof event?.type === "string" && topicPattern.test(event.type) ? event.type : "unknown";
  // Other topics of the same application (account linking, claims…) are acknowledged, so they are not sent again.
  if (topic !== "payment") {
    const action = typeof event?.action === "string" && topicPattern.test(event.action) ? event.action : undefined;
    return answer(200, "info", "webhook_ignored", { topic, action });
  }
  if (!/^\d{1,24}$/.test(dataId) || String(event.data?.id ?? "") !== dataId)
    return answer(400, "warn", "webhook_rejected", { error_code: "mp_webhook_malformed", topic });
  const paymentId = dataId;
  const intentId = new URL(request.url).searchParams.get("intent") ?? "";
  // A payment that does not say which request it belongs to cannot be looked up with any seller's token.
  if (!/^[a-f0-9-]{36}$/i.test(intentId)) return answer(200, "warn", "webhook_unroutable", { payment_id: paymentId });
  const fields: LogFields = { intent_id: intentId, payment_id: paymentId, provider: "mercado_pago_ar" };
  try {
    const intent = await deps.findIntent(intentId);
    if (!intent) return answer(200, "warn", "webhook_unroutable", fields);
    fields.workspace_id = intent.workspace_id;
    const account = await deps.account(intent.workspace_id);
    const payment = await deps.getPayment(intent.workspace_id, account, paymentId);
    const changed = await deps.record(intent, account, payment, `webhook:${String(event.id ?? paymentId).slice(0, 100)}`);
    return answer(200, "info", changed ? "payment_recorded" : "payment_unchanged", { ...fields, status: payment.status, changed });
  } catch (caught) {
    const code = paymentErrorCode(caught, "mp_payment_lookup_failed");
    // A payment that does not match the request will not match on the next attempt either.
    if (isPermanentPaymentError(code)) return answer(200, "error", "payment_refused", { ...fields, error_code: code, retry: false });
    return answer(503, "warn", "payment_deferred", { ...fields, error_code: code, retry: true });
  }
}
