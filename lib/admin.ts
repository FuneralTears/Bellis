/**
 * Bellis internal backoffice: the shapes the admin RPCs return and how they are worded on screen.
 * Counts, dates and states only. Nothing here carries patient names, notes, form answers or any clinical text,
 * and nothing here decides access: every RPC checks on the server that the caller is part of the Bellis team.
 * Pure module (no imports at runtime) so the Node tests can load it.
 */

export type AdminRole = "admin" | "support";
export type AdminTier = "free" | "pro_trial" | "pro";

export type AdminOverview = {
  total_users: number; registrations_last_7d: number; registrations_last_30d: number;
  total_workspaces: number; onboarded_workspaces: number; suspended_workspaces: number;
  active_7d: number; active_30d: number;
  pro_trial_active: number; pro_active: number; free_active: number;
  upgrade_requests_open: number; trials_expiring_7d: number; workspaces_with_booking_paused: number;
  generated_at: string;
};

export type AdminWorkspaceRow = {
  workspace_id: string; workspace_name: string; owner_email: string | null; profession: string | null; registered_at: string;
  onboarding_completed: boolean; onboarding_completed_at: string | null; status: "active" | "suspended"; plan_code: "free" | "pro"; effective_tier: AdminTier;
  trial_started_at: string | null; trial_ends_at: string | null; pro_started_at: string | null; pro_ends_at: string | null;
  /** The most recent sign-in among everyone in the workspace, not only its owner ("Último acceso del equipo"). Authentication only: it says nothing about using the product. */
  last_sign_in_at: string | null;
  /** The last product action (a patient, an appointment, a payment, a note…). Signing in is not one. */
  last_activity_at: string | null; active_7d: boolean; active_30d: boolean; events_7d: number; events_30d: number;
  patient_count: number; appointment_count: number; public_booking_count: number; followup_count: number; automation_count: number;
  upgrade_request_open: boolean; upgrade_requested_at: string | null;
  payment_provider: string; external_link_configured: boolean; mercado_pago_connected: boolean; booking_available: boolean; booking_paused: boolean;
};

export type AdminEventName = "user_registered" | "onboarding_completed" | "patient_created" | "appointment_created" | "public_booking_completed"
  | "followup_created" | "automation_enabled" | "payment_recorded" | "appointment_completed" | "appointment_cancelled" | "patient_note_created" | "trial_started" | "trial_expired" | "upgrade_requested" | "pro_activated" | "pro_expired" | "workspace_suspended";
export type AdminEvent = { id: number; event_name: AdminEventName; entity_type?: string | null; metadata: Record<string, unknown>; created_at: string;
  workspace_id?: string | null; workspace_name?: string | null };

export type AdminWorkspaceDetail = AdminWorkspaceRow & { days_remaining: number | null; capabilities: string[]; timeline: AdminEvent[] };
export type AdminWorkspacePage = { total: number; limit: number; offset: number; rows: AdminWorkspaceRow[] };

/** What "Usuarios" has selected. "all" means the filter is off. */
export type AdminWorkspaceFilters = {
  search: string; onboarding: "all" | "complete" | "incomplete"; tier: "all" | AdminTier; active: "all" | "7d" | "30d";
  upgradeRequested: boolean; bookingPaused: boolean; sort: "newest" | "last_activity" | "trial_ending" | "most_active";
};
export const defaultWorkspaceFilters: AdminWorkspaceFilters = { search: "", onboarding: "all", tier: "all", active: "all", upgradeRequested: false, bookingPaused: false, sort: "newest" };
export const adminPageSize = 25;

/** The arguments of public.admin_workspaces for a set of filters and a page (0 is the first). */
export function workspaceQuery(filters: AdminWorkspaceFilters, page = 0, pageSize = adminPageSize) {
  const search = filters.search.trim();
  return {
    p_search: search || null,
    p_onboarding: filters.onboarding === "all" ? null : filters.onboarding,
    p_tier: filters.tier === "all" ? null : filters.tier,
    p_active: filters.active === "all" ? null : filters.active,
    p_upgrade_requested: filters.upgradeRequested, p_booking_paused: filters.bookingPaused,
    p_sort: filters.sort, p_limit: pageSize, p_offset: Math.max(0, page) * pageSize,
  };
}
/** How many filters are narrowing the list, not counting the order. */
export function activeFilterCount(filters: AdminWorkspaceFilters): number {
  return [filters.search.trim() !== "", filters.onboarding !== "all", filters.tier !== "all", filters.active !== "all", filters.upgradeRequested, filters.bookingPaused].filter(Boolean).length;
}
export function pageCount(total: number, pageSize = adminPageSize): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export const tierLabels: Record<AdminTier, string> = { free: "Free", pro_trial: "Prueba Pro", pro: "Pro" };
export const sortLabels: Record<AdminWorkspaceFilters["sort"], string> = {
  newest: "Más nuevos", last_activity: "Última actividad", trial_ending: "Prueba por vencer", most_active: "Más activos" };
export const paymentProviderLabels: Record<string, string> = { mercado_pago_ar: "Mercado Pago", external_link: "Link de pago externo" };
export const capabilityLabels: Record<string, string> = {
  manual_patients: "Pacientes", manual_appointments: "Turnos manuales", manual_payments: "Cobros manuales", patient_notes: "Notas",
  public_booking: "Página pública", external_payment_link: "Link de pago externo", followups: "Seguimientos", crm: "CRM",
  smart_followups: "Sugerencias de seguimiento", automations: "Automatizaciones", mercado_pago: "Mercado Pago integrado" };
/** The capabilities that exist as product today, in the order they are shown. The reserved ones are left out. */
export function shownCapabilities(capabilities: readonly string[]): string[] {
  return Object.keys(capabilityLabels).filter((key) => capabilities.includes(key)).map((key) => capabilityLabels[key]);
}

const eventLabels: Record<AdminEventName, string> = {
  user_registered: "Se registró", onboarding_completed: "Completó el onboarding", patient_created: "Paciente nuevo",
  appointment_created: "Turno nuevo", public_booking_completed: "Reserva pública completada", followup_created: "Seguimiento nuevo",
  automation_enabled: "Activó una automatización", payment_recorded: "Cobro registrado", appointment_completed: "Turno atendido",
  appointment_cancelled: "Turno cancelado", patient_note_created: "Nota de paciente nueva", trial_started: "Empezó la prueba de Bellis Pro", trial_expired: "Venció la prueba de Bellis Pro",
  upgrade_requested: "Pidió Bellis Pro", pro_activated: "Bellis Pro activado", pro_expired: "Venció Bellis Pro", workspace_suspended: "Cuenta suspendida" };
const sourceLabels: Record<string, Partial<Record<AdminEventName, string>>> = {
  manual: { patient_created: "cargado a mano", appointment_created: "cargado a mano", followup_created: "creado a mano" },
  public: { patient_created: "desde la página pública", appointment_created: "desde la página pública" },
  automation: { followup_created: "creado por una automatización" },
};
const providerLabels: Record<string, string> = { offline: "cargado a mano", mercado_pago_ar: "por Mercado Pago", external_link: "por link de pago" };
/**
 * One line for an event. Only the event and where it came from: an event never carries who the patient is,
 * what a note says or how much was paid.
 */
export function eventLabel(event: Pick<AdminEvent, "event_name" | "metadata">): string {
  const base = eventLabels[event.event_name] ?? "Evento";
  const source = typeof event.metadata?.source === "string" ? sourceLabels[event.metadata.source]?.[event.event_name] : undefined;
  const provider = event.event_name === "payment_recorded" && typeof event.metadata?.provider === "string" ? providerLabels[event.metadata.provider] : undefined;
  const detail = source ?? provider;
  return detail ? `${base}, ${detail}` : base;
}
/** Usage, plan or account: how the timeline tints each event. */
export function eventKind(name: AdminEventName): "usage" | "plan" | "account" {
  if (["trial_started", "trial_expired", "upgrade_requested", "pro_activated", "pro_expired"].includes(name)) return "plan";
  if (["user_registered", "workspace_suspended"].includes(name)) return "account";
  return "usage";
}

const zone = "America/Argentina/Buenos_Aires";
function parts(value: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("es-AR", { timeZone: zone, ...options }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
}
/** 05/11/2026, in Argentina time. */
export function adminDate(value: string | null | undefined): string {
  if (!value) return "—";
  const p = parts(value, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.day.padStart(2, "0")}/${p.month.padStart(2, "0")}/${p.year}`;
}
/** 05/11/2026 14:30, in Argentina time. */
export function adminDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const p = parts(value, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${adminDate(value)} ${p.hour.padStart(2, "0")}:${p.minute.padStart(2, "0")}`;
}
/** The last day a plan is valid: the end is the first instant it no longer is. */
export function lastValidDay(endsAt: string | null | undefined): string {
  return endsAt ? adminDate(new Date(new Date(endsAt).getTime() - 1000).toISOString()) : "—";
}
/** "hoy", "ayer", "hace 5 días": how long ago something happened, by whole days elapsed. */
export function daysAgo(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "Sin actividad";
  const days = Math.floor((now.getTime() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return "hoy";
  return days === 1 ? "ayer" : `hace ${days} días`;
}

/** When someone of the workspace last signed in. Not the same as using the product: see activityLine. */
export function signInLine(value: string | null | undefined, now: Date = new Date()): string {
  return value ? `${adminDate(value)} (${daysAgo(value, now)})` : "Sin ingresos todavía";
}
/** When the workspace last did something in the product. */
export function activityLine(value: string | null | undefined, now: Date = new Date()): string {
  return value ? `${adminDate(value)} (${daysAgo(value, now)})` : "Sin actividad todavía";
}

/** The plan of a workspace in one line, the way the list shows it. */
export function planLine(row: Pick<AdminWorkspaceRow, "effective_tier" | "trial_ends_at" | "pro_ends_at" | "status">): string {
  if (row.status === "suspended") return "Suspendida";
  if (row.effective_tier === "pro_trial") return `Prueba hasta el ${lastValidDay(row.trial_ends_at)}`;
  if (row.effective_tier === "pro") return row.pro_ends_at ? `Pro hasta el ${lastValidDay(row.pro_ends_at)}` : "Pro sin vencimiento";
  return row.trial_ends_at ? `Prueba vencida el ${lastValidDay(row.trial_ends_at)}` : "Sin prueba todavía";
}
/** "Último día", "Queda 1 día", "Quedan 12 días". Null when the plan has no end. */
export function daysRemainingLabel(days: number | null | undefined): string | null {
  if (days === null || days === undefined) return null;
  if (days <= 0) return "Último día";
  return days === 1 ? "Queda 1 día" : `Quedan ${days} días`;
}
/** Whether patients can book online today, and why not when they cannot. */
export function bookingLine(row: Pick<AdminWorkspaceRow, "onboarding_completed" | "status" | "booking_available" | "payment_provider" | "mercado_pago_connected" | "external_link_configured" | "effective_tier">): string {
  if (!row.onboarding_completed) return "Sin página pública: no terminó el onboarding";
  if (row.status === "suspended") return "Cuenta suspendida";
  if (row.booking_available) return "Reservas online disponibles";
  if (row.payment_provider === "mercado_pago_ar") {
    if (row.effective_tier === "free") return "En pausa: Mercado Pago es parte de Bellis Pro";
    if (!row.mercado_pago_connected) return "En pausa: Mercado Pago sin conectar";
  }
  if (row.payment_provider === "external_link" && !row.external_link_configured) return "En pausa: falta el link de pago";
  return "En pausa";
}
/** A share as a whole percentage, or "—" when there is nothing to divide by. */
export function share(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "—";
}
/** What an admin RPC failure means for the screen: no access (shown as "not found") or a real error. */
export function isAdminDenied(error: { message?: string; code?: string } | null | undefined): boolean {
  return !!error && (error.message === "not_found" || error.code === "P0002" || error.code === "42501" || error.code === "PGRST301");
}
