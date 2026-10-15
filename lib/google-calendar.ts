import { getSupabase } from "@/lib/supabase/browser";

/**
 * Browser side of the Google Calendar connection. It only ever handles the session, a short-lived code on its way
 * to the server, and the connection status. Tokens, the calendar id and the client secret never reach this code.
 */

export type GoogleCalendarCompletion = "connected" | "cancelled" | "invalid_state" | "error" | "signed_out" | "plan_required" | "not_enabled" | "scopes_missing";
/**
 * What the panel knows, as the server answers it (google_calendar_status). `available` is the server's whole rule
 * (plan and rollout); `unavailableReason` only picks the wording. `loading` and `unavailable` are the panel's own.
 */
export type GoogleCalendarState = {
  status: "loading" | "unavailable" | "connected" | "needs_reconnect" | "paused" | "disconnected";
  available: boolean;
  unavailableReason: "not_enabled" | "plan_required" | "no_professional" | null;
  email?: string | null; calendarLabel?: string | null; connectedAt?: string | null; lastRefreshAt?: string | null; lastErrorCode?: string | null;
};
export const googleCalendarLoading: GoogleCalendarState = { status: "loading", available: false, unavailableReason: null };

/** Calls the connection function as the signed-in person. Null when there is no session. */
async function connectionRequest(action: "start" | "complete" | "disconnect" | "check", body?: unknown): Promise<Response | null> {
  const client = await getSupabase();
  const { data } = await client.auth.getSession();
  if (!data.session) return null;
  const settings = await fetch("/api/supabase-config", { cache: "no-store" });
  if (!settings.ok) throw new Error("unavailable");
  const { url, publishableKey } = await settings.json() as { url: string; publishableKey: string };
  return fetch(`${url}/functions/v1/bellis-google-oauth?action=${action}`, {
    method: "POST", cache: "no-store",
    headers: { apikey: publishableKey, Authorization: `Bearer ${data.session.access_token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Asks the server where to send the person to authorize. The address is built on the server; here it is only checked. */
export async function startGoogleCalendarConnection(): Promise<string> {
  const response = await connectionRequest("start");
  if (response?.status === 403) {
    const code = (await response.clone().json().catch(() => null) as { code?: string } | null)?.code;
    if (code === "plan_required" || code === "not_enabled") throw new Error(code);
  }
  if (!response?.ok) throw new Error("start_failed");
  const { authorizationUrl } = await response.json() as { authorizationUrl?: unknown };
  const target = new URL(String(authorizationUrl));
  if (target.protocol !== "https:" || target.hostname !== "accounts.google.com") throw new Error("start_failed");
  return target.toString();
}

/** Hands the code Google returned to the server, with the current Bellis session. Tokens never come back here. */
export async function completeGoogleCalendarConnection(code: string, state: string): Promise<GoogleCalendarCompletion> {
  const response = await connectionRequest("complete", { code, state });
  if (!response || response.status === 401) return "signed_out";
  if (!response.ok) return "error";
  const { outcome } = await response.json() as { outcome?: string };
  return outcome === "connected" || outcome === "invalid_state" || outcome === "plan_required" || outcome === "not_enabled" || outcome === "scopes_missing" ? outcome : "error";
}

export type GoogleCalendarCheck = "connected" | "needs_reconnect" | "unverified" | "not_connected";
/**
 * Asks the server whether the stored connection still works (one cheap read at Google). Only "needs_reconnect" means
 * something changed; anything that is not a clear answer (no session, a network error, a refusal) is "unverified".
 */
export async function checkGoogleCalendarConnection(): Promise<GoogleCalendarCheck> {
  try {
    const response = await connectionRequest("check");
    if (!response?.ok) return "unverified";
    const { outcome } = await response.json() as { outcome?: string };
    return outcome === "connected" || outcome === "needs_reconnect" || outcome === "not_connected" ? outcome : "unverified";
  } catch {
    return "unverified";
  }
}

export async function disconnectGoogleCalendar(): Promise<void> {
  const response = await connectionRequest("disconnect");
  if (!response?.ok) throw new Error("disconnect_failed");
}

const statuses = ["connected", "needs_reconnect", "paused", "disconnected"] as const;
const reasons = ["not_enabled", "plan_required", "no_professional"] as const;
export async function googleCalendarStatus(workspaceId: string): Promise<GoogleCalendarState> {
  try {
    const client = await getSupabase();
    const { data, error } = await client.rpc("google_calendar_status", { p_workspace: workspaceId });
    const row = (data as Array<{ available: boolean; unavailable_reason: string | null; status: string; email: string | null; calendar_label: string | null;
      connected_at: string | null; last_refresh_at: string | null; last_error_code: string | null }> | null)?.[0];
    if (error || !row || !(statuses as readonly string[]).includes(row.status)) return { status: "unavailable", available: false, unavailableReason: null };
    return { status: row.status as GoogleCalendarState["status"], available: row.available === true,
      unavailableReason: (reasons as readonly string[]).includes(row.unavailable_reason ?? "") ? row.unavailable_reason as GoogleCalendarState["unavailableReason"] : null,
      email: row.email, calendarLabel: row.calendar_label, connectedAt: row.connected_at, lastRefreshAt: row.last_refresh_at, lastErrorCode: row.last_error_code };
  } catch {
    return { status: "unavailable", available: false, unavailableReason: null };
  }
}

export { showsIntegrations } from "./google-calendar-view";
