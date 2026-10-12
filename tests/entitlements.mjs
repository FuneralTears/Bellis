import test from "node:test";
import assert from "node:assert/strict";
import { bookingsPaused, bookingsPausedCopy, describeUpgradeError, exampleAccess, freeSummary, hasCapability, lastDayOf, navEntry, planNotice, planNoticeKey, planStatus, proBenefits, planSections, proLockCopy, proPrice, shortDay, showsNotificationBell, upgradeRequestMessage } from "../lib/entitlements.ts";

// Lo que responde workspace_access para una prueba que empezó el 15/10 a la tarde.
const trial = (days) => ({ tier: "pro_trial", plan_code: "free", has_pro_access: true, status: "active",
  trial_started_at: "2026-10-15T18:00:00Z", trial_ends_at: "2026-11-15T03:00:00Z", trial_last_day: "2026-11-14", trial_days_remaining: days,
  pro_started_at: null, pro_ends_at: null, upgrade_requested: false,
  capabilities: ["manual_patients", "manual_appointments", "manual_payments", "patient_notes", "public_booking", "external_payment_link", "followups", "crm", "smart_followups", "automations", "mercado_pago"] });
const free = { ...trial(null), tier: "free", has_pro_access: false, capabilities: ["manual_patients", "manual_appointments", "manual_payments", "patient_notes", "public_booking", "external_payment_link"] };
const pro = { ...trial(null), tier: "pro", plan_code: "pro", pro_started_at: "2026-11-01T15:00:00Z", pro_ends_at: "2026-12-02T03:00:00Z" };

test("las capacidades salen solo de lo que respondió el servidor", () => {
  assert.equal(hasCapability(trial(20), "mercado_pago"), true);
  assert.equal(hasCapability(free, "mercado_pago"), false);
  assert.equal(hasCapability(free, "automations"), false);
  assert.equal(hasCapability(free, "smart_followups"), false);
  // Free es la operación básica: agenda, pacientes, cobros manuales, notas, página pública y link de pago.
  for (const capability of ["manual_patients", "manual_appointments", "manual_payments", "patient_notes", "public_booking", "external_payment_link"]) assert.equal(hasCapability(free, capability), true, capability);
  // Seguimientos y CRM no son de Free: ni crear seguimientos ni las señales que agrupan pacientes.
  for (const capability of ["followups", "crm", "smart_followups", "automations", "mercado_pago"]) assert.equal(hasCapability(free, capability), false, capability);
  assert.equal(hasCapability(free, "manual_followups"), false);
  // La prueba y Pro tienen todo.
  for (const access of [trial(20), pro]) for (const capability of ["followups", "crm", "smart_followups", "automations", "mercado_pago", "patient_notes"]) assert.equal(hasCapability(access, capability), true, capability);
  // Sin respuesta (cargando o falló): nada de Pro se ofrece.
  assert.equal(hasCapability(null, "mercado_pago"), false);
  assert.equal(hasCapability(undefined, "manual_patients"), false);
  // El plan guardado no decide: una prueba tiene plan_code free y acceso Pro.
  assert.equal(trial(20).plan_code, "free");
});

test("aviso durante la prueba: días restantes y fecha, sin urgencia", () => {
  const long = planNotice(trial(18));
  assert.equal(long.title, "Estás probando Bellis Pro gratis.");
  assert.equal(long.text, "Te quedan 18 días de Bellis Pro. Tu prueba termina el 14/11.");
  assert.equal(long.dismissible, false);
  assert.equal(planNotice(trial(7)).title, "Te quedan 7 días de Bellis Pro.");
  assert.match(planNotice(trial(7)).text, /Tu prueba termina el 14\/11\. Después podés seguir usando Bellis Free sin costo\./);
  assert.equal(planNotice(trial(3)).title, "Tu prueba de Bellis Pro termina pronto.");
  assert.match(planNotice(trial(3)).text, /^Te quedan 3 días de Bellis Pro\./);
  assert.equal(planNotice(trial(1)).title, "Tu prueba termina mañana.");
  assert.equal(planNotice(trial(1)).text, "Después podés seguir usando Bellis Free.");
  assert.equal(planNotice(trial(0)).title, "Tu prueba termina hoy.");
  for (const days of [30, 18, 7, 3, 1, 0]) {
    const notice = planNotice(trial(days));
    assert.doesNotMatch(notice.title + " " + notice.text, /urgente|últim[ao]s? hora|perd|venc|trial|\d+ ?(hs|horas|minutos)/i, String(days));
  }
  // Quien cobra con Mercado Pago se entera antes de qué va a cambiar.
  assert.match(planNotice(trial(3), { usesMercadoPago: true }).text, /las reservas online con Mercado Pago se pausan\. Podés seguir recibiéndolas con un link de pago\./);
  assert.doesNotMatch(planNotice(trial(18), { usesMercadoPago: true }).text, /pausan/);
});

test("una sola tarjeta del plan: prueba terminada una vez, después Bellis Free; Pro sin venta", () => {
  const ended = planNotice(free);
  assert.equal(ended.title, "Tu prueba de Bellis Pro terminó.");
  assert.equal(ended.text, "Podés seguir usando Bellis Free sin costo. Tus pacientes, turnos e historial siguen acá.");
  assert.equal(ended.dismissible, true);
  assert.doesNotMatch(ended.title + " " + ended.text, /cuenta vencida|acceso vencido|suscripción|cancelad/i);
  // Leído el aviso, la tarjeta queda en una línea con el plan. Igual para una cuenta que nunca tuvo prueba.
  const quiet = planNotice(free, { endedSeen: true });
  assert.equal(quiet.kind, "free");
  assert.equal(quiet.title, "Usás Bellis Free.");
  assert.equal(quiet.dismissible, false);
  assert.doesNotMatch(quiet.title + " " + quiet.text, /bloquead|limitad|perd|venc/i);
  assert.equal(planNotice({ ...free, trial_started_at: null, trial_ends_at: null, trial_last_day: null }).kind, "free");
  // Pro: estado y vigencia, nada más.
  assert.equal(planNotice(pro).kind, "pro");
  assert.equal(planNotice(pro).title, "Tenés Bellis Pro activo.");
  assert.equal(planNotice(pro).text, "Vigente hasta el 01/12.");
  // Sin respuesta del servidor no se afirma ningún plan.
  assert.equal(planNotice(null), null);
  // "Entendido" vale para ese aviso; si el plan cambia, es otro.
  assert.notEqual(planNoticeKey(free), planNoticeKey(trial(5)));
  assert.notEqual(planNoticeKey(free), planNoticeKey(pro));
});

test("página Bellis Pro: estado según el plan, precio y solo beneficios que existen", () => {
  assert.equal(planStatus(trial(12)).title, "Estás probando Bellis Pro.");
  assert.equal(planStatus(trial(12)).detail, "Te quedan 12 días de Bellis Pro. Tu prueba termina el 14/11. Sin tarjeta.");
  assert.equal(planStatus(free).title, "Actualmente usás Bellis Free.");
  assert.equal(planStatus(pro).title, "Tenés Bellis Pro activo.");
  // Pro termina a las 00:00 del 2/12 en Argentina: vale hasta el 1/12.
  assert.equal(planStatus(pro).detail, "Vigente hasta el 01/12.");
  assert.equal(lastDayOf("2026-11-15T03:00:00Z"), "14/11");
  assert.equal(shortDay("2026-11-14"), "14/11");
  assert.equal(proPrice, "ARS 39.900 / mes");
  assert.deepEqual(proBenefits.map((item) => item.title), ["Seguimientos y CRM", "Automatizaciones", "Mercado Pago integrado"]);
  // Lo que se dice de Free ya no incluye seguimientos.
  assert.doesNotMatch(freeSummary, /seguimiento/i);
  assert.match(freeSummary, /agenda, pacientes, turnos y cobros manuales, notas/);
  assert.doesNotMatch(JSON.stringify([proBenefits, proLockCopy]), /recordatorio|whatsapp|email|mi semana|métrica|obra social/i);
});

test("Quiero Bellis Pro: pedido recibido, pedido repetido y errores legibles", () => {
  assert.equal(upgradeRequestMessage({ created: true }), "Recibimos tu pedido. Te vamos a escribir para activar Bellis Pro.");
  assert.equal(upgradeRequestMessage({ created: false }), "Ya recibimos tu pedido. Te vamos a escribir para activar Bellis Pro.");
  assert.match(describeUpgradeError("not_authorized"), /administra/);
  assert.match(describeUpgradeError("TypeError: Failed to fetch"), /conexión/);
  assert.equal(describeUpgradeError('relation "x" does not exist'), "No pudimos enviar tu pedido. Intentá de nuevo.");
});

test("reservas online en pausa: solo en Free con Mercado Pago como medio", () => {
  assert.equal(bookingsPaused(free, "mercado_pago_ar"), true);
  // Con link de pago externo, Free sigue recibiendo reservas.
  assert.equal(bookingsPaused(free, "external_link"), false);
  assert.equal(bookingsPaused(trial(10), "mercado_pago_ar"), false);
  assert.equal(bookingsPaused(pro, "mercado_pago_ar"), false);
  assert.equal(bookingsPaused(null, "mercado_pago_ar"), false);
  assert.equal(bookingsPausedCopy.title, "Tus reservas online están en pausa");
  assert.match(bookingsPausedCopy.text, /Tu conexión y tus pagos anteriores quedan guardados\./);
  assert.equal(proLockCopy.mercado_pago.title, "Mercado Pago integrado");
  assert.equal(proLockCopy.automations.title, "Automatizaciones es parte de Bellis Pro");
});

// Las secciones de la navegación, en orden. Las tres que dependen del plan están después de las cuatro pestañas del móvil.
const sections = ["Resumen", "Agenda", "Pacientes", "Servicios", "Disponibilidad", "Perfil", "Seguimientos", "Automatizaciones", "Notificaciones", "Formularios", "Bellis Pro"];
const shown = (access) => sections.filter((name) => navEntry(name, access) !== "hidden" && navEntry(name, access) !== "pending");
const entries = (access) => Object.fromEntries(planSections.map((name) => [name, navEntry(name, access)]));

test("navegación en Free: Seguimientos y Automatizaciones con candado, sin Notificaciones y sin campana", () => {
  assert.deepEqual(entries(free), { Seguimientos: "locked", Automatizaciones: "locked", Notificaciones: "hidden" });
  assert.equal(shown(free).includes("Notificaciones"), false);
  assert.equal(showsNotificationBell(free), false);
  // Lo demás es igual en cualquier plan.
  for (const name of ["Resumen", "Agenda", "Pacientes", "Servicios", "Disponibilidad", "Perfil", "Formularios", "Bellis Pro"]) assert.equal(navEntry(name, free), "open", name);
  assert.equal(proLockCopy.notifications.title, "Notificaciones es parte de Bellis Pro");
  assert.equal(proLockCopy.followups.title, "Seguimientos es parte de Bellis Pro");
  assert.equal(proLockCopy.followups.text, "Llevá un control de los pacientes que necesitan atención y qué tenés que revisar después.");
  assert.equal(proLockCopy.automations.text, "Automatizá tareas repetitivas y reducí trabajo manual en tu práctica.");
  assert.doesNotMatch(JSON.stringify(proLockCopy), /recordatorio|whatsapp|email/i);
});

test("navegación con prueba o con Pro: todo abierto, Notificaciones visible y campana visible", () => {
  for (const access of [trial(12), pro]) {
    assert.deepEqual(entries(access), { Seguimientos: "open", Automatizaciones: "open", Notificaciones: "open" });
    assert.deepEqual(shown(access), sections);
    assert.equal(showsNotificationBell(access), true);
  }
});

test("navegación mientras el plan no está resuelto: nada que dependa del plan se muestra, ni como Pro ni como Free", () => {
  // undefined = todavía cargando. Las tres secciones ocupan su lugar sin decir nada; la campana no aparece.
  assert.deepEqual(entries(undefined), { Seguimientos: "pending", Automatizaciones: "pending", Notificaciones: "pending" });
  assert.equal(shown(undefined).includes("Notificaciones"), false);
  assert.equal(showsNotificationBell(undefined), false);
  // Lo común a todos los planes sí está, desde el primer momento.
  assert.deepEqual(shown(undefined), ["Resumen", "Agenda", "Pacientes", "Servicios", "Disponibilidad", "Perfil", "Formularios", "Bellis Pro"]);
  // null = se consultó y no se pudo leer. No es "cargando": se trata como sin Pro, de forma estable.
  assert.deepEqual(entries(null), { Seguimientos: "locked", Automatizaciones: "locked", Notificaciones: "hidden" });
  assert.equal(showsNotificationBell(null), false);
});

test("al cargar, un workspace Free nunca ve pasar algo de Pro, y uno Pro nunca ve pasar un candado", () => {
  // Lo que se ve en cada momento de una carga: primero sin resolver, después la respuesta del servidor.
  const frames = (access) => [undefined, access].map((moment) => ({ entries: entries(moment), bell: showsNotificationBell(moment) }));
  for (const frame of frames(free)) {
    assert.notEqual(frame.entries.Notificaciones, "open");
    assert.notEqual(frame.entries.Seguimientos, "open");
    assert.notEqual(frame.entries.Automatizaciones, "open");
    assert.equal(frame.bell, false);
  }
  for (const access of [trial(12), pro]) for (const frame of frames(access)) {
    assert.notEqual(frame.entries.Seguimientos, "locked");
    assert.notEqual(frame.entries.Automatizaciones, "locked");
    assert.notEqual(frame.entries.Notificaciones, "hidden");
  }
});

test("los accesos de ejemplo de la demo tienen la forma de los del servidor", () => {
  const t = exampleAccess("pro_trial", "2026-10-03");
  assert.equal(t.tier, "pro_trial");
  assert.equal(t.trial_days_remaining, 18);
  assert.equal(t.trial_last_day, "2026-10-21");
  assert.equal(hasCapability(t, "automations"), true);
  const f = exampleAccess("free", "2026-10-03");
  assert.equal(hasCapability(f, "mercado_pago"), false);
  assert.equal(planNotice(f).kind, "trial_ended");
  const p = exampleAccess("pro", "2026-10-03");
  assert.equal(planNotice(p).kind, "pro");
  assert.equal(planStatus(p).title, "Tenés Bellis Pro activo.");
});
