import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "../lib/friendly-error.ts";

const fallback = "No pudimos guardar. Intentá de nuevo.";

test("los mensajes escritos por Bellis se muestran tal cual", () => {
  for (const message of ["Ese horario acaba de ocuparse. Elegí otro.", "No tenés permiso para cambiar esta agenda.", "¿Seguro? Revisá el importe.", "La nota es demasiado larga."])
    assert.equal(friendlyError(new Error(message), fallback), message);
});

test("los errores técnicos nunca se muestran crudos", () => {
  for (const message of [
    'duplicate key value violates unique constraint "payments_one_per_intent"',
    'new row violates row-level security policy for table "patient_notes"',
    "invalid_payment", "slot_unavailable", "onboarding_required",
    'column "foo" does not exist', "JSON object requested, multiple (or no) rows returned",
    "Cannot read properties of undefined (reading 'id')", "canceling statement due to statement timeout", "",
  ]) {
    const shown = friendlyError(new Error(message), fallback);
    assert.ok(!shown.includes(message) || message === "", message);
    assert.match(shown, /^(No |Tu )/, message);
  }
  // Un error de Supabase no es una instancia de Error: se lee su mensaje igual.
  assert.equal(friendlyError({ message: 'relation "x" does not exist', code: "42P01" }, fallback), fallback);
  assert.equal(friendlyError(undefined, fallback), fallback);
});

test("conexión, sesión y permisos dicen qué hacer", () => {
  assert.match(friendlyError(new TypeError("Failed to fetch"), fallback), /conexión/);
  assert.match(friendlyError(new Error("JWT expired"), fallback), /Volvé a ingresar/);
  assert.match(friendlyError(new Error("authentication_required"), fallback), /Volvé a ingresar/);
  assert.match(friendlyError(new Error("permission denied for table payments"), fallback), /permiso/);
  assert.match(friendlyError(new Error("not_authorized"), fallback), /permiso/);
});
