import test from "node:test";
import assert from "node:assert/strict";
import { detectOpportunities, hasAttention } from "../app/pacientes/opportunities.ts";

const base = {
  completed_turn_count: 0, last_completed_turn: null, pending_payment_count: 0,
  overdue_follow_up_count: 0, without_next_turn: false,
  first_completed_without_next: false, inactive_after_care: false,
  has_pending_payment: false, has_overdue_follow_up: false,
  has_upcoming_turn: false, is_new_patient: false, is_recurrent_patient: false
};

test("prioriza acciones y evita repetir la señal genérica de turno", () => {
  const patient = { ...base, completed_turn_count: 1, without_next_turn: true,
    first_completed_without_next: true, has_pending_payment: true, pending_payment_count: 1,
    has_overdue_follow_up: true, overdue_follow_up_count: 2 };
  assert.deepEqual(detectOpportunities(patient).map((item) => item.kind),
    ["pending_payment", "overdue_follow_up", "first_without_next"]);
  assert.equal(hasAttention(patient), true);
});

test("distingue contexto de atención pendiente", () => {
  const patient = { ...base, has_upcoming_turn: true, is_recurrent_patient: true };
  assert.deepEqual(detectOpportunities(patient).map((item) => item.kind), ["upcoming", "recurrent"]);
  assert.equal(hasAttention(patient), false);
});

test("un turno manual sin cobrar es una oportunidad de pago pendiente, y deja de serlo al cobrarse", () => {
  // The view counts manual turns with no payment in pending_payment_count (see manual_pending_payment_smoke.sql).
  const unpaid = { ...base, has_upcoming_turn: true, has_pending_payment: true, pending_payment_count: 1 };
  const signals = detectOpportunities(unpaid);
  assert.deepEqual(signals.map((item) => item.kind), ["pending_payment", "upcoming"]);
  assert.equal(signals[0].level, "attention");
  assert.equal(signals[0].reason, "1 pago pendiente de cobro o verificación.");
  assert.equal(hasAttention(unpaid), true);
  // Uno manual y uno del booking público: se cuentan los dos, una vez cada uno.
  assert.equal(detectOpportunities({ ...unpaid, pending_payment_count: 2 })[0].reason, "2 pagos pendientes de cobro o verificación.");
  // Cobrado: la señal desaparece y el paciente ya no pide atención por eso.
  const paid = { ...unpaid, has_pending_payment: false, pending_payment_count: 0 };
  assert.deepEqual(detectOpportunities(paid).map((item) => item.kind), ["upcoming"]);
  assert.equal(hasAttention(paid), false);
});
