import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Internal notes are read only by the signed-in CRM. Nothing a patient or an anonymous visitor reaches may load them.
const root = new URL("..", import.meta.url).pathname;
const files = (dir) => readdirSync(join(root, dir)).flatMap((name) => {
  const path = join(dir, name);
  return statSync(join(root, path)).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
});
const mentionsNotes = (path) => /patient_notes/.test(readFileSync(join(root, path), "utf8"));

test("las funciones públicas (reserva, pago, webhook) no leen ni devuelven notas", () => {
  const sources = files("supabase/functions");
  assert.ok(sources.includes("supabase/functions/bellis-public/index.ts"));
  assert.deepEqual(sources.filter(mentionsNotes), []);
});

test("las páginas públicas del profesional y el retorno de pago no consultan notas", () => {
  const sources = [...files("app/p"), ...files("app/profesional"), ...files("app/mercado-pago"), ...files("components/booking"), "lib/bellis-public.ts"];
  assert.deepEqual(sources.filter(mentionsNotes), []);
});

test("solo la ficha del paciente consulta la tabla de notas", () => {
  const sources = [...files("app"), ...files("components"), ...files("lib")].filter(mentionsNotes);
  assert.deepEqual(sources, ["app/pacientes/[id]/page.tsx"]);
});
