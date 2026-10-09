import test from "node:test";
import assert from "node:assert/strict";
import { SLOT_PREVIEW, slotDensity } from "../lib/slot-density.ts";

const day = "2026-10-12";
const slots = (count) => Array.from({ length: count }, (_, index) => ({ value: `slot-${index + 1}`, label: `slot-${index + 1}` }));
const collapsed = (count) => slotDensity({ slots: slots(count), selected: "", day, expandedDay: null });

test("A. 7 horarios: se ven los 7, sin botón", () => {
  const result = collapsed(7);
  assert.equal(result.visible.length, 7);
  assert.equal(result.hasMore, false);
});

test("B. 8 horarios: se ven los 8, sin botón", () => {
  const result = collapsed(8);
  assert.equal(result.visible.length, 8);
  assert.equal(result.hasMore, false);
});

test("C. 9 horarios: se ven 8 y aparece el botón", () => {
  const result = collapsed(9);
  assert.deepEqual(result.visible.map((item) => item.value), slots(8).map((item) => item.value));
  assert.equal(result.hasMore, true);
  assert.equal(result.expanded, false);
});

test("D. 20 horarios: se ven 8 y aparece el botón", () => {
  const result = collapsed(20);
  assert.equal(result.visible.length, SLOT_PREVIEW);
  assert.equal(result.hasMore, true);
});

test("E. expandido: se ven todos, en el mismo orden y sin botón", () => {
  const all = slots(20);
  const result = slotDensity({ slots: all, selected: "", day, expandedDay: day });
  assert.deepEqual(result.visible, all);
  assert.equal(result.hasMore, false);
  assert.equal(result.expanded, true);
});

test("F. el horario elegido fuera de los primeros 8 expande solo", () => {
  const result = slotDensity({ slots: slots(20), selected: "slot-9", day, expandedDay: null });
  assert.equal(result.visible.length, 20);
  assert.equal(result.hasMore, false);
  assert.equal(result.expanded, true);
  // Elegir uno de los primeros 8 no expande.
  assert.equal(slotDensity({ slots: slots(20), selected: "slot-8", day, expandedDay: null }).hasMore, true);
});

test("G. al cambiar de fecha vuelve a colapsado", () => {
  const result = slotDensity({ slots: slots(20), selected: "", day: "2026-10-13", expandedDay: day });
  assert.equal(result.visible.length, SLOT_PREVIEW);
  assert.equal(result.hasMore, true);
  assert.equal(result.expanded, false);
});

test("sin horarios o sin fecha no hay nada que expandir", () => {
  assert.deepEqual(slotDensity({ slots: [], selected: "", day, expandedDay: day }), { visible: [], hasMore: false, expanded: false });
  assert.equal(slotDensity({ slots: slots(20), selected: "", day: "", expandedDay: "" }).hasMore, true);
});
