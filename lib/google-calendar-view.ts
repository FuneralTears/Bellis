import type { GoogleCalendarState } from "./google-calendar";

/**
 * What Perfil → Integraciones shows for Google Calendar, from the server's answer only. No imports beyond a type, so
 * it is tested directly. The panel never works out the plan or the rollout itself.
 *
 *   plan_required        Bellis Free, nothing stored: "Disponible en Bellis Pro" and the way to Pro.
 *   not_enabled          the workspace is not in the beta, nothing stored: a neutral sentence, no upgrade offer.
 *   stored_unavailable   a connection is stored but not usable now (plan or rollout): it can still be disconnected.
 *   connected / needs_reconnect / disconnected   available: the usual states.
 */
export type GoogleCalendarPanel = "loading" | "unavailable" | "plan_required" | "not_enabled" | "stored_unavailable" | "connected" | "needs_reconnect" | "disconnected";

export const googleCalendarNotEnabledCopy = "Google Calendar todavía no está disponible para tu cuenta.";

export function googleCalendarPanel(state: GoogleCalendarState): GoogleCalendarPanel {
  if (state.status === "loading" || state.status === "unavailable") return state.status;
  const stored = state.status === "connected" || state.status === "needs_reconnect" || state.status === "paused";
  if (!state.available) {
    if (stored) return "stored_unavailable";
    return state.unavailableReason === "not_enabled" ? "not_enabled" : "plan_required";
  }
  return state.status === "paused" ? "stored_unavailable" : state.status;
}

/** A stored connection with tokens (connected, or paused because the plan or the rollout changed) is worth checking. */
export function shouldCheckConnection(state: GoogleCalendarState): boolean {
  return state.status === "connected" || state.status === "paused";
}
export const googleCalendarUnverifiedCopy = "No pudimos verificar Google Calendar en este momento.";

/**
 * Whether Perfil shows the Integraciones tab: there is something to connect or to say. A workspace outside the
 * rollout with nothing stored sees nothing at all (a direct link still opens it, with the neutral sentence).
 */
export function showsIntegrations(state: GoogleCalendarState): boolean {
  if (state.status === "loading" || state.status === "unavailable") return false;
  return state.available || state.unavailableReason === "plan_required" || state.status !== "disconnected";
}
