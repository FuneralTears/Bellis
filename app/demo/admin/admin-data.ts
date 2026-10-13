import type { AdminEvent, AdminEventName, AdminOverview, AdminWorkspaceDetail, AdminWorkspaceFilters, AdminWorkspaceRow } from "@/lib/admin";

/** Mock data for /demo/admin. Invented consultorios and addresses: nothing here comes from Supabase. */
const day = 86_400_000;
const now = Date.UTC(2026, 9, 12, 15, 0);
/** The demo's "today": fixed, so the invented dates always read the same. */
export const demoNow = new Date(now);
const ago = (days: number, hours = 0) => new Date(now - days * day - hours * 3_600_000).toISOString();
const ahead = (days: number) => new Date(Date.UTC(2026, 9, 12, 3, 0) + days * day).toISOString();
const basic = ["manual_patients", "manual_appointments", "manual_payments", "patient_notes", "public_booking", "external_payment_link"];
const pro = [...basic, "followups", "crm", "smart_followups", "automations", "mercado_pago"];

/** Last sign-in per mock workspace. Lucía signs in but does little; Consultorio Sur registered and never came back. */
const signIns: Record<string, string> = { "demo-1": ago(0, 1), "demo-2": ago(0, 6), "demo-3": ago(1), "demo-4": ago(2), "demo-5": ago(4), "demo-6": ago(47), "demo-7": ago(3) };

type Seed = Partial<AdminWorkspaceRow> & Pick<AdminWorkspaceRow, "workspace_id" | "workspace_name" | "owner_email" | "profession" | "effective_tier">;
function row(seed: Seed): AdminWorkspaceRow {
  const onboarded = seed.onboarding_completed ?? true;
  return { registered_at: ago(40), onboarding_completed: onboarded, onboarding_completed_at: onboarded ? seed.registered_at ?? ago(40) : null, status: "active",
    plan_code: seed.effective_tier === "pro" ? "pro" : "free", trial_started_at: null, trial_ends_at: null, pro_started_at: null, pro_ends_at: null,
    last_sign_in_at: signIns[seed.workspace_id] ?? null, last_activity_at: null, active_7d: false, active_30d: false, events_7d: 0, events_30d: 0, patient_count: 0, appointment_count: 0, public_booking_count: 0,
    followup_count: 0, automation_count: 0, upgrade_request_open: false, upgrade_requested_at: null, payment_provider: "mercado_pago_ar",
    external_link_configured: false, mercado_pago_connected: false, booking_available: false, booking_paused: onboarded, ...seed };
}

export const demoWorkspaces: AdminWorkspaceRow[] = [
  row({ workspace_id: "demo-1", workspace_name: "Consultorio Ana López", owner_email: "ana@ejemplo.com", profession: "Psicología", effective_tier: "pro_trial",
    registered_at: ago(26), trial_started_at: ago(26), trial_ends_at: ahead(4), last_activity_at: ago(0, 3), active_7d: true, active_30d: true, events_7d: 14, events_30d: 52,
    patient_count: 31, appointment_count: 48, public_booking_count: 19, followup_count: 12, automation_count: 2, upgrade_request_open: true, upgrade_requested_at: ago(2, 5),
    mercado_pago_connected: true, booking_available: true, booking_paused: false }),
  row({ workspace_id: "demo-2", workspace_name: "Mateo Silva Odontología", owner_email: "mateo@ejemplo.com", profession: "Odontología", effective_tier: "pro",
    registered_at: ago(74), trial_started_at: ago(74), trial_ends_at: ago(44), pro_started_at: ago(41), pro_ends_at: ahead(19), last_activity_at: ago(1, 2), active_7d: true, active_30d: true,
    events_7d: 22, events_30d: 96, patient_count: 118, appointment_count: 203, public_booking_count: 87, followup_count: 34, automation_count: 3,
    mercado_pago_connected: true, booking_available: true, booking_paused: false }),
  row({ workspace_id: "demo-3", workspace_name: "Paula Ríos Nutrición", owner_email: "paula@ejemplo.com", profession: "Nutrición", effective_tier: "free",
    registered_at: ago(58), trial_started_at: ago(58), trial_ends_at: ago(28), last_activity_at: ago(3), active_7d: true, active_30d: true, events_7d: 5, events_30d: 21,
    patient_count: 44, appointment_count: 61, public_booking_count: 0, upgrade_request_open: true, upgrade_requested_at: ago(6, 1) }),
  row({ workspace_id: "demo-4", workspace_name: "Centro Álamo", owner_email: "hola@ejemplo.com", profession: "Kinesiología", effective_tier: "pro_trial",
    registered_at: ago(9), trial_started_at: ago(9), trial_ends_at: ahead(21), last_activity_at: ago(2), active_7d: true, active_30d: true, events_7d: 8, events_30d: 17,
    patient_count: 12, appointment_count: 15, public_booking_count: 6, followup_count: 2, payment_provider: "external_link", external_link_configured: true,
    booking_available: true, booking_paused: false }),
  row({ workspace_id: "demo-5", workspace_name: "Lucía Benítez", owner_email: "lucia@ejemplo.com", profession: "Fonoaudiología", effective_tier: "pro_trial",
    registered_at: ago(24), trial_started_at: ago(24), trial_ends_at: ahead(6), last_activity_at: ago(15), active_30d: true, events_30d: 4, patient_count: 3, appointment_count: 2 }),
  row({ workspace_id: "demo-6", workspace_name: "Espacio Raíz", owner_email: "contacto@ejemplo.com", profession: "Psicopedagogía", effective_tier: "free",
    registered_at: ago(95), trial_started_at: ago(95), trial_ends_at: ago(65), last_activity_at: ago(47), patient_count: 9, appointment_count: 11, public_booking_count: 4,
    payment_provider: "external_link", external_link_configured: true, booking_available: true, booking_paused: false }),
  row({ workspace_id: "demo-7", workspace_name: "Tomás Ferreyra", owner_email: "tomas@ejemplo.com", profession: "Psiquiatría", effective_tier: "free",
    registered_at: ago(3), onboarding_completed: false }),
  row({ workspace_id: "demo-8", workspace_name: "Consultorio Sur", owner_email: "sur@ejemplo.com", profession: "Terapia ocupacional", effective_tier: "free",
    registered_at: ago(12), onboarding_completed: false }),
];

export const demoOverview: AdminOverview = {
  total_users: demoWorkspaces.length, registrations_last_7d: demoWorkspaces.filter((w) => w.registered_at >= ago(7)).length,
  registrations_last_30d: demoWorkspaces.filter((w) => w.registered_at >= ago(30)).length,
  total_workspaces: demoWorkspaces.length, onboarded_workspaces: demoWorkspaces.filter((w) => w.onboarding_completed).length, suspended_workspaces: 0,
  active_7d: demoWorkspaces.filter((w) => w.active_7d).length, active_30d: demoWorkspaces.filter((w) => w.active_30d).length,
  pro_trial_active: demoWorkspaces.filter((w) => w.effective_tier === "pro_trial").length, pro_active: demoWorkspaces.filter((w) => w.effective_tier === "pro").length,
  free_active: demoWorkspaces.filter((w) => w.effective_tier === "free").length, upgrade_requests_open: demoWorkspaces.filter((w) => w.upgrade_request_open).length,
  trials_expiring_7d: demoWorkspaces.filter((w) => w.effective_tier === "pro_trial" && w.trial_ends_at! < ahead(7)).length,
  workspaces_with_booking_paused: demoWorkspaces.filter((w) => w.booking_paused).length, generated_at: new Date(now).toISOString(),
};

let eventId = 0;
const event = (name: AdminEventName, workspace: AdminWorkspaceRow, at: string, metadata: Record<string, unknown> = {}): AdminEvent =>
  ({ id: ++eventId, event_name: name, metadata, created_at: at, workspace_id: workspace.workspace_id, workspace_name: workspace.workspace_name });
const [ana, mateo, paula, alamo, lucia, , tomas] = demoWorkspaces;
export const demoEvents: AdminEvent[] = [
  event("appointment_created", ana, ago(0, 3), { source: "public" }), event("public_booking_completed", ana, ago(0, 3)),
  event("payment_recorded", ana, ago(0, 3), { provider: "mercado_pago_ar" }), event("appointment_completed", mateo, ago(1, 1)),
  event("patient_note_created", mateo, ago(1, 1)), event("payment_recorded", paula, ago(3), { provider: "offline" }), event("appointment_cancelled", alamo, ago(2, 2)),
  event("patient_created", ana, ago(0, 3), { source: "public" }), event("followup_created", mateo, ago(1, 2), { source: "automation" }),
  event("appointment_created", mateo, ago(1, 4), { source: "manual" }), event("upgrade_requested", ana, ago(2, 5), { plan: "pro" }),
  event("patient_created", alamo, ago(2), { source: "manual" }), event("automation_enabled", ana, ago(2, 8), { rule: "first_consultation" }),
  event("user_registered", tomas, ago(3)), event("appointment_created", paula, ago(3), { source: "manual" }),
  event("upgrade_requested", paula, ago(6, 1), { plan: "pro" }), event("onboarding_completed", alamo, ago(9)), event("trial_started", alamo, ago(9)),
  event("patient_created", lucia, ago(15), { source: "manual" }), event("trial_expired", paula, ago(28)), event("pro_activated", mateo, ago(41)),
].sort((a, b) => b.created_at.localeCompare(a.created_at));

export function demoDetail(id: string): AdminWorkspaceDetail | null {
  const found = demoWorkspaces.find((item) => item.workspace_id === id);
  if (!found) return null;
  const end = found.effective_tier === "pro_trial" ? found.trial_ends_at : found.effective_tier === "pro" ? found.pro_ends_at : null;
  const own = demoEvents.filter((item) => item.workspace_id === id);
  return { ...found, days_remaining: end ? Math.floor((new Date(end).getTime() - 1000 - now) / day) : null,
    capabilities: found.effective_tier === "free" ? basic : pro,
    timeline: own.some((item) => item.event_name === "user_registered") ? own : [...own, event("user_registered", found, found.registered_at)] };
}

/** The same filters and orders the server applies, over the mock rows. */
export function demoFilter(filters: AdminWorkspaceFilters): AdminWorkspaceRow[] {
  const search = filters.search.trim().toLowerCase();
  const rows = demoWorkspaces.filter((item) =>
    (!search || [item.workspace_name, item.owner_email ?? "", item.profession ?? ""].some((value) => value.toLowerCase().includes(search)))
    && (filters.onboarding === "all" || item.onboarding_completed === (filters.onboarding === "complete"))
    && (filters.tier === "all" || item.effective_tier === filters.tier)
    && (filters.active === "all" || (filters.active === "7d" ? item.active_7d : item.active_30d))
    && (!filters.upgradeRequested || item.upgrade_request_open) && (!filters.bookingPaused || item.booking_paused));
  const by: Record<AdminWorkspaceFilters["sort"], (a: AdminWorkspaceRow, b: AdminWorkspaceRow) => number> = {
    newest: (a, b) => b.registered_at.localeCompare(a.registered_at),
    last_activity: (a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""),
    trial_ending: (a, b) => ((a.effective_tier === "pro_trial" ? a.trial_ends_at : null) ?? "9").localeCompare((b.effective_tier === "pro_trial" ? b.trial_ends_at : null) ?? "9"),
    most_active: (a, b) => b.events_30d - a.events_30d,
  };
  return [...rows].sort(by[filters.sort]);
}
