export type Appointment = { id: string; booking_intent_id: string; professional_id: string; starts_at: string; status: string; created_at: string; status_changed_at: string | null };
/** `status` is the request's own state. A cancelled request with an approved payment is a late payment (see lib/late-payments.ts). */
export type Intent = { id: string; service_id: string; professional_id: string; created_at: string; status?: string; /** 'manual' when the practice loaded the appointment itself. */ source?: string; price_minor?: number };
/** `provider` and `method` say how it was paid. `method` only exists for charges the practice recorded (provider 'offline'). */
export type Payment = { id: string; booking_intent_id: string; amount_minor: number; currency_code: string; status: string; created_at: string; approved_at: string | null; provider?: string | null; method?: string | null };
/** Internal note types. There is no clinical type: clinical records wait for the privacy and retention policy. */
export type NoteType = "general" | "follow_up" | "administrative" | "payment";
export const noteTypeLabels: Record<NoteType, string> = { general: "General", follow_up: "Seguimiento", administrative: "Administrativa", payment: "Pago" };
export type Note = { id: string; author_id: string; content: string; note_type: NoteType; created_at: string; updated_at: string };
export type Activity = { id: string; professional_id: string; type: "call" | "email" | "whatsapp" | "other" | "automation_created_follow_up"; title: string; description: string; metadata?: { follow_up_id?: string; automation_run_id?: string }; created_by: string; created_at: string };
export type FollowUp = { id: string; patient_id: string; professional_id: string; title: string; description: string; due_date: string; due_time: string | null; priority: "low" | "medium" | "high"; status: "pending" | "completed" | "cancelled"; source: "manual" | "automation"; automation_run_id: string | null; completed_at: string | null; cancelled_at: string | null; created_by: string; created_at: string; updated_at: string };
export type TimelineEvent = { id: string; at: string; kind: "patient" | "appointment" | "payment" | "note" | "activity" | "follow_up"; title: string; description: string; actor?: string; approximate?: boolean; followUpId?: string; automationRunId?: string };

export function todayInTimezone(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function followUpBucket(dueDate: string | null, today: string): "none" | "overdue" | "today" | "upcoming" {
  if (!dueDate) return "none";
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "upcoming";
}

export const followUpLabels = { none: "Sin seguimiento", overdue: "Vencido", today: "Hoy", upcoming: "Próximo" };
export const priorityLabels = { low: "Baja", medium: "Media", high: "Alta" };

export function buildPatientTimeline(input: {
  patientCreatedAt: string;
  appointments: Appointment[];
  intents: Intent[];
  payments: Payment[];
  notes: Note[];
  activities: Activity[];
  followUps: FollowUp[];
  services: Map<string, string>;
  professionals: Map<string, string>;
  money: (amountMinor: number, currency: string) => string;
  /** How a payment is named (lib/manual-appointment paymentLabel). Shown next to a payment that was received. */
  paymentName?: (payment: Payment) => string;
  /** What a late payment is (lib/late-payments isLatePayment). Without it no payment is worded as late. */
  isLatePayment?: (payment: Payment, intent: Intent | undefined) => boolean;
}): TimelineEvent[] {
  const events: TimelineEvent[] = [{ id: "patient-created", at: input.patientCreatedAt, kind: "patient", title: "Paciente creado", description: "Ficha creada en Bellis." }];
  const intents = new Map(input.intents.map((intent) => [intent.id, intent]));
  for (const appointment of input.appointments) {
    const intent = intents.get(appointment.booking_intent_id);
    const service = input.services.get(intent?.service_id ?? "") ?? "Turno";
    const actor = input.professionals.get(appointment.professional_id);
    events.push({ id: `appointment-created-${appointment.id}`, at: appointment.created_at, kind: "appointment", title: "Turno reservado", description: service, actor });
    if (appointment.status === "completed" || appointment.status === "cancelled") {
      events.push({ id: `appointment-status-${appointment.id}`, at: appointment.status_changed_at ?? appointment.starts_at,
        kind: "appointment", title: appointment.status === "completed" ? "Turno completado" : "Turno cancelado",
        description: appointment.status_changed_at ? service : `${service} · hora exacta del cambio no disponible`, actor,
        approximate: !appointment.status_changed_at });
    }
  }
  for (const payment of input.payments) {
    const intent = intents.get(payment.booking_intent_id);
    if (payment.status !== "approved" && payment.status !== "pending") continue;
    // Approved after its request closed: the money came in and there is no appointment. Never worded as a booking.
    const late = input.isLatePayment?.(payment, intent) ?? false;
    const name = payment.status === "approved" ? input.paymentName?.(payment) : undefined;
    events.push({ id: `payment-${payment.id}`, at: payment.status === "approved" ? payment.approved_at ?? payment.created_at : payment.created_at,
      kind: "payment", title: late ? "Pago recibido fuera de término" : payment.status === "approved" ? "Pago recibido" : "Pago pendiente",
      description: `${input.money(payment.amount_minor, payment.currency_code.trim())} · ${input.services.get(intent?.service_id ?? "") ?? "Servicio"}${name ? ` · ${name}` : ""}${late ? " · la solicitud ya había vencido: sin turno" : ""}` });
  }
  // The full text lives in the Notas section; the history only shows where each note falls in time.
  for (const note of input.notes) events.push({ id: `note-${note.id}`, at: note.created_at, kind: "note", title: `Nota agregada · ${noteTypeLabels[note.note_type] ?? noteTypeLabels.general}`,
    description: note.content.length > 140 ? `${note.content.slice(0, 140).trimEnd()}…` : note.content, actor: input.professionals.get(note.author_id) });
  const activityNames = { call: "Llamada registrada", email: "Email registrado", whatsapp: "WhatsApp registrado", other: "Interacción registrada", automation_created_follow_up: "⚙ Seguimiento automático creado" };
  for (const activity of input.activities) events.push({ id: `activity-${activity.id}`, at: activity.created_at, kind: "activity",
    title: activityNames[activity.type], description: activity.type === "automation_created_follow_up" ? activity.description : `${activity.title} · ${activity.description}`,
    actor: activity.type === "automation_created_follow_up" ? undefined : input.professionals.get(activity.professional_id), followUpId: activity.metadata?.follow_up_id, automationRunId: activity.metadata?.automation_run_id });
  for (const followUp of input.followUps) {
    const actor = input.professionals.get(followUp.professional_id);
    events.push({ id: `follow-up-created-${followUp.id}`, at: followUp.created_at, kind: "follow_up", title: followUp.source === "automation" ? "Seguimiento generado por Bellis" : "Seguimiento creado", description: followUp.title, actor: followUp.source === "automation" ? undefined : actor, followUpId: followUp.id, automationRunId: followUp.automation_run_id ?? undefined });
    if (followUp.completed_at) events.push({ id: `follow-up-completed-${followUp.id}`, at: followUp.completed_at, kind: "follow_up", title: "Seguimiento completado", description: followUp.title, actor });
    if (followUp.cancelled_at) events.push({ id: `follow-up-cancelled-${followUp.id}`, at: followUp.cancelled_at, kind: "follow_up", title: "Seguimiento cancelado", description: followUp.title, actor });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
