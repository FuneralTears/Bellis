import type { ResumedBooking } from "./bellis-public";

/**
 * Putting a patient back where they were in a booking: after a reload, and each time the payment is checked.
 * The browser keeps only the opaque token of the request. Where the patient stands (paying, choosing a time,
 * confirmed) is asked to the server every time; nothing kept in the browser decides it.
 */

export type Appointment = { starts_at: string; ends_at: string };
/** `resume` is the token that came back from the checkout; `access` the one the tab that started the request holds. */
export type SavedBooking = { token: string; kind: "access" | "resume"; checkoutUrl: string; serviceId: string };
export type PublicRequest = <T>(action: string, options?: { method?: "GET" | "POST"; body?: unknown; token?: string; params?: Record<string, string> }) => Promise<T>;
export type BookingView =
  | { view: "payment"; paymentStatus: string }
  | { view: "schedule"; paymentStatus: string }
  | { view: "done"; paymentStatus: string; appointment: Appointment }
  | { view: "gone"; reason: "expired" | "invalid" };
export type RestoredBooking = BookingView & { service: ResumedBooking["service"] | null; checkoutUrl: string | null };

export const savedBookingKey = (slug: string) => `bellis-intent:${slug}`;
const tokenPattern = /^[a-f0-9]{64}$/;

/** What was kept for this tab, or nothing when it is missing or not what this page wrote. */
export function readSavedBooking(raw: string | null): SavedBooking | null {
  let saved: Partial<SavedBooking> | null;
  try { saved = JSON.parse(raw ?? "null"); } catch { return null; }
  if (!saved || typeof saved.token !== "string" || !tokenPattern.test(saved.token)) return null;
  return { token: saved.token, kind: saved.kind === "resume" ? "resume" : "access",
    checkoutUrl: typeof saved.checkoutUrl === "string" ? saved.checkoutUrl : "", serviceId: typeof saved.serviceId === "string" ? saved.serviceId : "" };
}

// A time that can never be booked. The book action answers a request that already has an appointment with that
// appointment, whatever time is sent; for any other request this time is refused and nothing changes.
const neverBookable = "1970-01-01T00:00:00.000Z";

/** Where the request stands, as the server says. Used by the automatic check, the button and a reload alike. */
export async function bookingState(token: string, request: PublicRequest): Promise<BookingView> {
  let result: { status: string; paymentStatus: string };
  try { result = await request<{ status: string; paymentStatus: string }>("status", { token }); }
  catch (caught) {
    // The request is gone or expired: stop asking, and say so instead of waiting forever.
    if ((caught as { status?: number }).status === 404) return { view: "gone", reason: "expired" };
    throw caught;
  }
  if (result.status === "scheduled") {
    const { appointment } = await request<{ appointment: Appointment | null }>("book", { method: "POST", token, body: { startsAt: neverBookable } });
    if (!appointment) throw new Error("No pudimos recuperar tu turno. Intentá nuevamente.");
    return { view: "done", paymentStatus: result.paymentStatus, appointment };
  }
  if (result.status === "awaiting_schedule" || result.status === "payment_confirmed") return { view: "schedule", paymentStatus: result.paymentStatus };
  if (result.status === "pending_payment") return { view: "payment", paymentStatus: result.paymentStatus };
  return { view: "gone", reason: "invalid" };
}

/** The booking a tab was in, recovered from the server with the token it kept. */
export async function restoreBooking(saved: SavedBooking, slug: string, request: PublicRequest): Promise<RestoredBooking> {
  if (saved.kind !== "resume") return { ...await bookingState(saved.token, request), service: null, checkoutUrl: saved.checkoutUrl || null };
  let result: ResumedBooking;
  try { result = await request<ResumedBooking>("resume", { method: "POST", body: { resume: saved.token, slug } }); }
  catch (caught) {
    const status = (caught as { status?: number }).status;
    if (status === 410 || status === 404) return { view: "gone", reason: status === 410 ? "expired" : "invalid", service: null, checkoutUrl: null };
    throw caught;
  }
  const kept = { paymentStatus: result.paymentStatus, service: result.service, checkoutUrl: result.checkoutUrl };
  if (result.step === "done" && result.appointment) return { view: "done", appointment: result.appointment, ...kept };
  return { view: result.step === "schedule" ? "schedule" : "payment", ...kept };
}

/** The screen of the flow for a view. A check that answers late never takes the patient back a screen. */
export function stepForView(view: BookingView, current: number): number {
  if (view.view === "gone") return current;
  return Math.max(current, view.view === "done" ? 5 : view.view === "schedule" ? 4 : 3);
}

/** What the patient reads after asking for the payment status when nothing else on the screen changes. */
export function paymentCheckNote(view: BookingView): string {
  return view.view === "payment" && view.paymentStatus === "pending" ? "El pago todavía está pendiente. Puede demorar unos instantes." : "";
}

/** What the patient reads when the status could not be asked. The server's own sentence is already written for them. */
export function paymentCheckError(caught: unknown): string {
  const failure = caught as { status?: number; message?: string } | null;
  return typeof failure?.status === "number" && failure.message ? failure.message
    : "No pudimos consultar el estado del pago. Revisá tu conexión e intentá nuevamente.";
}

/** Runs one `work` at a time: a call made while another is under way gets that same answer. */
export function singleFlight<T>(work: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => running ??= work().finally(() => { running = null; });
}
