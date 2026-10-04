import { getSupabase } from "@/lib/supabase/browser";
import type { MercadoPagoConnection } from "@/components/payments/PaymentSettings";

/**
 * Browser side of the Mercado Pago connection. It only ever handles the session, a short-lived code
 * on its way to the server, and the connection status. Tokens and the client secret never reach this code.
 */

export type MercadoPagoCompletion = "connected" | "invalid_state" | "error" | "signed_out";

/** Calls the connection function as the signed-in person. Null when there is no session. */
async function connectionRequest(action: "start" | "complete", body?: unknown): Promise<Response | null> {
  const client = await getSupabase();
  const { data } = await client.auth.getSession();
  if (!data.session) return null;
  const settings = await fetch("/api/supabase-config", { cache: "no-store" });
  if (!settings.ok) throw new Error("unavailable");
  const { url, publishableKey } = await settings.json() as { url: string; publishableKey: string };
  return fetch(`${url}/functions/v1/bellis-mp-oauth?action=${action}`, {
    method: "POST", cache: "no-store",
    headers: { apikey: publishableKey, Authorization: `Bearer ${data.session.access_token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Asks the server where to send the person to authorize. The address is built on the server; here it is only checked. */
export async function startMercadoPagoConnection(): Promise<string> {
  const response = await connectionRequest("start");
  if (!response?.ok) throw new Error("start_failed");
  const { authorizationUrl } = await response.json() as { authorizationUrl?: unknown };
  const target = new URL(String(authorizationUrl));
  if (target.protocol !== "https:" || !/^auth\.mercadopago\.com(\.ar)?$/.test(target.hostname)) throw new Error("start_failed");
  return target.toString();
}

/**
 * Hands the code Mercado Pago returned to the server, together with the current Bellis session.
 * The server only accepts it from the same person who started the connection; tokens never come back here.
 */
export async function completeMercadoPagoConnection(code: string, state: string): Promise<MercadoPagoCompletion> {
  const response = await connectionRequest("complete", { code, state });
  if (!response || response.status === 401) return "signed_out";
  if (!response.ok) return "error";
  const { outcome } = await response.json() as { outcome?: string };
  return outcome === "connected" || outcome === "invalid_state" ? outcome : "error";
}

/** What this person may know and do about the workspace's Mercado Pago account. Only the owner connects, disconnects or changes the method. */
export async function mercadoPagoAccess(workspaceId: string): Promise<{ canManage: boolean; connection: MercadoPagoConnection }> {
  try {
    const client = await getSupabase();
    const { data: auth } = await client.auth.getUser();
    const { data: member } = auth.user ? await client.from("workspace_members").select("role")
      .eq("workspace_id", workspaceId).eq("user_id", auth.user.id).maybeSingle() : { data: null };
    const canManage = member?.role === "owner";
    if (!canManage && member?.role !== "admin") return { canManage: false, connection: { status: "restricted" } };
    const { data, error } = await client.rpc("mercado_pago_connection_status", { p_workspace: workspaceId });
    const row = (data as Array<{ status: string; account_hint: string | null; connected_at: string | null; environment: string | null }> | null)?.[0];
    if (error || !row || !["connected", "disconnected", "expired", "error"].includes(row.status)) return { canManage, connection: { status: "unavailable" } };
    return { canManage, connection: { status: row.status as MercadoPagoConnection["status"], accountHint: row.account_hint, connectedAt: row.connected_at, environment: row.environment } };
  } catch {
    return { canManage: false, connection: { status: "unavailable" } };
  }
}

export async function disconnectMercadoPago(workspaceId: string): Promise<void> {
  const client = await getSupabase();
  const { error } = await client.rpc("disconnect_mercado_pago", { p_workspace: workspaceId });
  if (error) throw new Error("disconnect_failed");
}
