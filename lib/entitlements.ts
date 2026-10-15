/**
 * What a workspace's plan lets it do, as the panel reads it. The server decides everything (workspace_access):
 * the plan in force, the dates, the days left and the list of capabilities. Nothing here compares dates or
 * decides a plan; it only reads that answer and words it.
 */

export type Capability =
  // Bellis Free: the agenda, the patients and working by hand.
  | "manual_patients" | "manual_appointments" | "manual_payments" | "patient_notes" | "public_booking" | "external_payment_link"
  // Bellis Pro: follow-ups, the CRM that groups and prioritizes patients, automations and Mercado Pago.
  | "followups" | "crm" | "smart_followups" | "automations" | "mercado_pago"
  // Bellis Pro, behind a rollout: available only where the server also has the workspace in the Google Calendar beta.
  | "google_calendar_sync"
  // Reserved for functions that do not exist yet.
  | "patient_origin" | "advanced_tags" | "insurance_management" | "weekly_metrics" | "advanced_insights" | "reports" | "marketing_tools";
export type Tier = "free" | "pro_trial" | "pro";

/** The answer of workspace_access, as it arrives. Dates are ISO strings; `trial_last_day` is a local date (YYYY-MM-DD). */
export type WorkspaceAccess = {
  tier: Tier; plan_code: string; has_pro_access: boolean; status: string;
  trial_started_at: string | null; trial_ends_at: string | null; trial_last_day: string | null; trial_days_remaining: number | null;
  pro_started_at: string | null; pro_ends_at: string | null;
  capabilities: string[]; upgrade_requested: boolean;
};

export const proPrice = "ARS 39.900 / mes";

/** The only question components ask about the plan. Unknown access (still loading, or it failed) has nothing of Pro. */
export function hasCapability(access: WorkspaceAccess | null | undefined, capability: Capability): boolean {
  return !!access && access.capabilities.includes(capability);
}

/** A local date as people write it here: 14/11. */
export function shortDay(day: string | null): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? "");
  return match ? `${match[3]}/${match[2]}` : "";
}
/** The last day of a period that ends at an instant, in Argentina. Used for "Pro hasta el…", never to decide access. */
export function lastDayOf(instant: string | null): string {
  if (!instant) return "";
  const end = new Date(new Date(instant).getTime() - 1000);
  // Read as parts and padded here: what "2-digit" prints for a day varies between engines.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(end);
  const part = (type: string) => (parts.find((item) => item.type === type)?.value ?? "").padStart(2, "0");
  return `${part("day")}/${part("month")}`;
}

const daysLeft = (days: number) => days === 1 ? "Te queda 1 día de Bellis Pro." : `Te quedan ${days} días de Bellis Pro.`;

export type PlanNotice = { kind: "trial" | "trial_ending" | "trial_ended" | "free" | "pro"; title: string; text: string; /** Can be put away by the person; what stays is the quiet line of the plan. */ dismissible: boolean };

/**
 * The one card of the plan in the summary, whatever the plan is: the trial and how long is left, the trial that
 * ended, Bellis Free or Bellis Pro. Calm on purpose: no countdown in hours, no alarm. `usesMercadoPago` adds what
 * will change for a practice that takes bookings with Mercado Pago. `endedSeen`: the person already read that the
 * trial ended, so the card says only which plan this is.
 */
export function planNotice(access: WorkspaceAccess | null | undefined, options: { usesMercadoPago?: boolean; endedSeen?: boolean } = {}): PlanNotice | null {
  if (!access) return null;
  if (access.tier === "pro") return { kind: "pro", title: "Tenés Bellis Pro activo.", text: access.pro_ends_at ? `Vigente hasta el ${lastDayOf(access.pro_ends_at)}.` : "", dismissible: false };
  if (access.tier === "pro_trial") {
    const days = access.trial_days_remaining ?? 0;
    const ends = `Tu prueba termina el ${shortDay(access.trial_last_day)}.`;
    const after = options.usesMercadoPago ? " Cuando termine, las reservas online con Mercado Pago se pausan. Podés seguir recibiéndolas con un link de pago." : "";
    if (days > 7) return { kind: "trial", title: "Estás probando Bellis Pro gratis.", text: `${daysLeft(days)} ${ends}`, dismissible: false };
    if (days > 3) return { kind: "trial_ending", title: daysLeft(days), text: `${ends} Después podés seguir usando Bellis Free sin costo.${after}`, dismissible: false };
    if (days > 1) return { kind: "trial_ending", title: "Tu prueba de Bellis Pro termina pronto.", text: `${daysLeft(days)} ${ends} Después podés seguir usando Bellis Free sin costo.${after}`, dismissible: false };
    if (days === 1) return { kind: "trial_ending", title: "Tu prueba termina mañana.", text: `Después podés seguir usando Bellis Free.${after}`, dismissible: false };
    return { kind: "trial_ending", title: "Tu prueba termina hoy.", text: `Después podés seguir usando Bellis Free.${after}`, dismissible: false };
  }
  // A trial that ended and no Pro: said once, until the person puts it away.
  if (access.trial_started_at && !options.endedSeen) return { kind: "trial_ended", title: "Tu prueba de Bellis Pro terminó.",
    text: "Podés seguir usando Bellis Free sin costo. Tus pacientes, turnos e historial siguen acá.", dismissible: true };
  return { kind: "free", title: "Usás Bellis Free.", text: "Gratis para siempre: agenda, pacientes, turnos, cobros manuales y notas.", dismissible: false };
}
/** Identifies one notice for "ya lo vi": a new trial end, or a later Pro, is another notice. */
export function planNoticeKey(access: WorkspaceAccess): string {
  return `${access.tier}:${access.trial_ends_at ?? ""}:${access.pro_ends_at ?? ""}`;
}

/** The plan in one or two lines, for the Bellis Pro page. */
export function planStatus(access: WorkspaceAccess | null | undefined): { title: string; detail: string } {
  if (!access) return { title: "", detail: "" };
  if (access.tier === "pro") return { title: "Tenés Bellis Pro activo.", detail: access.pro_ends_at ? `Vigente hasta el ${lastDayOf(access.pro_ends_at)}.` : "" };
  if (access.tier === "pro_trial") { const days = access.trial_days_remaining ?? 0;
    return { title: "Estás probando Bellis Pro.", detail: `${days === 0 ? "Hoy es el último día." : daysLeft(days)} Tu prueba termina el ${shortDay(access.trial_last_day)}. Sin tarjeta.` }; }
  return { title: "Actualmente usás Bellis Free.", detail: access.trial_started_at ? "Tu prueba de Bellis Pro terminó. Tus pacientes, turnos e historial siguen acá." : "Es gratis para siempre." };
}

/** What Bellis Pro adds today. Only things that exist: nothing here is a promise. */
export const proBenefits: { capability: Capability; title: string; text: string }[] = [
  { capability: "followups", title: "Seguimientos y CRM", text: "Anotá qué tenés que revisar de cada paciente y mirá de un vistazo quiénes necesitan atención: pagos pendientes, seguimientos vencidos y pacientes sin próximo turno." },
  { capability: "automations", title: "Automatizaciones", text: "Bellis te deja listos los seguimientos según lo que pasa con tus pacientes y turnos." },
  { capability: "mercado_pago", title: "Mercado Pago integrado", text: "Tus pacientes pagan al reservar y Bellis confirma el pago por vos." },
];
/** What Bellis Free is, in one line. */
export const freeSummary = "Bellis Free es gratis para siempre: agenda, pacientes, turnos y cobros manuales, notas y tu página pública con reservas.";

/** Why a part of the product is waiting for Bellis Pro, in the words used wherever it shows locked. */
export const proLockCopy: Record<"mercado_pago" | "automations" | "followups" | "notifications" | "crm", { title: string; text: string }> = {
  mercado_pago: { title: "Mercado Pago integrado", text: "Conectá Mercado Pago para reducir trabajo manual en tus cobros." },
  automations: { title: "Automatizaciones es parte de Bellis Pro", text: "Automatizá tareas repetitivas y reducí trabajo manual en tu práctica." },
  followups: { title: "Seguimientos es parte de Bellis Pro", text: "Llevá un control de los pacientes que necesitan atención y qué tenés que revisar después." },
  notifications: { title: "Notificaciones es parte de Bellis Pro", text: "Bellis te avisa cuando una automatización deja algo listo o necesita que lo revises." },
  crm: { title: "Seguimientos y pacientes que necesitan atención", text: "Con Bellis Pro ves de un vistazo a quién conviene volver a contactar y qué quedó pendiente." },
};

/**
 * How the navigation shows the sections that depend on the plan. There are three moments, and they are not the same:
 *   undefined  the plan is not resolved yet (the screen is still loading). Nothing is assumed, in either direction:
 *              those sections hold their place as neutral placeholders and the bell is not shown.
 *   null       it was asked and could not be read. Nothing of Bellis Pro is offered, same as Bellis Free.
 *   an access  what the server answered.
 * Never "Pro until proven otherwise": a Free workspace must not see a section of Pro flash by, and a Pro one must
 * not see locks flash by either.
 */
export type NavEntry = "open" | "locked" | "hidden" | "pending";
/** The sections whose look depends on the plan. Everything else in the navigation is the same for every plan. */
export const planSections = ["Seguimientos", "Automatizaciones", "Notificaciones"] as const;
export function navEntry(section: string, access: WorkspaceAccess | null | undefined): NavEntry {
  if (!(planSections as readonly string[]).includes(section)) return "open";
  if (access === undefined) return "pending";
  // Follow-ups and automations stay in place with a lock: they open a page that explains them.
  if (section === "Seguimientos") return hasCapability(access, "followups") ? "open" : "locked";
  if (section === "Automatizaciones") return hasCapability(access, "automations") ? "open" : "locked";
  // Notifications are what automations report: without them they are not a section of their own. Nothing is
  // deleted; what already ran is reached from Automatizaciones, in its activity history. No capability of their own.
  return hasCapability(access, "automations") ? "open" : "hidden";
}
/** The bell goes with the notifications: only once the plan is known and it has them. */
export function showsNotificationBell(access: WorkspaceAccess | null | undefined): boolean {
  return navEntry("Notificaciones", access) === "open";
}

/** Online bookings are on hold: the practice charges with Mercado Pago and its plan does not include it. */
export function bookingsPaused(access: WorkspaceAccess | null | undefined, paymentProvider: string | null | undefined): boolean {
  return !!access && paymentProvider === "mercado_pago_ar" && !hasCapability(access, "mercado_pago");
}
export const bookingsPausedCopy = {
  title: "Tus reservas online están en pausa",
  text: "Mercado Pago integrado es parte de Bellis Pro. Tu página pública sigue visible, pero los pacientes no pueden reservar ni pagar desde ahí. Tu conexión y tus pagos anteriores quedan guardados.",
  short: "Tus reservas online están en pausa porque Mercado Pago integrado requiere Bellis Pro.",
  useLink: "Usar un link de pago", learn: "Conocer Bellis Pro",
};

/** What the person reads after "Quiero Bellis Pro". Asking again while a request is open creates nothing new. */
export function upgradeRequestMessage(result: { created?: boolean } | null | undefined): string {
  return result?.created === false ? "Ya recibimos tu pedido. Te vamos a escribir para activar Bellis Pro." : "Recibimos tu pedido. Te vamos a escribir para activar Bellis Pro.";
}
export function describeUpgradeError(message: string): string {
  if (message.includes("not_authorized")) return "Solo quien administra el espacio puede pedir Bellis Pro.";
  if (message.includes("authentication_required") || message.includes("JWT")) return "Tu sesión venció. Volvé a ingresar.";
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.";
  return "No pudimos enviar tu pedido. Intentá de nuevo.";
}

/** Demo and tests: an access as the server would answer it for each plan. `today` is a local date. */
export function exampleAccess(tier: Tier, today: string, daysRemaining = 18): WorkspaceAccess {
  const day = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const free = ["manual_patients", "manual_appointments", "manual_payments", "patient_notes", "public_booking", "external_payment_link"];
  const pro = [...free, "followups", "crm", "smart_followups", "automations", "mercado_pago", "google_calendar_sync", "patient_origin", "advanced_tags", "insurance_management", "weekly_metrics", "advanced_insights", "reports", "marketing_tools"];
  const trial = tier === "pro_trial" ? { started: day(daysRemaining - 30), last: day(daysRemaining) } : { started: day(-45), last: day(-15) };
  return { tier, plan_code: tier === "pro" ? "pro" : "free", has_pro_access: tier !== "free", status: "active",
    trial_started_at: `${trial.started}T15:00:00Z`, trial_ends_at: `${day(tier === "pro_trial" ? daysRemaining + 1 : -14)}T03:00:00Z`, trial_last_day: trial.last,
    trial_days_remaining: tier === "pro_trial" ? daysRemaining : null,
    pro_started_at: tier === "pro" ? `${day(-10)}T15:00:00Z` : null, pro_ends_at: tier === "pro" ? `${day(21)}T03:00:00Z` : null,
    capabilities: tier === "free" ? free : pro, upgrade_requested: false };
}
