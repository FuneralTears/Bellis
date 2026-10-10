import test from "node:test";
import assert from "node:assert/strict";
import { checkDuplicates, duplicateReason, emailKey, findDuplicates, phoneKey } from "../lib/patient-duplicates.ts";

const mariana = { id: "p1", full_name: "Mariana López", phone: "+5491148129021", email: "mariana.lopez@email.com" };
const carlos = { id: "p2", full_name: "Carlos Ruiz", phone: "+5491173041822", email: null };
const sinTelefono = { id: "p3", full_name: "Jorge Castro", phone: null, email: "jorge.castro@email.com" };
const all = [mariana, carlos, sinTelefono];
const summary = (matches) => matches.map((item) => [item.id, item.by, item.records]);

test("el teléfono coincide con cualquier prefijo o formato", () => {
  assert.equal(phoneKey("+5491148129021"), "1148129021");
  assert.equal(phoneKey("+54 9 11 4812 9021"), "1148129021");
  assert.equal(phoneKey("+541148129021"), "1148129021");
  assert.equal(phoneKey("11 4812-9021"), "1148129021");
  assert.equal(phoneKey("4812 9021"), null);
  assert.equal(phoneKey(null), null);
});

test("el email coincide sin mayúsculas ni espacios", () => {
  assert.equal(emailKey("  Mariana.Lopez@Email.com "), "mariana.lopez@email.com");
  assert.equal(emailKey(""), null);
  assert.equal(emailKey(null), null);
});

test("avisa por teléfono", () => {
  const matches = findDuplicates({ phone: "+54 9 11 4812 9021", email: null }, all);
  assert.deepEqual(summary(matches), [["p1", ["phone"], 1]]);
  assert.equal(duplicateReason(matches[0]), "mismo teléfono");
});

test("avisa por email", () => {
  const matches = findDuplicates({ phone: "+5491100000000", email: "JORGE.castro@email.com" }, all);
  assert.deepEqual(summary(matches), [["p3", ["email"], 1]]);
  assert.equal(duplicateReason(matches[0]), "mismo email");
});

test("el mismo paciente que coincide por teléfono y email es un solo resultado, con la razón combinada", () => {
  const matches = findDuplicates({ phone: "+5491148129021", email: "mariana.lopez@email.com" }, all);
  assert.deepEqual(summary(matches), [["p1", ["phone", "email"], 1]]);
  assert.equal(duplicateReason(matches[0]), "mismo teléfono y email");
});

test("el mismo paciente que llega varias veces (una por teléfono, otra por email) es un solo resultado", () => {
  // The screen asks twice, once per criterion, and joins both answers: the same row arrives in each.
  const matches = findDuplicates({ phone: "+5491148129021", email: "mariana.lopez@email.com" }, [mariana, carlos, mariana, mariana]);
  assert.deepEqual(summary(matches), [["p1", ["phone", "email"], 1]]);
});

test("dos pacientes distintos que coinciden son dos resultados, cada uno con su ficha", () => {
  const otra = { id: "p4", full_name: "Otra Persona", phone: "+5491148129021", email: null };
  const matches = findDuplicates({ phone: "+5491148129021", email: "mariana.lopez@email.com" }, [...all, otra]);
  assert.deepEqual(summary(matches), [["p1", ["phone", "email"], 1], ["p4", ["phone"], 1]]);
  assert.equal(duplicateReason(matches[1]), "mismo teléfono");
});

test("mismo teléfono y mismo email con nombre distinto es un solo grupo: el nombre no participa", () => {
  const hermano = { id: "p5", full_name: "Martín López", phone: mariana.phone, email: mariana.email, created_at: "2026-10-09T10:00:00Z" };
  const matches = findDuplicates({ phone: mariana.phone, email: mariana.email }, [{ ...mariana, created_at: "2026-10-01T10:00:00Z" }, hermano]);
  assert.deepEqual(summary(matches), [["p5", ["phone", "email"], 2]]);
  assert.equal(matches[0].full_name, "Martín López");
});

test("mismo teléfono con email distinto son dos tarjetas", () => {
  const otroEmail = { id: "p6", full_name: "Mariana López", phone: mariana.phone, email: "otra.mariana@email.com" };
  const matches = findDuplicates({ phone: mariana.phone, email: mariana.email }, [mariana, otroEmail]);
  assert.deepEqual(summary(matches), [["p1", ["phone", "email"], 1], ["p6", ["phone"], 1]]);
});

test("mismo email con teléfono distinto son dos tarjetas", () => {
  const otroTelefono = { id: "p9", full_name: "Mariana López", phone: "+5491199990000", email: mariana.email };
  const matches = findDuplicates({ phone: mariana.phone, email: mariana.email }, [mariana, otroTelefono]);
  assert.deepEqual(summary(matches), [["p1", ["phone", "email"], 1], ["p9", ["email"], 1]]);
});

test("mismo teléfono sin email en ninguna de las dos no se agrupa", () => {
  const sinEmail = { id: "q1", full_name: "Carlos Ruiz", phone: carlos.phone, email: null };
  const sinEmailVacio = { id: "q2", full_name: "Carlos Ruiz", phone: "+54 11 7304 1822", email: "  " };
  const matches = findDuplicates({ phone: carlos.phone, email: null }, [carlos, sinEmail, sinEmailVacio]);
  assert.deepEqual(summary(matches), [["p2", ["phone"], 1], ["q1", ["phone"], 1], ["q2", ["phone"], 1]]);
  // Tampoco al revés: mismo email sin teléfono en ninguna.
  const otroSinTelefono = { ...sinTelefono, id: "q3" };
  assert.deepEqual(summary(findDuplicates({ phone: null, email: sinTelefono.email }, [sinTelefono, otroSinTelefono])), [["p3", ["email"], 1], ["q3", ["email"], 1]]);
});

test("mismo teléfono y mismo email en varias filas es un grupo con su cantidad, y abre la más reciente", () => {
  // The public booking saves a new patient record for every request, so one person can have several.
  const records = [
    { ...mariana, id: "a", created_at: "2026-10-01T10:00:00Z" },
    { ...mariana, id: "c", created_at: "2026-10-09T10:00:00Z", full_name: "Mariana L." },
    { ...mariana, id: "b", created_at: "2026-10-05T10:00:00Z", phone: "+54 11 4812 9021", email: "Mariana.Lopez@email.com" },
    { ...mariana, id: "d", created_at: "2026-09-20T10:00:00Z" },
  ];
  // "a" arrives twice, as it does when it matches both lookups: it still counts once.
  const matches = findDuplicates({ phone: mariana.phone, email: mariana.email }, [...records, records[0]]);
  assert.deepEqual(summary(matches), [["c", ["phone", "email"], 4]]);
  // Entra por un solo criterio y se agrupa igual: lo que agrupa es que las fichas compartan teléfono y email entre sí.
  assert.deepEqual(summary(findDuplicates({ phone: mariana.phone, email: null }, records)), [["c", ["phone"], 4]]);
  // Sin fecha, queda la primera que llegó.
  assert.deepEqual(summary(findDuplicates({ phone: mariana.phone, email: mariana.email }, [mariana, { ...mariana, id: "z" }])), [["p1", ["phone", "email"], 2]]);
});

test("nunca avisa solo por el nombre", () => {
  const sameName = { id: "p7", full_name: "Mariana López", phone: "+5491199998888", email: "otra.mariana@email.com" };
  assert.deepEqual(findDuplicates({ phone: "+5491100000000", email: "nueva@email.com" }, [sameName]), []);
});

test("sin teléfono ni email no hay con qué comparar, y los vacíos no coinciden entre sí", () => {
  assert.deepEqual(findDuplicates({ phone: null, email: null }, all), []);
  assert.deepEqual(findDuplicates({ phone: "+5491100000000", email: "" }, [carlos, { id: "p8", full_name: "Sin Datos", phone: null, email: null }]), []);
});

// Whether a new patient can be created. Same phone and same email, both present, blocks; anything less only warns.
const ids = (items) => items.map((item) => item.id);

test("teléfono y email iguales: la creación queda bloqueada y se ofrece la ficha que existe", () => {
  const check = checkDuplicates({ phone: "+54 9 11 4812 9021", email: " MARIANA.lopez@email.com " }, all);
  assert.equal(check.strong?.id, "p1");
  assert.equal(check.strong.records, 1);
  assert.deepEqual(ids(check.strong.items), ["p1"]);
  assert.deepEqual(check.weak, []);
});

test("varias fichas con el mismo teléfono y email: bloqueada, con todas las fichas para revisar y ninguna fusionada", () => {
  const records = [
    { ...mariana, id: "a", created_at: "2026-10-01T10:00:00Z" },
    { ...mariana, id: "c", created_at: "2026-10-09T10:00:00Z", full_name: "Martín López" },
    { ...mariana, id: "b", created_at: "2026-10-05T10:00:00Z", phone: "+54 11 4812 9021", email: "Mariana.Lopez@email.com" },
  ];
  const before = JSON.stringify(records);
  // "a" arrives twice, once per lookup, and still counts once. Another person with only the phone stays apart.
  const soloTelefono = { id: "p4", full_name: "Otra Persona", phone: mariana.phone, email: null };
  const check = checkDuplicates({ phone: mariana.phone, email: mariana.email }, [...records, records[0], soloTelefono]);
  assert.equal(check.strong.records, 3);
  assert.deepEqual(ids(check.strong.items), ["c", "b", "a"]);
  assert.equal(check.strong.id, "c");
  assert.deepEqual(check.strong.items.map((item) => item.full_name), ["Martín López", "Mariana López", "Mariana López"]);
  assert.deepEqual(ids(check.weak), ["p4"]);
  assert.equal(JSON.stringify(records), before);
});

test("solo el teléfono igual: se puede crear, con aviso", () => {
  const sinEmail = checkDuplicates({ phone: mariana.phone, email: null }, all);
  assert.equal(sinEmail.strong, null);
  assert.deepEqual(summary(sinEmail.weak), [["p1", ["phone"], 1]]);
  const otroEmail = checkDuplicates({ phone: mariana.phone, email: "otra@email.com" }, all);
  assert.equal(otroEmail.strong, null);
  assert.deepEqual(summary(otroEmail.weak), [["p1", ["phone"], 1]]);
  // The existing record has no email at all: sharing the phone is still only a warning.
  assert.equal(checkDuplicates({ phone: carlos.phone, email: "carlos@email.com" }, all).strong, null);
});

test("solo el email igual: se puede crear, con aviso", () => {
  const check = checkDuplicates({ phone: "+5491100000000", email: mariana.email }, all);
  assert.equal(check.strong, null);
  assert.deepEqual(summary(check.weak), [["p1", ["email"], 1]]);
  // The existing record has no phone at all.
  assert.equal(checkDuplicates({ phone: "+5491100000000", email: sinTelefono.email }, all).strong, null);
});

test("el mismo nombre sin el mismo contacto: se puede crear, sin aviso", () => {
  const sameName = { id: "p7", full_name: "Mariana López", phone: "+5491199998888", email: "otra.mariana@email.com" };
  assert.deepEqual(checkDuplicates({ phone: "+5491100000000", email: "nueva@email.com" }, [sameName]), { strong: null, weak: [] });
});
