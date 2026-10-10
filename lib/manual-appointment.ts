/** State and wording of a manual appointment being created. No data access: the screens load and save. */

export type PaymentMethod = "cash" | "transfer" | "other";
export const paymentMethodLabels: Record<PaymentMethod, string> = { cash: "Efectivo", transfer: "Transferencia", other: "Otro" };
export const paymentMethods = Object.keys(paymentMethodLabels) as PaymentMethod[];

/** `amount` is what the person typed, in pesos. `day` is a local date; `slot` is the instant the server offered. */
export type ManualDraft = { patientId: string; professionalId: string; serviceId: string; day: string; slot: string; paid: boolean; method: PaymentMethod | ""; amount: string };

export function emptyDraft(professionalId = ""): ManualDraft {
  return { patientId: "", professionalId, serviceId: "", day: "", slot: "", paid: false, method: "", amount: "" };
}

/** Another agenda has other services and other free times: both are chosen again. */
export function selectProfessional(draft: ManualDraft, professionalId: string): ManualDraft {
  return professionalId === draft.professionalId ? draft : { ...draft, professionalId, serviceId: "", slot: "", amount: "" };
}

/** The duration comes from the service, so the times offered change; its price becomes the suggested amount. */
export function selectService(draft: ManualDraft, service: { id: string; price_minor: number } | null): ManualDraft {
  if (service?.id === draft.serviceId) return draft;
  return { ...draft, serviceId: service?.id ?? "", slot: "", amount: service ? amountText(service.price_minor) : "" };
}

/** A time belongs to its day: changing the date drops it. */
export function selectDay(draft: ManualDraft, day: string): ManualDraft {
  return day === draft.day ? draft : { ...draft, day, slot: "" };
}

/** Only a time the server offered for the current day can be chosen. */
export function selectSlot(draft: ManualDraft, slot: string, offered: string[]): ManualDraft {
  return offered.includes(slot) ? { ...draft, slot } : draft;
}

/** Pending has no method: nothing was charged yet. The amount stays as a suggestion for later. */
export function setPaid(draft: ManualDraft, paid: boolean): ManualDraft {
  return { ...draft, paid, method: paid ? draft.method : "" };
}

/** Pesos as the amount field shows them: no thousands separator, comma only when there are cents. */
export function amountText(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2).replace(".", ",");
}

/**
 * The typed amount in cents, or null when it is not a positive amount. Accepts "25000", "25000,50" and "25.000":
 * a dot followed by exactly three digits is a thousands separator, as people write pesos.
 */
export function parseAmountMinor(text: string): number | null {
  const clean = text.trim().replace(/\s|\$/g, "");
  if (!/^\d{1,3}(\.\d{3})+(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(clean)) return null;
  const normalized = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(clean) ? clean.replace(/\./g, "").replace(",", ".") : clean.replace(",", ".");
  const minor = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(minor) && minor > 0 && minor <= 2_000_000_000 ? minor : null;
}

/** What is wrong with the payment part, or null. Pending needs nothing; paid needs a method and a positive amount. */
export function paymentProblem(draft: Pick<ManualDraft, "paid" | "method" | "amount">): string | null {
  if (!draft.paid) return null;
  if (!draft.method) return "Elegí cómo se cobró: efectivo, transferencia u otro.";
  if (parseAmountMinor(draft.amount) === null) return "Ingresá el importe cobrado, mayor a 0.";
  return null;
}

/** The first thing still missing before the appointment can be created, or null when it is complete. */
export function draftProblem(draft: ManualDraft): string | null {
  if (!draft.patientId) return "Elegí un paciente.";
  if (!draft.professionalId) return "Elegí un profesional.";
  if (!draft.serviceId) return "Elegí un servicio.";
  if (!draft.day) return "Elegí una fecha.";
  if (!draft.slot) return "Elegí un horario.";
  return paymentProblem(draft);
}

/** What is sent when saving. A pending payment sends no method and no amount: there is no payment yet. */
export function paymentArgs(draft: Pick<ManualDraft, "paid" | "method" | "amount">): { method: PaymentMethod | null; amountMinor: number | null } {
  return draft.paid && draft.method ? { method: draft.method, amountMinor: parseAmountMinor(draft.amount) } : { method: null, amountMinor: null };
}

/**
 * How a payment is named on screen, the same everywhere: agenda, patient record, history and demo.
 * Nothing charged yet, or a payment still waiting, is "Pendiente". A charge the practice recorded shows its
 * method and is never called Mercado Pago. Only a payment that carries the Mercado Pago provider is called so:
 * a missing provider is not assumed to be one. A payment that did not go through keeps its outcome next to the name.
 */
export function paymentLabel(payment: { provider?: string | null; method?: string | null; status?: string | null } | null | undefined): string {
  if (!payment || payment.status === "pending") return "Pendiente";
  const name = payment.provider === "offline" ? paymentMethodLabels[payment.method as PaymentMethod] ?? "Fuera de Bellis"
    : payment.provider === "mercado_pago_ar" ? "Mercado Pago" : payment.provider === "external_link" ? "Link de pago" : "Pago";
  const outcome: Record<string, string> = { rejected: "rechazado", refunded: "reembolsado", cancelled: "cancelado", expired: "vencido" };
  return payment.status && outcome[payment.status] ? `${name} · ${outcome[payment.status]}` : name;
}

/**
 * Whether "Registrar pago" is offered for an appointment: only one the practice loaded itself, still active, and
 * with no payment on record. An appointment has one payment, so a second charge is never offered.
 */
export function canRecordPayment(input: { source?: string | null; appointmentStatus?: string | null; hasPayment: boolean }): boolean {
  return input.source === "manual" && !input.hasPayment && (input.appointmentStatus === "scheduled" || input.appointmentStatus === "completed");
}

/**
 * What to tell the person when recording a charge fails. `alreadyPaid` means someone recorded it first: the
 * screen reloads the appointment instead of offering to charge again.
 */
export function describePaymentError(message: string): { text: string; alreadyPaid: boolean } {
  const has = (code: string) => message.includes(code);
  if (has("payment_already_recorded") || has("payments_one_per_intent")) return { text: "Este turno ya tiene un cobro registrado.", alreadyPaid: true };
  if (has("invalid_payment")) return { text: "Revisá el cobro: el medio y un importe mayor a 0.", alreadyPaid: false };
  if (has("appointment_not_active")) return { text: "Este turno fue cancelado: no se puede registrar un cobro.", alreadyPaid: false };
  if (has("not_manual_appointment")) return { text: "Este turno se cobra por el medio de pago de la reserva, no desde acá.", alreadyPaid: false };
  if (has("not_authorized")) return { text: "No tenés permiso para registrar cobros en esta agenda.", alreadyPaid: false };
  if (has("authentication_required") || has("JWT")) return { text: "Tu sesión venció. Volvé a ingresar.", alreadyPaid: false };
  if (/failed to fetch|networkerror|load failed/i.test(message)) return { text: "No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.", alreadyPaid: false };
  return { text: "No pudimos registrar el cobro. Intentá de nuevo.", alreadyPaid: false };
}

/**
 * What to tell the person when saving fails. `slotConflict` means the time is no longer free: the times are
 * loaded again and everything else in the form is kept.
 */
export function describeManualError(message: string): { text: string; slotConflict: boolean } {
  const has = (code: string) => message.includes(code);
  if (has("slot_unavailable")) return { text: "Ese horario acaba de ocuparse. Elegí otro.", slotConflict: true };
  if (has("slot_in_past")) return { text: "Ese horario ya pasó. Elegí otro.", slotConflict: true };
  if (has("appointments_no_overlap")) return { text: "Ese horario acaba de ocuparse. Elegí otro.", slotConflict: true };
  if (has("invalid_patient")) return { text: "No pudimos usar ese paciente. Elegilo de nuevo.", slotConflict: false };
  if (has("invalid_service")) return { text: "Ese servicio ya no está disponible. Elegí otro.", slotConflict: false };
  if (has("invalid_payment")) return { text: "Revisá el cobro: el medio y un importe mayor a 0.", slotConflict: false };
  if (has("not_authorized")) return { text: "No tenés permiso para cargar turnos en esta agenda.", slotConflict: false };
  if (has("authentication_required") || has("JWT")) return { text: "Tu sesión venció. Volvé a ingresar.", slotConflict: false };
  if (/failed to fetch|networkerror|load failed/i.test(message)) return { text: "No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.", slotConflict: false };
  return { text: "No pudimos crear el turno. Intentá de nuevo.", slotConflict: false };
}

/**
 * The form after a failed save. When the time is no longer free only the time is dropped, so the person picks
 * another one: patient, professional, service, day and payment stay exactly as they were, and `refreshSlots`
 * asks for the times again. Any other failure leaves the draft untouched.
 */
export function afterCreateError(draft: ManualDraft, message: string): { draft: ManualDraft; text: string; refreshSlots: boolean } {
  const failure = describeManualError(message);
  return { draft: failure.slotConflict ? { ...draft, slot: "" } : draft, text: failure.text, refreshSlots: failure.slotConflict };
}

/**
 * Whether "Cancelar turno" is offered: only for an appointment the practice loaded itself that is still scheduled.
 * One already attended is not cancelled, and one from the public booking has its own payment circuit.
 */
export function canCancelAppointment(input: { source?: string | null; appointmentStatus?: string | null }): boolean {
  return input.source === "manual" && input.appointmentStatus === "scheduled";
}

/**
 * What cancelling asks first. With no charge on record the person says what happened with it: cancel without
 * charging, or charge it anyway (a late cancellation). With a charge already recorded nothing is asked: it is kept.
 */
export function cancelQuestion(hasPayment: boolean): "ask_charge" | "confirm_paid" {
  return hasPayment ? "confirm_paid" : "ask_charge";
}

export type CancelArgs = { mode: "no_payment"; method: null; amountMinor: null } | { mode: "record_payment"; method: PaymentMethod; amountMinor: number };

/** What is sent when cancelling. Without a charge, or with one already recorded, no method and no amount are sent. */
export function cancelArgs(choice: { charge: boolean; method: PaymentMethod | ""; amount: string }): CancelArgs | null {
  if (!choice.charge) return { mode: "no_payment", method: null, amountMinor: null };
  const amountMinor = parseAmountMinor(choice.amount);
  return choice.method && amountMinor !== null ? { mode: "record_payment", method: choice.method, amountMinor } : null;
}

/** How the charge of an appointment reads next to its state. A cancelled one with nothing charged is not "pending". */
export function chargeLabel(payment: Parameters<typeof paymentLabel>[0], appointmentStatus?: string | null): string {
  return appointmentStatus === "cancelled" && (!payment || payment.status === "pending") ? "Sin cobro" : paymentLabel(payment);
}

/**
 * What to tell the person when cancelling fails. `reload` means the appointment changed under them (someone
 * cancelled it or recorded its charge first): the screen reads it again so it shows what is true now.
 */
export function describeCancelError(message: string): { text: string; reload: boolean } {
  const has = (code: string) => message.includes(code);
  if (has("appointment_already_cancelled")) return { text: "Este turno ya estaba cancelado.", reload: true };
  if (has("payment_already_recorded") || has("payments_one_per_intent")) return { text: "Este turno ya tiene un cobro registrado. Podés cancelarlo igual: el cobro se conserva.", reload: true };
  if (has("appointment_not_cancellable")) return { text: "Este turno ya fue atendido: no se puede cancelar.", reload: true };
  if (has("not_manual_appointment")) return { text: "Este turno fue reservado por el paciente: no se cancela desde acá.", reload: false };
  if (has("invalid_payment")) return { text: "Revisá el cobro: el medio y un importe mayor a 0.", reload: false };
  if (has("not_authorized")) return { text: "No tenés permiso para cancelar turnos en esta agenda.", reload: false };
  if (has("authentication_required") || has("JWT")) return { text: "Tu sesión venció. Volvé a ingresar.", reload: false };
  if (/failed to fetch|networkerror|load failed/i.test(message)) return { text: "No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.", reload: false };
  return { text: "No pudimos cancelar el turno. Intentá de nuevo.", reload: false };
}
