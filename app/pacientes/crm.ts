import { getSupabase } from "@/lib/supabase/browser";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { formatDate, formatDateTime, formatMoney, type MarketConfig } from "@/lib/market";

export type PatientStatus = "new" | "active" | "follow_up" | "inactive";
export const statusLabels: Record<PatientStatus, string> = { new: "Nuevo", active: "Activo", follow_up: "Seguimiento", inactive: "Inactivo" };
export type CrmContext = { workspaceId: string; professionalName: string; specialty: string; market: MarketConfig };
export type PatientOverview = { id: string; workspace_id: string; first_name: string; last_name: string; full_name: string; email: string; phone: string | null; date_of_birth: string | null; status: PatientStatus; created_at: string; last_turn: string | null; next_turn: string | null; turn_count: number; approved_total_minor: number; currency_code: string };

export async function loadCrmContext(): Promise<CrmContext> {
  const client = await getSupabase();
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) throw new Error("Tu sesión venció. Volvé a ingresar.");
  if (await landingRouteForUser(client, auth.user.id) === "/onboarding") throw new Error("onboarding_required");
  const { data: professional, error: profileError } = await client.from("professionals")
    .select("workspace_id,display_name,specialty").eq("user_id", auth.user.id).limit(1).maybeSingle();
  if (profileError || !professional) throw new Error("No encontramos tu espacio profesional.");
  const { data: workspace, error: workspaceError } = await client.from("workspaces")
    .select("timezone,currency_code,locale,payment_provider").eq("id", professional.workspace_id).single();
  if (workspaceError || !workspace) throw new Error("No pudimos cargar tu espacio.");
  return { workspaceId: professional.workspace_id, professionalName: professional.display_name, specialty: professional.specialty,
    market: { country: "AR", currency: workspace.currency_code.trim(), timezone: workspace.timezone, locale: workspace.locale, paymentProvider: workspace.payment_provider } };
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
