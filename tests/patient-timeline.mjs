import test from "node:test";
import assert from "node:assert/strict";
import { buildPatientTimeline, followUpBucket, todayInTimezone } from "../app/pacientes/timeline.ts";

test("combina registros reales sin duplicar el pago y ordena por fecha", () => {
  const events = buildPatientTimeline({
    patientCreatedAt: "2026-09-01T10:00:00Z",
    appointments: [{ id: "a1", booking_intent_id: "i1", professional_id: "pr1", starts_at: "2026-09-28T13:00:00Z", created_at: "2026-09-25T12:00:00Z", status_changed_at: "2026-09-28T14:00:00Z", status: "completed" }],
    intents: [{ id: "i1", service_id: "s1", professional_id: "pr1", created_at: "2026-09-25T12:00:00Z" }],
    payments: [{ id: "p1", booking_intent_id: "i1", amount_minor: 2500000, currency_code: "ARS", status: "approved", created_at: "2026-09-25T12:01:00Z", approved_at: "2026-09-25T12:02:00Z" }],
    notes: [{ id: "n1", author_id: "u1", content: "Consultar evolución", created_at: "2026-09-28T15:00:00Z", updated_at: "2026-09-28T15:00:00Z" }],
    activities: [{ id: "ac1", professional_id: "pr1", type: "whatsapp", title: "Contacto", description: "Mensaje enviado", created_by: "u1", created_at: "2026-09-29T13:00:00Z" }],
    followUps: [{ id: "f1", patient_id: "pt1", professional_id: "pr1", title: "Consultar", description: "", due_date: "2026-10-05", due_time: null, priority: "high", status: "completed", completed_at: "2026-09-29T14:00:00Z", cancelled_at: null, created_by: "u1", created_at: "2026-09-28T16:00:00Z", updated_at: "2026-09-29T14:00:00Z" }],
    services: new Map([["s1", "Consulta psicológica"]]), professionals: new Map([["pr1", "Ana López"], ["u1", "Ana López"]]),
    money: (amount) => `$${amount / 100} ARS`
  });
  assert.deepEqual(events.map((event) => event.title), [
    "Seguimiento completado", "WhatsApp registrado", "Seguimiento creado", "Nota agregada",
    "Turno completado", "Pago recibido", "Turno reservado", "Paciente creado"
  ]);
  assert.equal(events.filter((event) => event.title === "Pago recibido").length, 1);
  assert.equal(events.find((event) => event.title === "Turno completado")?.actor, "Ana López");
});

test("clasifica seguimientos con fecha local argentina", () => {
  const today = todayInTimezone("America/Argentina/Buenos_Aires", new Date("2026-09-29T02:00:00Z"));
  assert.equal(today, "2026-09-28");
  assert.equal(followUpBucket(null, today), "none");
  assert.equal(followUpBucket("2026-09-27", today), "overdue");
  assert.equal(followUpBucket("2026-09-28", today), "today");
  assert.equal(followUpBucket("2026-09-29", today), "upcoming");
});
