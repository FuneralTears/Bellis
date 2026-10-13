/**
 * Bellis internal backoffice: plan changes done by hand by the team (there is no automatic billing).
 * What is shown, which actions exist and how dates are worked out. Nothing here decides who may do it: the server
 * only lets the 'admin' role change a plan, whatever the screen offers.
 *
 * Dates: a plan is entered as its LAST VALID DAY in Argentina ("Pro hasta el 30/11" includes the 30th). The server
 * stores the first instant it is no longer valid: 00:00 of the next day in Argentina, which is 03:00 UTC.
 * Pure module (no imports at runtime) so the Node tests can load it.
 */
import type { AdminRole, AdminTier } from "./admin";

export type PlanDialogMode = "activate" | "extend" | "downgrade";
export type PlanChangeAction = "pro_activated" | "pro_extended" | "downgraded_to_free" | "upgrade_request_resolved" | "upgrade_request_dismissed";
export type AdminPlanChange = { id: number; action: PlanChangeAction; previous_effective_tier: AdminTier; new_effective_tier: AdminTier; previous_plan_code: string; new_plan_code: string;
  previous_pro_ends_at: string | null; new_pro_ends_at: string | null; previous_trial_ends_at: string | null; new_trial_ends_at: string | null;
  /** Who did it, named for the team by the server: "Vos" for the person looking, otherwise that admin's address. */
  by_me: boolean; actor_label: string; created_at: string };
export type PlanChangeResult = { action: PlanChangeAction | "unchanged"; workspace_id: string; effective_tier: AdminTier; plan_code: string; pro_started_at: string | null; pro_ends_at: string | null; request_resolved: boolean };

export type RequestStatus = "open" | "resolved" | "dismissed";
export type RequestAction = "activate" | "resolve" | "dismiss";
export type AdminUpgradeRequest = { request_id: string; workspace_id: string; workspace_name: string; owner_email: string | null; profession: string | null;
  requested_plan: string; status: RequestStatus; requested_at: string; resolved_at: string | null; resolution: PlanChangeAction | null;
  effective_tier: AdminTier; plan_code: string; workspace_status: string; trial_ends_at: string | null; pro_ends_at: string | null;
  last_sign_in_at: string | null; last_activity_at: string | null; patient_count: number; appointment_count: number; public_booking_count: number };
export type AdminUpgradeRequestPage = { total: number; limit: number; offset: number; open: number; rows: AdminUpgradeRequest[] };
export const requestStatusLabels: Record<RequestStatus, string> = { open: "Abiertas", resolved: "Resueltas", dismissed: "Descartadas" };

/** What the plan of a workspace looks like for the commercial actions. */
export type PlanSubject = { workspace_name: string; effective_tier: AdminTier; plan_code: string; trial_ends_at: string | null; pro_ends_at: string | null; mercado_pago_connected?: boolean };

const dayMs = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");
const toDay = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const parseDay = (day: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return toDay(date) === day ? date : null;
};
/** The calendar day in Argentina (UTC-3, no daylight saving) for an instant, as YYYY-MM-DD. */
export function argentinaDay(instant: Date | string): string {
  return toDay(new Date(new Date(instant).getTime() - 3 * 3_600_000));
}
/** The last day a plan is valid, from the instant it ends. */
export function lastValidDayOf(endsAt: string | null | undefined): string | null {
  return endsAt ? argentinaDay(new Date(new Date(endsAt).getTime() - 1000)) : null;
}
/** The instant the server stores for a plan that is valid through `day`: 00:00 of the next day in Argentina. */
export function proEndsAtForLastDay(day: string): string | null {
  const date = parseDay(day);
  return date ? new Date(date.getTime() + dayMs + 3 * 3_600_000).toISOString() : null;
}
/** DD/MM/YYYY for a YYYY-MM-DD day. */
export function dayLabel(day: string | null | undefined): string {
  const date = day ? parseDay(day) : null;
  return date ? `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}` : "—";
}

export type PlanShortcut = { key: string; label: string; days?: number; months?: number };
export const planShortcuts: PlanShortcut[] = [{ key: "30d", label: "30 días", days: 30 }, { key: "3m", label: "3 meses", months: 3 }, { key: "6m", label: "6 meses", months: 6 }, { key: "12m", label: "12 meses", months: 12 }];
/** A day plus a shortcut. Months are calendar months; a 31st that does not exist lands on the last day of that month. */
export function addToDay(day: string, shortcut: Pick<PlanShortcut, "days" | "months">): string {
  const date = parseDay(day); if (!date) return day;
  if (shortcut.days) return toDay(new Date(date.getTime() + shortcut.days * dayMs));
  const months = shortcut.months ?? 0;
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastOfMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return toDay(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), lastOfMonth))));
}
/**
 * Where a new period is counted from. Activating: today. Extending a Pro that is still running: its current last
 * day, so the time already paid for is not lost. A Pro that already ended is counted from today.
 */
export function periodBase(mode: PlanDialogMode, subject: Pick<PlanSubject, "pro_ends_at" | "effective_tier">, now: Date): string {
  const today = argentinaDay(now);
  const current = lastValidDayOf(subject.pro_ends_at);
  return mode === "extend" && subject.effective_tier === "pro" && current && current >= today ? current : today;
}
/** Why a last day cannot be used, or null when it can. Same rules the server applies. */
export function lastDayProblem(mode: PlanDialogMode, day: string, subject: Pick<PlanSubject, "pro_ends_at" | "effective_tier">, now: Date): string | null {
  if (!parseDay(day)) return "Elegí una fecha.";
  const today = argentinaDay(now);
  if (day < today) return "La fecha tiene que ser de hoy en adelante.";
  if (day > addToDay(today, { months: 36 })) return "La fecha no puede estar a más de tres años.";
  const current = lastValidDayOf(subject.pro_ends_at);
  if (mode === "extend" && subject.effective_tier === "pro" && current && day <= current) return `La nueva fecha tiene que ser posterior al vencimiento actual (${dayLabel(current)}).`;
  return null;
}

/** Which plan actions make sense for a workspace. None for support: they read, they do not change plans. */
export function planActions(subject: Pick<PlanSubject, "effective_tier">, role: AdminRole | null | undefined): PlanDialogMode[] {
  if (role !== "admin") return [];
  return subject.effective_tier === "pro" ? ["extend", "downgrade"] : ["activate"];
}
/** Which actions an open request offers. None for support, none once it is closed. */
export function requestActions(request: Pick<AdminUpgradeRequest, "status">, role: AdminRole | null | undefined): RequestAction[] {
  return role === "admin" && request.status === "open" ? ["activate", "resolve", "dismiss"] : [];
}

export const planDialogCopy: Record<PlanDialogMode, { title: string; cta: string }> = {
  activate: { title: "Activar Bellis Pro", cta: "Activar Bellis Pro" },
  extend: { title: "Extender Bellis Pro", cta: "Extender Bellis Pro" },
  downgrade: { title: "Volver a Bellis Free", cta: "Pasar a Bellis Free" },
};
export const downgradeCopy = "El consultorio conservará sus pacientes, turnos, seguimientos, historial y configuración. Las funciones Pro quedarán bloqueadas.";
export const mercadoPagoKeptCopy = "La conexión de Mercado Pago se conserva. El profesional podrá desconectarla después.";
/**
 * "Volver a Free" is Free from that moment. A trial that was still running ends with it: the admin is told before
 * confirming, because the workspace does not fall back to what was left of the trial.
 */
export function downgradeTrialNote(subject: Pick<PlanSubject, "trial_ends_at">, now: Date): string | null {
  const last = lastValidDayOf(subject.trial_ends_at);
  return last && last >= argentinaDay(now) ? `Su prueba de Bellis Pro, que seguía vigente hasta el ${dayLabel(last)}, también termina ahora. El consultorio queda en Bellis Free desde este momento.` : null;
}

/** What to tell the admin after a plan change. */
export function planChangeNotice(result: Pick<PlanChangeResult, "action" | "pro_ends_at" | "effective_tier">): string {
  const until = dayLabel(lastValidDayOf(result.pro_ends_at));
  if (result.action === "pro_activated") return `Bellis Pro quedó activo hasta el ${until}.`;
  if (result.action === "pro_extended") return `Bellis Pro quedó extendido hasta el ${until}.`;
  if (result.action === "downgraded_to_free") return "El consultorio pasó a Bellis Free.";
  return "No hubo cambios: el plan ya estaba así.";
}
export function requestNotice(action: RequestAction, endsAt: string | null | undefined): string {
  if (action === "activate") return `Bellis Pro quedó activo hasta el ${dayLabel(lastValidDayOf(endsAt))}. La solicitud quedó resuelta.`;
  return action === "resolve" ? "La solicitud quedó resuelta, sin cambiar el plan." : "La solicitud quedó descartada.";
}

const actionErrors: Record<string, string> = {
  pro_ends_at_required: "Elegí una fecha de hoy en adelante.",
  pro_ends_at_too_far: "La fecha no puede estar a más de tres años.",
  pro_end_not_extended: "La nueva fecha tiene que ser posterior al vencimiento actual.",
  invalid_plan: "Ese plan no existe.", invalid_plan_arguments: "Esa combinación de plan y fecha no es válida.",
  request_not_open: "Esta solicitud ya fue cerrada. Actualizá la página para ver su estado.",
  invalid_action: "Esa acción no existe.",
};
/** A sentence for an error of the commercial RPCs. Unknown ones never show their raw text. */
export function describePlanError(message: string | null | undefined): string {
  return actionErrors[String(message ?? "").trim()] ?? "No pudimos guardar el cambio. Probá de nuevo.";
}

const changeLabels: Record<PlanChangeAction, string> = {
  pro_activated: "Bellis Pro activado", pro_extended: "Bellis Pro extendido", downgraded_to_free: "Pasó a Bellis Free",
  upgrade_request_resolved: "Solicitud de Pro resuelta", upgrade_request_dismissed: "Solicitud de Pro descartada" };
/** One line for a row of the commercial history. */
export function planChangeLabel(change: Pick<AdminPlanChange, "action" | "new_pro_ends_at" | "previous_trial_ends_at" | "new_trial_ends_at">): string {
  const base = changeLabels[change.action] ?? "Cambio de plan";
  if (change.action === "pro_activated" || change.action === "pro_extended") return `${base} hasta el ${dayLabel(lastValidDayOf(change.new_pro_ends_at))}`;
  // The trial was still running and ended with the change.
  if (change.action === "downgraded_to_free" && change.new_trial_ends_at && change.previous_trial_ends_at !== change.new_trial_ends_at) return `${base} (la prueba terminó con el cambio)`;
  return base;
}
/** "Por Vos" or "Por <who>": who made a change, as the server names them for the team. */
export function actorLine(change: Pick<AdminPlanChange, "actor_label">): string {
  return `Por ${change.actor_label?.trim() || "alguien del equipo"}`;
}
/** How a closed request ended. */
export function resolutionLabel(request: Pick<AdminUpgradeRequest, "status" | "resolution">): string {
  if (request.status === "open") return "Abierta";
  if (request.status === "dismissed") return "Descartada";
  return request.resolution === "pro_activated" || request.resolution === "pro_extended" ? "Resuelta: se activó Bellis Pro" : "Resuelta sin activar";
}
