import test from "node:test";
import assert from "node:assert/strict";
import { addDays, addMonths, agendaPeriod, appointmentsInPeriod, dayLabels, emptyPeriodText, inPeriod, isDay, monthWeeks, periodLabel, shiftPeriod, startOfWeek, stepLabel } from "../lib/agenda-period.ts";

const turn = (id, dateKey, startTime = "10:00") => ({ id, dateKey, startTime });

test("la semana son 7 días consecutivos, de lunes a domingo, aunque los turnos estén en otros meses", () => {
  // El caso real: turnos el 12, 13 y 14 de octubre, el 16 de diciembre y el 18 de enero.
  const items = [turn("a", "2026-10-12"), turn("b", "2026-10-13"), turn("c", "2026-10-14"), turn("d", "2026-12-16"), turn("e", "2027-01-18")];
  const week = agendaPeriod("Semana", "2026-10-14");
  assert.deepEqual(week.days, ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.deepEqual([week.start, week.end], ["2026-10-12", "2026-10-18"]);
  assert.deepEqual(appointmentsInPeriod(week, items).map((item) => item.id), ["a", "b", "c"]);
  assert.equal(periodLabel(week, "es-AR"), "12 – 18 oct 2026");
});

test("una semana sin turnos sigue teniendo sus 7 días", () => {
  const week = agendaPeriod("Semana", "2026-11-04");
  assert.equal(week.days.length, 7);
  assert.equal(week.start, "2026-11-02");
  assert.deepEqual(appointmentsInPeriod(week, [turn("a", "2026-10-12"), turn("b", "2026-11-09")]), []);
  assert.equal(emptyPeriodText("Semana"), "No hay turnos esta semana");
});

test("la semana arranca el lunes, también si el día es domingo, y cruza meses y años", () => {
  assert.equal(startOfWeek("2026-10-18"), "2026-10-12"); // domingo
  assert.equal(startOfWeek("2026-10-12"), "2026-10-12"); // lunes
  assert.equal(startOfWeek("2026-10-03"), "2026-09-28");
  const crossing = agendaPeriod("Semana", "2027-01-01");
  assert.deepEqual([crossing.start, crossing.end], ["2026-12-28", "2027-01-03"]);
  assert.equal(periodLabel(crossing, "es-AR"), "28 dic 2026 – 3 ene 2027");
  assert.equal(periodLabel(agendaPeriod("Semana", "2026-10-03"), "es-AR"), "28 sept – 4 oct 2026");
});

test("el día es un solo día calendario", () => {
  const day = agendaPeriod("Día", "2026-10-17");
  assert.deepEqual(day.days, ["2026-10-17"]);
  assert.deepEqual(appointmentsInPeriod(day, [turn("a", "2026-10-17", "15:00"), turn("b", "2026-10-17", "09:00"), turn("c", "2026-10-18")]).map((item) => item.id), ["b", "a"]);
  assert.equal(periodLabel(day, "es-AR"), "Sábado, 17 de octubre de 2026");
});

test("el mes es el mes calendario real, del 1 al último día", () => {
  const october = agendaPeriod("Mes", "2026-10-17");
  assert.deepEqual([october.start, october.end, october.days.length], ["2026-10-01", "2026-10-31", 31]);
  assert.deepEqual(agendaPeriod("Mes", "2028-02-10").days.length, 29);
  assert.deepEqual(agendaPeriod("Mes", "2027-02-10").days.length, 28);
  assert.deepEqual(appointmentsInPeriod(october, [turn("a", "2026-09-30"), turn("b", "2026-10-01"), turn("c", "2026-10-31"), turn("d", "2026-11-01")]).map((item) => item.id), ["b", "c"]);
  assert.equal(periodLabel(october, "es-AR"), "Octubre de 2026");
  // La grilla del mes va de lunes a domingo y puede mostrar días vecinos, que no son del período.
  const weeks = monthWeeks(october);
  assert.deepEqual([weeks[0][0], weeks.at(-1).at(-1), weeks.length], ["2026-09-28", "2026-11-01", 5]);
  assert.ok(weeks.every((week) => week.length === 7));
  assert.equal(inPeriod(october, "2026-09-28"), false);
});

test("las flechas mueven un día, una semana o un mes", () => {
  assert.equal(shiftPeriod("Día", "2026-10-17", 1), "2026-10-18");
  assert.equal(shiftPeriod("Día", "2026-10-01", -1), "2026-09-30");
  assert.equal(shiftPeriod("Semana", "2026-10-17", 1), "2026-10-24");
  assert.equal(shiftPeriod("Semana", "2026-10-17", -1), "2026-10-10");
  assert.equal(agendaPeriod("Semana", shiftPeriod("Semana", "2026-10-14", 1)).start, "2026-10-19");
  assert.equal(shiftPeriod("Mes", "2026-10-17", 1), "2026-11-17");
  assert.equal(shiftPeriod("Mes", "2026-12-17", 1), "2027-01-17");
  // El 31 pasa al último día de un mes más corto, y sigue siendo ese mes.
  assert.equal(shiftPeriod("Mes", "2027-01-31", 1), "2027-02-28");
  assert.equal(agendaPeriod("Mes", shiftPeriod("Mes", "2027-03-31", -1)).start, "2027-02-01");
  assert.equal(stepLabel("Semana", -1), "Semana anterior");
  assert.equal(stepLabel("Mes", 1), "Mes siguiente");
});

test("cambiar de vista conserva el día de referencia", () => {
  const anchor = "2026-10-17";
  assert.ok(inPeriod(agendaPeriod("Día", anchor), anchor));
  assert.ok(inPeriod(agendaPeriod("Semana", anchor), anchor));
  assert.ok(inPeriod(agendaPeriod("Mes", anchor), anchor));
  // Una semana que empieza en otro mes, vista como mes, es el mes del día de referencia.
  assert.equal(agendaPeriod("Mes", "2026-10-03").start, "2026-10-01");
});

test("fechas: aritmética exacta y nada inválido", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(isDay("2026-02-30"), false);
  assert.equal(isDay("2026-10-17"), true);
  assert.throws(() => agendaPeriod("Semana", "17/10/2026"));
  assert.deepEqual(dayLabels("2026-10-12", "es-AR"), { weekday: "lunes", dateLabel: "12 oct 2026" });
});
