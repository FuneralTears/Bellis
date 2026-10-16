import { getSupabase } from "@/lib/supabase/browser";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { formatDate, formatDateTime, formatMoney, type MarketConfig } from "@/lib/market";
import type { WorkspaceAccess } from "@/lib/entitlements";

export type PatientStatus = "new" | "active" | "follow_up" | "inactive";
export const statusLabels: Record<PatientStatus, string> = { new: "Nuevo", active: "Activo", follow_up: "En seguimiento", inactive: "Inactivo" };
/** `access` is what the plan includes, as the server resolved it. Null when it could not be read: nothing of Bellis Pro is offered then. */
export type CrmContext = { workspaceId: string; professionalId: string; professionalName: string; specialty: string; market: MarketConfig; access: WorkspaceAccess | null };
export type PatientOverview = { id: string; workspace_id: string; first_name: string; last_name: string; full_name: string; /** Null for a patient loaded by hand without one. */ email: string | null; phone: string | null; date_of_birth: string | null; status: PatientStatus; created_at: string; last_turn: string | null; next_turn: string | null; turn_count: number; approved_total_minor: number; currency_code: string; follow_up_due_date: string | null };

export async function loadCrmContext(): Promise<CrmContext> {
  const client = await getSupabase();
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) throw new Error("Tu sesión venció. Volvé a ingresar.");
  if (await landingRouteForUser(client, auth.user.id) !== "/dashboard") throw new Error("onboarding_required");
  const { data: professional, error: profileError } = await client.from("professionals")
    .select("id,workspace_id,display_name,specialty").eq("user_id", auth.user.id).limit(1).maybeSingle();
  if (profileError || !professional) throw new Error("No encontramos tu espacio profesional.");
  const [{ data: workspace, error: workspaceError }, access] = await Promise.all([
    client.from("workspaces").select("timezone,currency_code,locale,payment_provider").eq("id", professional.workspace_id).single(),
    loadWorkspaceAccess(professional.workspace_id)]);
  if (workspaceError || !workspace) throw new Error("No pudimos cargar tu espacio.");
  return { access, workspaceId: professional.workspace_id, professionalId: professional.id, professionalName: professional.display_name, specialty: professional.specialty,
    market: { country: "AR", currency: workspace.currency_code.trim(), timezone: workspace.timezone, locale: workspace.locale, paymentProvider: workspace.payment_provider } };
}

/** The plan of the workspace, resolved by the server. One call per screen; a failure reads as "nothing of Bellis Pro". */
export async function loadWorkspaceAccess(workspaceId: string): Promise<WorkspaceAccess | null> {
  const client = await getSupabase();
  // One more try before giving up: a plan read as "unknown" shows the workspace as if it had nothing of Bellis Pro.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await client.rpc("workspace_access", { p_workspace: workspaceId });
    if (!error && data) return data as WorkspaceAccess;
  }
  return null;
}

export function crmDate(value: string | null, market: MarketConfig): string {
  return value ? formatDateTime(value, market) : "—";
}
export function crmMoney(minor: number, market: MarketConfig): string {
  return formatMoney(minor / 100, market);
}
export function crmBirthDate(value: string | null, market: MarketConfig): string {
  return value ? formatDate(value, market) : "No informada";
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No pudimos cargar los datos. Intentá nuevamente.";
}

export async function fetchPages<T>(load: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await load(from, from + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 500) return rows;
  }
}
