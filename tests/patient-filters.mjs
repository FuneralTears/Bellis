import test from "node:test";
import assert from "node:assert/strict";
import { advancedCount, applyDue, applyShow, applySituation, basicStatusOptions, dueOf, showOf, shownStatus, situationOf, statusFilterValues, statusOptionsFor } from "../lib/patient-filters.ts";

const none = { status: "all", followUp: "all", opportunity: "all" };

test("Mostrar usa los filtros que ya existían, sin cambiar su significado", () => {
  assert.deepEqual(applyShow(none, "attention"), { status: "all", followUp: "all", opportunity: "attention" });
  assert.deepEqual(applyShow(none, "with"), { status: "all", followUp: "with", opportunity: "all" });
  assert.deepEqual(applyShow(none, "without"), { status: "all", followUp: "without", opportunity: "all" });
  for (const show of ["all", "attention", "with", "without"]) assert.equal(showOf(applyShow(none, show)), show);
});

test("Mostrar elige una sola opción y no toca los filtros avanzados", () => {
  const advanced = { status: "active", followUp: "overdue", opportunity: "pending_payment" };
  // "Todos" no borra el estado, el vencimiento ni la situación elegidos en Más filtros.
  assert.deepEqual(applyShow(advanced, "all"), advanced);
  assert.equal(showOf(advanced), "all");
  // Pasar de una opción a otra limpia la anterior.
  assert.deepEqual(applyShow(applyShow(none, "attention"), "with"), { status: "all", followUp: "with", opportunity: "all" });
  assert.deepEqual(applyShow(applyShow(none, "with"), "attention"), { status: "all", followUp: "all", opportunity: "attention" });
  assert.deepEqual(applyShow(applyShow(none, "without"), "all"), none);
  assert.equal(applyShow({ ...none, status: "new" }, "attention").status, "new");
});

test("Seguimientos: Vencidos y Hoy reutilizan el filtro de seguimiento", () => {
  assert.equal(applyDue(none, "overdue").followUp, "overdue");
  assert.equal(applyDue(none, "today").followUp, "today");
  assert.equal(dueOf(applyDue(none, "today")), "today");
  // Reemplazan "Con seguimiento": son el mismo filtro.
  const due = applyDue(applyShow(none, "with"), "overdue");
  assert.equal(due.followUp, "overdue"); assert.equal(showOf(due), "all");
  // "Todos los seguimientos" solo quita el vencimiento; no borra "Con seguimiento".
  assert.deepEqual(applyDue(applyShow(none, "with"), "all"), applyShow(none, "with"));
  assert.deepEqual(applyDue(due, "all"), none);
  // Se combina con "Necesitan atención", como antes.
  assert.deepEqual(applyDue(applyShow(none, "attention"), "overdue"), { status: "all", followUp: "overdue", opportunity: "attention" });
});

test("situación puntual: reemplaza a Necesitan atención y cuenta como filtro avanzado", () => {
  const paid = applySituation(applyShow(none, "attention"), "pending_payment");
  assert.equal(paid.opportunity, "pending_payment"); assert.equal(showOf(paid), "all"); assert.equal(situationOf(paid), "pending_payment");
  assert.deepEqual(applySituation(paid, "all"), none);
  // Quitar la situación no apaga "Necesitan atención".
  assert.deepEqual(applySituation(applyShow(none, "attention"), "all"), applyShow(none, "attention"));
  assert.equal(advancedCount(none), 0);
  assert.equal(advancedCount(applyShow(none, "attention")), 0);
  assert.equal(advancedCount(applyShow(none, "with")), 0);
  assert.equal(advancedCount({ status: "active", followUp: "today", opportunity: "pending_payment" }), 3);
});

test("En seguimiento es un estado del CRM: sin Bellis Pro no se ofrece ni se muestra, y el dato guardado no cambia", () => {
  assert.deepEqual(statusOptionsFor(true).map((item) => item.value), ["all", "new", "active", "follow_up", "inactive"]);
  assert.deepEqual(statusOptionsFor(false).map((item) => item.value), ["all", "new", "active", "inactive"]);
  assert.equal(basicStatusOptions.some((item) => item.label === "En seguimiento"), false);
  // Un paciente guardado como "En seguimiento" se lee como activo sin CRM, y como antes con CRM.
  assert.equal(shownStatus("follow_up", false), "active");
  assert.equal(shownStatus("follow_up", true), "follow_up");
  for (const status of ["new", "active", "inactive"]) { assert.equal(shownStatus(status, false), status); assert.equal(shownStatus(status, true), status); }
  // El filtro "Activos" sin CRM incluye a esos pacientes: lo que se ve y lo que se filtra coinciden.
  assert.deepEqual(statusFilterValues("active", false), ["active", "follow_up"]);
  assert.deepEqual(statusFilterValues("active", true), ["active"]);
  assert.deepEqual(statusFilterValues("follow_up", true), ["follow_up"]);
  // Un filtro "En seguimiento" que había quedado elegido no filtra nada sin CRM.
  assert.deepEqual(statusFilterValues("follow_up", false), []);
  assert.deepEqual(statusFilterValues("all", false), []);
  assert.deepEqual(statusFilterValues("inactive", false), ["inactive"]);
});
