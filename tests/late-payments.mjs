import test from "node:test";
import assert from "node:assert/strict";
import { isLatePayment, latePayments, latePaymentLabel } from "../lib/late-payments.ts";
import { buildPatientTimeline } from "../app/pacientes/timeline.ts";

const intent = (id, status) => ({ id, status, service_id: "s1", professional_id: "pr1", patient_id: "pa1", created_at: "2026-10-01T10:00:00Z" });
const payment = (id, status, extra = {}) => ({ id: `p-${id}`, booking_intent_id: id, provider: "mercado_pago_ar", status, amount_minor: 2500000, currency_code: "ARS", created_at: "2026-10-01T10:01:00Z", approved_at: status === "approved" ? "2026-10-04T12:00:00Z" : null, ...extra });

test("pago tardío: solo un pago aprobado sobre una solicitud cancelada", () => {
  assert.equal(latePaymentLabel, "Pago recibido fuera de término");
  assert.equal(isLatePayment(payment("i1", "approved"), intent("i1", "cancelled")), true);
  // Paid in time, at any later step of the booking: never late.
  for (const status of ["awaiting_schedule", "payment_confirmed", "scheduled", "completed"])
    assert.equal(isLatePayment(payment("i1", "approved"), intent("i1", status)), false, status);
  // A closed request without an approved payment is just a closed request.
  for (const status of ["expired", "pending", "rejected", "cancelled", "refunded"])
    assert.equal(isLatePayment(payment("i1", status), intent("i1", "cancelled")), false, status);
  // Refunded from Mercado Pago: both move to refunded and it stops waiting for review.
  assert.equal(isLatePayment(payment("i1", "refunded"), intent("i1", "refunded")), false);
  assert.equal(isLatePayment(payment("i1", "approved"), undefined), false);
  assert.equal(isLatePayment(payment("i1", "approved", { provider: "external_link" }), intent("i1", "cancelled")), false);
});

test("pago tardío: un cobro registrado por el consultorio nunca lo es, ni un pago sin proveedor", () => {
  const cancelled = intent("i1", "cancelled");
  // Cobro offline de un turno manual que después se canceló: plata recibida en mano, no un pago fuera de término.
  for (const method of ["cash", "transfer", "other"])
    assert.equal(isLatePayment(payment("i1", "approved", { provider: "offline", method }), cancelled), false, method);
  // Sin proveedor cargado no se asume Mercado Pago.
  for (const provider of [undefined, null, "", "otro"])
    assert.equal(isLatePayment(payment("i1", "approved", { provider }), cancelled), false, String(provider));
  assert.equal(isLatePayment({ booking_intent_id: "i1", status: "approved" }, cancelled), false);
  // Solo Mercado Pago.
  assert.equal(isLatePayment(payment("i1", "approved", { provider: "mercado_pago_ar" }), cancelled), true);
  const mixed = latePayments([intent("a", "cancelled"), intent("b", "cancelled"), intent("c", "cancelled")],
    [payment("a", "approved", { provider: "offline", method: "cash" }), payment("b", "approved"), payment("c", "approved", { provider: undefined })]);
  assert.deepEqual(mixed.map((item) => item.intent.id), ["b"]);
});

test("pago tardío: la lista del panel trae cada pago con su solicitud, el más reciente primero, y nada más", () => {
  const intents = [intent("a", "cancelled"), intent("b", "scheduled"), intent("c", "cancelled"), intent("d", "cancelled"), intent("e", "pending_payment")];
  const payments = [payment("a", "approved", { approved_at: "2026-10-03T12:00:00Z" }), payment("b", "approved"), payment("c", "expired"),
    payment("d", "approved", { approved_at: "2026-10-05T12:00:00Z" }), payment("e", "pending"), payment("missing", "approved")];
  const late = latePayments(intents, payments);
  assert.deepEqual(late.map((item) => item.intent.id), ["d", "a"]);
  assert.equal(late[0].payment.id, "p-d");
  assert.deepEqual(latePayments([], payments), []);
});

test("pago tardío: la ficha del paciente lo nombra fuera de término y no lo presenta como un turno", () => {
  const base = { patientCreatedAt: "2026-09-01T10:00:00Z", appointments: [], notes: [], activities: [], followUps: [],
    services: new Map([["s1", "Consulta"]]), professionals: new Map(), money: (minor, currency) => `${currency} ${minor / 100}`, isLatePayment };
  const lateEvent = buildPatientTimeline({ ...base, intents: [intent("i1", "cancelled")], payments: [payment("i1", "approved")] }).find((event) => event.kind === "payment");
  assert.equal(lateEvent.title, "Pago recibido fuera de término");
  assert.match(lateEvent.description, /sin turno/);
  assert.equal(lateEvent.at, "2026-10-04T12:00:00Z");
  const events = buildPatientTimeline({ ...base, intents: [intent("i1", "cancelled")], payments: [payment("i1", "approved")] });
  assert.equal(events.some((event) => event.kind === "appointment"), false);
  // A payment in time keeps its usual wording, with or without the request status loaded.
  for (const status of ["scheduled", undefined]) {
    const paid = buildPatientTimeline({ ...base, intents: [intent("i1", status)], payments: [payment("i1", "approved")] }).find((event) => event.kind === "payment");
    assert.equal(paid.title, "Pago recibido");
    assert.doesNotMatch(paid.description, /sin turno/);
  }
});

test("pago tardío: en la ficha, un cobro offline de un turno cancelado se nombra como un pago recibido común", () => {
  const base = { patientCreatedAt: "2026-09-01T10:00:00Z", appointments: [], notes: [], activities: [], followUps: [],
    services: new Map([["s1", "Consulta"]]), professionals: new Map(), money: (minor, currency) => `${currency} ${minor / 100}`, isLatePayment };
  const offline = buildPatientTimeline({ ...base, intents: [intent("i1", "cancelled")], payments: [payment("i1", "approved", { provider: "offline", method: "cash" })] }).find((event) => event.kind === "payment");
  assert.equal(offline.title, "Pago recibido");
  assert.doesNotMatch(offline.description, /sin turno/);
  // Sin la regla de pago tardío, ningún pago se nombra fuera de término.
  const withoutRule = { ...base, isLatePayment: undefined };
  const plain = buildPatientTimeline({ ...withoutRule, intents: [intent("i1", "cancelled")], payments: [payment("i1", "approved")] }).find((event) => event.kind === "payment");
  assert.equal(plain.title, "Pago recibido");
});
