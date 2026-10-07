/**
 * The patient's way back from Mercado Pago. The return address carries an opaque token for their request
 * and a hint of how the checkout ended. The hint is for wording only: what the patient may do next is always
 * decided from what the server holds for that request.
 */

import { patientMessage, paymentErrorCode, type PaymentErrorCode } from "./payment-errors.ts";

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
  | { ok: false; status: 404 | 410; body: { error: string; code: "booking_resume_invalid" | "booking_resume_expired" } };

const notFound: ResumeAnswer = { ok: false, status: 404, body: { error: patientMessage("booking_resume_invalid"), code: "booking_resume_invalid" } };

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
    return { ok: false, status: 410, body: { error: patientMessage("booking_resume_expired"), code: "booking_resume_expired" } };
  // Choosing a time needs both: the request unlocked and an approved payment on record.
  if ((intent.status === "awaiting_schedule" || intent.status === "payment_confirmed") && paymentStatus === "approved")
    return { ok: true, body: { step: "schedule", paymentStatus, service, checkoutUrl: null, appointment: null } };
  if (intent.status !== "pending_payment") return notFound;
  return { ok: true, body: { step: "payment", paymentStatus, service, checkoutUrl: payment?.checkout_url ?? null, appointment: null } };
}

export type BookingAnswer =
  | { ok: true; appointment: { starts_at: string; ends_at: string } }
  | { ok: false; status: 403 | 409; code: PaymentErrorCode; error: string };

/**
 * What a patient gets when they confirm a time. One request has one appointment, and the database enforces it:
 * when two tabs confirm at once, the one that arrives second is given the appointment that already exists
 * instead of an error. `failure` is what the database answered when it refused, `existing` what is on record afterwards.
 */
export function bookingAnswer(
  created: { starts_at: string; ends_at: string } | null, failure: unknown, existing: { starts_at: string; ends_at: string } | null,
): BookingAnswer {
  if (created) return { ok: true, appointment: created };
  if (existing) return { ok: true, appointment: existing };
  const code = paymentErrorCode(failure, "booking_slot_unavailable");
  return code === "booking_payment_pending"
    ? { ok: false, status: 403, code, error: patientMessage(code) }
    : { ok: false, status: 409, code: "booking_slot_unavailable", error: patientMessage("booking_slot_unavailable") };
}
