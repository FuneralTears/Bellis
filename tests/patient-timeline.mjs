import test from "node:test";
import assert from "node:assert/strict";
import { buildPatientTimeline, followUpBucket, todayInTimezone } from "../app/pacientes/timeline.ts";

test("combina registros reales sin duplicar el pago y ordena por fecha", () => {
  const events = buildPatientTimeline({
    patientCreatedAt: "2026-09-01T10:00:00Z",
    appointments: [{ id: "a1", booking_intent_id: "i1", professional_id: "pr1", starts_at: "2026-09-28T13:00:00Z", created_at: "2026-09-25T12:00:00Z", status_changed_at: "2026-09-28T14:00:00Z", status: "completed" }],
    intents: [{ id: "i1", service_id: "s1", professional_id: "pr1", created_at: "2026-09-25T12:00:00Z" }],
    payments: [{ id: "p1", booking_intent_id: "i1", amount_minor: 2500000, currency_code: "ARS", status: "approved", created_at: "2026-09-25T12:01:00Z", approved_at: "2026-09-25T12:02:00Z" }],
    notes: [{ id: "n1", author_id: "u1", content: "Consultar evolución", note_type: "follow_up", created_at: "2026-09-28T15:00:00Z", updated_at: "2026-09-28T15:00:00Z" }],
    activities: [{ id: "ac1", professional_id: "pr1", type: "whatsapp", title: "Contacto", description: "Mensaje enviado", created_by: "u1", created_at: "2026-09-29T13:00:00Z" }],
    followUps: [{ id: "f1", patient_id: "pt1", professional_id: "pr1", title: "Consultar", description: "", due_date: "2026-10-05", due_time: null, priority: "high", status: "completed", completed_at: "2026-09-29T14:00:00Z", cancelled_at: null, created_by: "u1", created_at: "2026-09-28T16:00:00Z", updated_at: "2026-09-29T14:00:00Z" }],
    services: new Map([["s1", "Consulta psicológica"]]), professionals: new Map([["pr1", "Ana López"], ["u1", "Ana López"]]),
    money: (amount) => `$${amount / 100} ARS`
  });
  assert.deepEqual(events.map((event) => event.title), [
    "Seguimiento completado", "WhatsApp registrado", "Seguimiento creado", "Nota agregada · Seguimiento",
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

const noteTimeline = (notes) => buildPatientTimeline({
  patientCreatedAt: "2026-09-01T10:00:00Z", appointments: [], intents: [], payments: [], notes, activities: [], followUps: [],
  services: new Map(), professionals: new Map([["u1", "Ana López"]]), money: () => ""
}).filter((event) => event.kind === "note");
const note = (id, note_type, content, created_at) => ({ id, author_id: "u1", content, note_type, created_at, updated_at: created_at });

test("cada nota aparece una sola vez en el historial, con su tipo y su autor", () => {
  const events = noteTimeline([
    note("n1", "payment", "Paga por transferencia.", "2026-10-02T12:00:00Z"),
    note("n2", "administrative", "Pidió factura.", "2026-10-03T12:00:00Z"),
    note("n3", "general", "Prefiere la tarde.", "2026-10-01T12:00:00Z"),
  ]);
  assert.deepEqual(events.map((event) => event.title), ["Nota agregada · Administrativa", "Nota agregada · Pago", "Nota agregada · General"]);
  assert.deepEqual(events.map((event) => event.id), ["note-n2", "note-n1", "note-n3"]);
  assert.ok(events.every((event) => event.actor === "Ana López"));
});

test("el historial resume las notas largas y deja intactas las cortas; un tipo desconocido se muestra como General", () => {
  const long = "Texto largo. ".repeat(40).trim();
  const [short, cut, unknown] = noteTimeline([
    note("n1", "follow_up", "Llamar el lunes.", "2026-10-03T12:00:00Z"),
    note("n2", "follow_up", long, "2026-10-02T12:00:00Z"),
    note("n3", "clinical", "Tipo futuro.", "2026-10-01T12:00:00Z"),
  ]);
  assert.equal(short.description, "Llamar el lunes.");
  assert.ok(cut.description.length <= 141 && cut.description.endsWith("…") && long.startsWith(cut.description.slice(0, -1)));
  assert.equal(unknown.title, "Nota agregada · General");
});

test("el historial nombra cómo se cobró y refleja un cobro registrado después", () => {
  const names = { cash: "Efectivo", transfer: "Transferencia" };
  const paymentName = (payment) => payment.provider === "offline" ? names[payment.method] : payment.provider === "mercado_pago_ar" ? "Mercado Pago" : "Pago";
  const base = { patientCreatedAt: "2026-09-01T10:00:00Z", notes: [], activities: [], followUps: [],
    appointments: [{ id: "a1", booking_intent_id: "i1", professional_id: "pr1", starts_at: "2026-10-12T14:00:00Z", created_at: "2026-10-09T12:00:00Z", status_changed_at: null, status: "scheduled" }],
    intents: [{ id: "i1", service_id: "s1", professional_id: "pr1", created_at: "2026-10-09T12:00:00Z", status: "scheduled", source: "manual", price_minor: 2500000 }],
    services: new Map([["s1", "Consulta inicial"]]), professionals: new Map([["pr1", "Ana López"]]), money: (amount) => `$${amount / 100}`, paymentName };
  // Turno manual todavía sin cobrar: no hay pago, así que el historial no inventa ninguno.
  const pending = buildPatientTimeline({ ...base, payments: [] });
  assert.deepEqual(pending.map((event) => event.title), ["Turno reservado", "Paciente creado"]);
  // Se registra el cobro después, por un importe distinto del precio: aparece con su medio y su fecha.
  const paid = buildPatientTimeline({ ...base, payments: [{ id: "p1", booking_intent_id: "i1", provider: "offline", method: "transfer", amount_minor: 2350000, currency_code: "ARS", status: "approved", created_at: "2026-10-10T06:15:35Z", approved_at: "2026-10-10T06:15:35Z" }] });
  assert.deepEqual(paid.map((event) => event.title), ["Pago recibido", "Turno reservado", "Paciente creado"]);
  const event = paid.find((item) => item.kind === "payment");
  assert.equal(event.description, "$23500 · Consulta inicial · Transferencia");
  assert.equal(event.at, "2026-10-10T06:15:35Z");
  assert.doesNotMatch(event.description, /Mercado Pago/);
  // Un pago de Mercado Pago se nombra como tal; uno pendiente no lleva medio.
  const provider = buildPatientTimeline({ ...base, payments: [{ id: "p2", booking_intent_id: "i1", provider: "mercado_pago_ar", amount_minor: 2500000, currency_code: "ARS", status: "approved", created_at: "2026-10-09T12:01:00Z", approved_at: "2026-10-09T12:02:00Z" }] });
  assert.match(provider.find((item) => item.kind === "payment").description, /Mercado Pago$/);
  const waiting = buildPatientTimeline({ ...base, payments: [{ id: "p3", booking_intent_id: "i1", provider: "mercado_pago_ar", amount_minor: 2500000, currency_code: "ARS", status: "pending", created_at: "2026-10-09T12:01:00Z", approved_at: null }] });
  assert.equal(waiting.find((item) => item.kind === "payment").title, "Pago pendiente");
  assert.equal(waiting.find((item) => item.kind === "payment").description, "$25000 · Consulta inicial");
});
