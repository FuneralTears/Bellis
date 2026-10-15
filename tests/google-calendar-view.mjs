import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleCalendarNotEnabledCopy, googleCalendarPanel, showsIntegrations } from "../lib/google-calendar-view.ts";

// The answers of google_calendar_status the panel can receive.
const free = { status: "disconnected", available: false, unavailableReason: "plan_required" };
const proWithoutBeta = { status: "disconnected", available: false, unavailableReason: "not_enabled" };
const connected = { status: "connected", available: true, unavailableReason: null, email: "ana@example.test", calendarLabel: "Turnos Bellis" };
const needsReconnect = { status: "needs_reconnect", available: true, unavailableReason: null, email: "ana@example.test", calendarLabel: "Turnos Bellis" };
const disconnected = { status: "disconnected", available: true, unavailableReason: null };

test("Integraciones: Free sees 'Disponible en Bellis Pro', and the tab", () => {
  assert.equal(googleCalendarPanel(free), "plan_required"); assert.equal(showsIntegrations(free), true);
});

test("Integraciones: Pro or the trial without the beta sees a neutral sentence, never the Pro offer; the tab only by direct link", () => {
  assert.equal(googleCalendarPanel(proWithoutBeta), "not_enabled"); assert.equal(showsIntegrations(proWithoutBeta), false);
  assert.equal(googleCalendarNotEnabledCopy, "Google Calendar todavía no está disponible para tu cuenta.");
  assert.doesNotMatch(googleCalendarNotEnabledCopy, /Pro/);
  // The card keeps the Pro wording and the upgrade action for plan_required only.
  const card = readFileSync(new URL("../components/integrations/GoogleCalendarSettings.tsx", import.meta.url), "utf8");
  const from = card.indexOf('panel === "not_enabled" ?'); const notEnabled = card.slice(from, card.indexOf('panel === "plan_required" ?', from));
  assert.ok(notEnabled.includes("googleCalendarNotEnabledCopy")); assert.doesNotMatch(notEnabled, /Bellis Pro|proAction|ProBadge/);
  assert.match(card, /panel === "plan_required" \? <ProBadge \/>/);
});

test("Integraciones: Pro connected, needing a reconnection, or disconnected with the beta on", () => {
  assert.equal(googleCalendarPanel(connected), "connected"); assert.equal(showsIntegrations(connected), true);
  assert.equal(googleCalendarPanel(needsReconnect), "needs_reconnect"); assert.equal(showsIntegrations(needsReconnect), true);
  assert.equal(googleCalendarPanel(disconnected), "disconnected"); assert.equal(showsIntegrations(disconnected), true);
});

test("Integraciones: a stored connection that is not usable can always be disconnected, whatever the reason", () => {
  for (const reason of ["plan_required", "not_enabled"]) for (const status of ["paused", "connected", "needs_reconnect"]) {
    const state = { status, available: false, unavailableReason: reason, email: "ana@example.test" };
    assert.equal(googleCalendarPanel(state), "stored_unavailable", `${reason} ${status}`); assert.equal(showsIntegrations(state), true);
  }
  const card = readFileSync(new URL("../components/integrations/GoogleCalendarSettings.tsx", import.meta.url), "utf8");
  const stored = card.slice(card.indexOf('panel === "stored_unavailable" ?'), card.indexOf('state.status === "connected" ?'));
  assert.ok(stored.includes("disconnectButton"));
});

test("Integraciones: loading or an unreadable status shows nothing to act on and no tab", () => {
  for (const status of ["loading", "unavailable"]) { const state = { status, available: false, unavailableReason: null }; assert.equal(googleCalendarPanel(state), status); assert.equal(showsIntegrations(state), false); }
});

test("demo: Integraciones offers the states of the product, including Pro without the beta", () => {
  const demo = readFileSync(new URL("../app/demo/page.tsx", import.meta.url), "utf8");
  for (const label of ["No conectado", "Conectado", "Necesita volver a conectar", "Pro sin beta", "Bellis Free"]) assert.ok(demo.includes(`"${label}"`) || demo.includes(`>${label}<`), label);
  assert.match(demo, /label: "Pro sin beta", state: \{ status: "disconnected", available: false, unavailableReason: "not_enabled" \}/);
});
