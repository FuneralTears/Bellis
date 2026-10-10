import test from "node:test";
import assert from "node:assert/strict";
import { afterCreateError, amountText, canCancelAppointment, canRecordPayment, cancelArgs, cancelQuestion, chargeLabel, describeCancelError, describeManualError, describePaymentError, draftProblem, emptyDraft, parseAmountMinor, paymentArgs, paymentLabel, paymentMethodLabels, paymentProblem, selectDay, selectProfessional, selectService, selectSlot, setPaid } from "../lib/manual-appointment.ts";

const service = { id: "s1", price_minor: 2500000 };
const complete = { patientId: "p1", professionalId: "pro", serviceId: "s1", day: "2026-10-20", slot: "2026-10-20T12:00:00Z", paid: false, method: "", amount: "25000" };

test("cambiar la fecha invalida el horario elegido y conserva el resto", () => {
  const next = selectDay(complete, "2026-10-21");
  assert.equal(next.slot, "");
  assert.deepEqual({ ...next, slot: complete.slot, day: complete.day }, complete);
  // La misma fecha no cambia nada.
  assert.equal(selectDay(complete, complete.day), complete);
});

test("cambiar el servicio invalida el horario y sugiere su precio como importe", () => {
  const next = selectService({ ...complete, amount: "999" }, { id: "s2", price_minor: 3000000 });
  assert.deepEqual([next.serviceId, next.slot, next.amount, next.day, next.patientId], ["s2", "", "30000", complete.day, "p1"]);
  assert.equal(selectService(complete, service), complete);
  assert.deepEqual([selectService(complete, null).serviceId, selectService(complete, null).slot], ["", ""]);
});

test("cambiar el profesional invalida servicio y horario, y conserva paciente y cobro", () => {
  const paid = { ...complete, paid: true, method: "cash" };
  const next = selectProfessional(paid, "otro");
  assert.deepEqual([next.professionalId, next.serviceId, next.slot, next.patientId, next.paid, next.method], ["otro", "", "", "p1", true, "cash"]);
  assert.equal(selectProfessional(paid, "pro"), paid);
});

test("solo se puede elegir un horario que el servidor ofreció", () => {
  const offered = ["2026-10-20T12:00:00Z", "2026-10-20T12:30:00Z"];
  assert.equal(selectSlot({ ...complete, slot: "" }, offered[1], offered).slot, offered[1]);
  assert.equal(selectSlot({ ...complete, slot: "" }, "2026-10-20T13:17:00Z", offered).slot, "");
});

test("el pago pendiente no requiere método ni importe, y no envía ninguno", () => {
  assert.equal(paymentProblem({ paid: false, method: "", amount: "" }), null);
  assert.deepEqual(paymentArgs({ paid: false, method: "", amount: "25000" }), { method: null, amountMinor: null });
  // Volver a pendiente borra el método elegido.
  assert.equal(setPaid({ ...complete, paid: true, method: "transfer" }, false).method, "");
  assert.equal(draftProblem(complete), null);
});

test("pagado fuera de Bellis requiere método", () => {
  assert.match(paymentProblem({ paid: true, method: "", amount: "25000" }), /cómo se cobró/);
  assert.equal(paymentProblem({ paid: true, method: "cash", amount: "25000" }), null);
  assert.deepEqual(paymentArgs({ paid: true, method: "transfer", amount: "20000" }), { method: "transfer", amountMinor: 2000000 });
  assert.match(draftProblem({ ...complete, paid: true }), /cómo se cobró/);
});

test("el importe tiene que ser mayor a 0", () => {
  for (const bad of ["", "0", "0,00", "-5", "abc", "25.00.0", "1e5", " "]) {
    assert.equal(parseAmountMinor(bad), null, `"${bad}"`);
    assert.match(paymentProblem({ paid: true, method: "cash", amount: bad }), /importe/, `"${bad}"`);
  }
  assert.equal(parseAmountMinor("25000"), 2500000);
  assert.equal(parseAmountMinor("25.000"), 2500000);
  assert.equal(parseAmountMinor("1.250.000,50"), 125000050);
  assert.equal(parseAmountMinor("25000,5"), 2500050);
  assert.equal(parseAmountMinor("25000.50"), 2500050);
  assert.equal(parseAmountMinor("$ 15.000"), 1500000);
  assert.equal(parseAmountMinor("0,01"), 1);
});

test("el importe sugerido se escribe como lo leería una persona", () => {
  assert.equal(amountText(2500000), "25000");
  assert.equal(amountText(2500050), "25000,50");
  assert.equal(parseAmountMinor(amountText(2500050)), 2500050);
});

test("avisa qué falta, en orden", () => {
  const steps = [["patientId", /paciente/], ["professionalId", /profesional/], ["serviceId", /servicio/], ["day", /fecha/], ["slot", /horario/]];
  for (const [key, pattern] of steps) assert.match(draftProblem({ ...complete, [key]: "" }), pattern);
  assert.match(draftProblem(emptyDraft("pro")), /paciente/);
  assert.equal(emptyDraft("pro").professionalId, "pro");
});

test("etiquetas de cobro: pendiente, medio offline y nunca Mercado Pago para un cobro offline", () => {
  assert.deepEqual(paymentMethodLabels, { cash: "Efectivo", transfer: "Transferencia", other: "Otro" });
  assert.equal(paymentLabel(undefined), "Pendiente");
  assert.equal(paymentLabel(null), "Pendiente");
  assert.equal(paymentLabel({ provider: "offline", method: "cash", status: "approved" }), "Efectivo");
  assert.equal(paymentLabel({ provider: "offline", method: "transfer", status: "approved" }), "Transferencia");
  assert.equal(paymentLabel({ provider: "offline", method: "other", status: "approved" }), "Otro");
  for (const method of ["cash", "transfer", "other", null]) assert.doesNotMatch(paymentLabel({ provider: "offline", method, status: "approved" }), /Mercado Pago/);
  assert.equal(paymentLabel({ provider: "mercado_pago_ar", status: "approved" }), "Mercado Pago");
  assert.equal(paymentLabel({ provider: "external_link", status: "approved" }), "Link de pago");
  // Un pago que todavía espera es "Pendiente", venga de donde venga.
  assert.equal(paymentLabel({ provider: "mercado_pago_ar", status: "pending" }), "Pendiente");
  assert.equal(paymentLabel({ provider: "external_link", status: "pending" }), "Pendiente");
  // Sin proveedor cargado no se asume Mercado Pago.
  assert.equal(paymentLabel({ status: "approved" }), "Pago");
  assert.doesNotMatch(paymentLabel({ provider: null, status: "approved" }), /Mercado Pago/);
  // Un pago que no se completó conserva su resultado.
  assert.equal(paymentLabel({ provider: "mercado_pago_ar", status: "rejected" }), "Mercado Pago · rechazado");
  assert.equal(paymentLabel({ provider: "mercado_pago_ar", status: "refunded" }), "Mercado Pago · reembolsado");
  assert.equal(paymentLabel({ provider: "offline", method: "raro", status: "approved" }), "Fuera de Bellis");
});

test("un horario que dejó de estar libre pide refrescar; los demás errores no", () => {
  for (const code of ["slot_unavailable", "slot_in_past", 'conflicting key value violates exclusion constraint "appointments_no_overlap"'])
    assert.equal(describeManualError(code).slotConflict, true, code);
  for (const code of ["invalid_patient", "invalid_service", "invalid_payment", "not_authorized", "authentication_required", "TypeError: Failed to fetch", "otra cosa"])
    assert.equal(describeManualError(code).slotConflict, false, code);
  assert.match(describeManualError("not_authorized").text, /permiso/);
  assert.match(describeManualError("TypeError: Failed to fetch").text, /conexión/);
  assert.match(describeManualError("invalid_payment").text, /importe/);
});

test("horario ocupado al guardar: se reconoce, pide refrescar y solo se pierde el horario", () => {
  const draft = { ...complete, paid: true, method: "transfer", amount: "20.000" };
  for (const message of ["slot_unavailable", 'conflicting key value violates exclusion constraint "appointments_no_overlap"']) {
    const result = afterCreateError(draft, message);
    assert.equal(result.text, "Ese horario acaba de ocuparse. Elegí otro.");
    assert.equal(result.refreshSlots, true);
    assert.equal(result.draft.slot, "");
    // Paciente, profesional, servicio, fecha, estado de cobro, método e importe quedan como estaban.
    assert.deepEqual({ ...result.draft, slot: draft.slot }, draft);
    assert.deepEqual(result.draft, { patientId: "p1", professionalId: "pro", serviceId: "s1", day: "2026-10-20", slot: "", paid: true, method: "transfer", amount: "20.000" });
    // Al elegir otro horario el turno queda listo para crear, con el mismo cobro.
    const repicked = selectSlot(result.draft, "2026-10-20T13:00:00Z", ["2026-10-20T13:00:00Z"]);
    assert.equal(draftProblem(repicked), null);
    assert.deepEqual(paymentArgs(repicked), { method: "transfer", amountMinor: 2000000 });
  }
  // El borrador original no se modifica.
  assert.equal(draft.slot, complete.slot);
});

test("un horario que ya pasó también pide elegir otro, sin perder el resto", () => {
  const result = afterCreateError(complete, "slot_in_past");
  assert.deepEqual([result.refreshSlots, result.draft.slot, result.draft.day, result.draft.patientId], [true, "", complete.day, "p1"]);
});

test("otros errores al guardar no tocan el horario ni piden refrescar", () => {
  for (const message of ["invalid_payment", "not_authorized", "TypeError: Failed to fetch", "unknown"]) {
    const result = afterCreateError(complete, message);
    assert.equal(result.draft, complete, message);
    assert.equal(result.refreshSlots, false, message);
    assert.ok(result.text.length > 0, message);
  }
});

test("registrar pago: solo en turnos manuales activos y sin cobro", () => {
  assert.equal(canRecordPayment({ source: "manual", appointmentStatus: "scheduled", hasPayment: false }), true);
  assert.equal(canRecordPayment({ source: "manual", appointmentStatus: "completed", hasPayment: false }), true);
  // Ya tiene un cobro: no se ofrece cobrar de nuevo.
  assert.equal(canRecordPayment({ source: "manual", appointmentStatus: "scheduled", hasPayment: true }), false);
  // Los turnos del booking público se cobran por su propio medio.
  assert.equal(canRecordPayment({ source: "public", appointmentStatus: "scheduled", hasPayment: false }), false);
  assert.equal(canRecordPayment({ appointmentStatus: "scheduled", hasPayment: false }), false);
  assert.equal(canRecordPayment({ source: "manual", appointmentStatus: "cancelled", hasPayment: false }), false);
});

test("registrar pago después: método obligatorio, importe editable y mayor a 0, precio del servicio como sugerencia", () => {
  const suggested = amountText(2500000);
  assert.equal(suggested, "25000");
  assert.match(paymentProblem({ paid: true, method: "", amount: suggested }), /cómo se cobró/);
  assert.deepEqual(paymentArgs({ paid: true, method: "cash", amount: suggested }), { method: "cash", amountMinor: 2500000 });
  // Importe distinto del precio del servicio.
  assert.deepEqual(paymentArgs({ paid: true, method: "transfer", amount: "23.500" }), { method: "transfer", amountMinor: 2350000 });
  assert.deepEqual(paymentArgs({ paid: true, method: "other", amount: "100,50" }), { method: "other", amountMinor: 10050 });
  assert.match(paymentProblem({ paid: true, method: "cash", amount: "0" }), /importe/);
  assert.match(paymentProblem({ paid: true, method: "cash", amount: "" }), /importe/);
});

test("doble cobro rechazado: se reconoce y pide recargar el turno en vez de cobrar otra vez", () => {
  for (const message of ["payment_already_recorded", 'duplicate key value violates unique constraint "payments_one_per_intent"']) {
    const failure = describePaymentError(message);
    assert.equal(failure.alreadyPaid, true, message);
    assert.equal(failure.text, "Este turno ya tiene un cobro registrado.");
  }
  for (const message of ["invalid_payment", "appointment_not_active", "not_manual_appointment", "not_authorized", "TypeError: Failed to fetch", "otra cosa"]) {
    const failure = describePaymentError(message);
    assert.equal(failure.alreadyPaid, false, message);
    assert.ok(failure.text.length > 0, message);
  }
  assert.match(describePaymentError("appointment_not_active").text, /cancelado/);
  assert.match(describePaymentError("TypeError: Failed to fetch").text, /conexión/);
});

test("cancelar turno: solo se ofrece en turnos manuales agendados", () => {
  assert.equal(canCancelAppointment({ source: "manual", appointmentStatus: "scheduled" }), true);
  // Tras cancelar, el botón desaparece; un turno atendido o del booking público nunca lo muestra.
  assert.equal(canCancelAppointment({ source: "manual", appointmentStatus: "cancelled" }), false);
  assert.equal(canCancelAppointment({ source: "manual", appointmentStatus: "completed" }), false);
  assert.equal(canCancelAppointment({ source: "public", appointmentStatus: "scheduled" }), false);
  assert.equal(canCancelAppointment({ appointmentStatus: "scheduled" }), false);
});

test("cancelar turno: sin pago pregunta por el cobro; con pago registrado no pregunta el medio", () => {
  assert.equal(cancelQuestion(false), "ask_charge");
  assert.equal(cancelQuestion(true), "confirm_paid");
});

test("cancelar sin cobrar no manda medio ni importe; cancelar y registrar pago exige medio e importe mayor a 0", () => {
  assert.deepEqual(cancelArgs({ charge: false, method: "", amount: "25000" }), { mode: "no_payment", method: null, amountMinor: null });
  // Con un cobro ya registrado se cancela igual, sin mandar otro cobro aunque haya algo tipeado.
  assert.deepEqual(cancelArgs({ charge: false, method: "cash", amount: "25000" }), { mode: "no_payment", method: null, amountMinor: null });
  assert.deepEqual(cancelArgs({ charge: true, method: "transfer", amount: "24.500" }), { mode: "record_payment", method: "transfer", amountMinor: 2450000 });
  assert.deepEqual(cancelArgs({ charge: true, method: "other", amount: amountText(2500000) }), { mode: "record_payment", method: "other", amountMinor: 2500000 });
  assert.equal(cancelArgs({ charge: true, method: "", amount: "25000" }), null);
  assert.equal(cancelArgs({ charge: true, method: "cash", amount: "0" }), null);
  assert.equal(cancelArgs({ charge: true, method: "cash", amount: "" }), null);
  assert.match(paymentProblem({ paid: true, method: "", amount: "25000" }), /cómo se cobró/);
  assert.match(paymentProblem({ paid: true, method: "cash", amount: "0" }), /importe/);
});

test("turno cancelado: no ofrece Registrar pago y su cobro no se muestra como pendiente", () => {
  assert.equal(canRecordPayment({ source: "manual", appointmentStatus: "cancelled", hasPayment: false }), false);
  assert.equal(chargeLabel(null, "cancelled"), "Sin cobro");
  assert.equal(chargeLabel({ provider: "offline", method: "transfer", status: "approved" }, "cancelled"), "Transferencia");
  assert.equal(chargeLabel({ provider: "offline", method: "cash", status: "approved" }, "cancelled"), "Efectivo");
  // Un cobro registrado nunca pasa a llamarse Mercado Pago por cancelar el turno.
  assert.notEqual(chargeLabel({ provider: "offline", method: "other", status: "approved" }, "cancelled"), "Mercado Pago");
  // Un turno activo sigue igual que antes.
  assert.equal(chargeLabel(null, "scheduled"), "Pendiente");
  assert.equal(chargeLabel({ provider: "mercado_pago_ar", status: "approved" }, "scheduled"), "Mercado Pago");
});

test("errores al cancelar: explican qué pasó y recargan cuando el turno cambió", () => {
  for (const message of ["appointment_already_cancelled", "payment_already_recorded", "appointment_not_cancellable"]) assert.equal(describeCancelError(message).reload, true, message);
  for (const message of ["not_manual_appointment", "invalid_payment", "not_authorized", "authentication_required", "TypeError: Failed to fetch", "otra cosa"]) {
    assert.equal(describeCancelError(message).reload, false, message);
    assert.ok(describeCancelError(message).text.length > 0, message);
  }
  assert.match(describeCancelError("appointment_already_cancelled").text, /ya estaba cancelado/);
  assert.match(describeCancelError("payment_already_recorded").text, /el cobro se conserva/);
  assert.match(describeCancelError("appointment_not_cancellable").text, /atendido/);
  assert.match(describeCancelError("TypeError: Failed to fetch").text, /conexión/);
});
