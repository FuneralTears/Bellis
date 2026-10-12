import test from "node:test";
import assert from "node:assert/strict";
import { patientMessage } from "../supabase/functions/_shared/payment-errors.ts";
import { completeOAuth, sha256Hex } from "../supabase/functions/_shared/mercado-pago-oauth.ts";

test("reserva online no disponible: una sola frase para el paciente, sin motivo ni planes", () => {
  const text = patientMessage("booking_online_unavailable");
  assert.equal(text, "Las reservas online no están disponibles por el momento. Para pedir un turno, comunicate directamente con el consultorio.");
  assert.doesNotMatch(text, /pro\b|mercado pago|plan|prueba|trial|error|no pudimos/i);
});

test("conexión de Mercado Pago que vuelve cuando el plan ya no la incluye: no se guarda nada y no es un error genérico", async () => {
  const config = { clientId: "client-1", clientSecret: "secret-1", redirectUri: "https://bellis.example/mercado-pago/callback", testToken: false };
  const state = "a".repeat(64);
  const saved = [];
  const reported = [];
  const store = {
    consumeState: async (hash, userId) => hash === await sha256Hex(state) && userId === "user-a" ? "ws-a" : null,
    // The database refuses to save a connection for a workspace without Bellis Pro.
    saveConnection: async () => { throw new Error("pro_access_required"); },
  };
  const tokens = async () => new Response(JSON.stringify({ access_token: "APP_USR-token-123456", refresh_token: "TG-refresh-123456", expires_in: 21600, user_id: 99912345 }), { status: 200, headers: { "content-type": "application/json" } });
  const outcome = await completeOAuth(store, config, { userId: "user-a", code: "TG-code", state }, { now: () => Date.parse("2026-10-04T12:00:00Z"), fetch: tokens, report: (value) => reported.push(value) });
  assert.equal(outcome, "plan_required");
  assert.deepEqual(saved, []);
  assert.deepEqual(reported, []);
});
