/**
 * The patient's way back from Mercado Pago. The return address carries an opaque token for their request
 * and a hint of how the checkout ended. The hint is for wording only: what the patient may do next is always
 * decided from what the server holds for that request.
 */

export const resumeTokenPattern = /^[a-f0-9]{64}$/;

export function newResumeToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Where Mercado Pago sends the patient back. Nothing but the slug, the opaque token and the hint. */
export function checkoutReturnUrls(origin: string, slug: string, resumeToken: string): { success: string; pending: string; failure: string } {
  const to = (hint: string) => `${origin}/p/${slug}?resume=${resumeToken}&mp=${hint}`;
  return { success: to("success"), pending: to("pending"), failure: to("failure") };
}

export type ResumeRecord = {
  intent: { status: string; expires_at: string; price_minor: number; currency_code: string; duration_minutes: number; service_id: string };
  slug: string;
  service: { name: string; modality: string };
  payment: { status: string; checkout_url: string | null } | null;
  appointment: { starts_at: string; ends_at: string } | null;
};
export type ResumeAnswer =
  | { ok: true; body: {
      step: "payment" | "schedule" | "done"; paymentStatus: string;
      service: { id: string; name: string; modality: string; duration_minutes: number; price_minor: number; currency_code: string };
      checkoutUrl: string | null; appointment: { starts_at: string; ends_at: string } | null } }
  | { ok: false; status: 404 | 410; body: { error: string; code: "invalid" | "expired" } };

const notFound: ResumeAnswer = { ok: false, status: 404, body: { error: "No pudimos recuperar esta reserva.", code: "invalid" } };

/**
 * What a returning patient gets for a resume token. `record` is what the server found for that token (or nothing),
 * `slug` is the page they came back to. A token for another professional's page, or for a request that is closed,
 * answers exactly like a token that does not exist.
 */
export function resumeAnswer(record: ResumeRecord | null, slug: string, now: number): ResumeAnswer {
  if (!record || record.slug !== slug) return notFound;
  const { intent, payment } = record;
  if (["cancelled", "refunded", "completed"].includes(intent.status)) return notFound;
  const service = { id: intent.service_id, name: record.service.name, modality: record.service.modality,
    duration_minutes: intent.duration_minutes, price_minor: intent.price_minor, currency_code: intent.currency_code.trim() };
  const paymentStatus = payment?.status ?? "pending";
  if (intent.status === "scheduled" && record.appointment)
    return { ok: true, body: { step: "done", paymentStatus, service, checkoutUrl: null, appointment: record.appointment } };
  if (!(Date.parse(intent.expires_at) > now))
    return { ok: false, status: 410, body: { error: "Esta reserva venció. Empezá de nuevo para elegir un turno.", code: "expired" } };
  // Choosing a time needs both: the request unlocked and an approved payment on record.
  if ((intent.status === "awaiting_schedule" || intent.status === "payment_confirmed") && paymentStatus === "approved")
    return { ok: true, body: { step: "schedule", paymentStatus, service, checkoutUrl: null, appointment: null } };
  if (intent.status !== "pending_payment") return notFound;
  return { ok: true, body: { step: "payment", paymentStatus, service, checkoutUrl: payment?.checkout_url ?? null, appointment: null } };
}
