import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { actorLine, addToDay, argentinaDay, dayLabel, describePlanError, downgradeCopy, downgradeTrialNote, lastDayProblem, lastValidDayOf, mercadoPagoKeptCopy, periodBase, planActions,
  planChangeLabel, planChangeNotice, planDialogCopy, planShortcuts, proEndsAtForLastDay, requestActions, requestNotice, resolutionLabel } from "../lib/admin-plans.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// 13/10/2026 a las 15:00 de Argentina.
const now = new Date("2026-10-13T18:00:00Z");

test("fechas: un plan se carga por su último día en Argentina y se guarda como el primer instante en que ya no vale", () => {
  assert.equal(argentinaDay(now), "2026-10-13");
  // De noche en Argentina ya es el día siguiente en UTC: el día sigue siendo el de Argentina.
  assert.equal(argentinaDay("2026-10-14T01:30:00Z"), "2026-10-13");
  assert.equal(argentinaDay("2026-10-14T03:00:00Z"), "2026-10-14");
  // "Pro hasta el 30/11" incluye el 30: termina a las 00:00 del 1/12 en Argentina, que son las 03:00 UTC.
  assert.equal(proEndsAtForLastDay("2026-11-30"), "2026-12-01T03:00:00.000Z");
  assert.equal(lastValidDayOf("2026-12-01T03:00:00.000Z"), "2026-11-30");
  for (const day of ["2026-10-13", "2026-12-31", "2028-02-29"]) assert.equal(lastValidDayOf(proEndsAtForLastDay(day)), day);
  assert.equal(proEndsAtForLastDay("2026-02-30"), null);
  assert.equal(proEndsAtForLastDay("mañana"), null);
  assert.equal(lastValidDayOf(null), null);
  assert.equal(dayLabel("2026-11-30"), "30/11/2026");
  assert.equal(dayLabel(null), "—");
});

test("atajos: 30 días, 3, 6 y 12 meses, contados por calendario", () => {
  assert.deepEqual(planShortcuts.map((item) => item.label), ["30 días", "3 meses", "6 meses", "12 meses"]);
  assert.equal(addToDay("2026-10-13", { days: 30 }), "2026-11-12");
  assert.equal(addToDay("2026-10-13", { months: 3 }), "2027-01-13");
  assert.equal(addToDay("2026-10-13", { months: 6 }), "2027-04-13");
  assert.equal(addToDay("2026-10-13", { months: 12 }), "2027-10-13");
  // Un día que no existe en el mes de destino cae en el último día de ese mes.
  assert.equal(addToDay("2026-11-30", { months: 3 }), "2027-02-28");
  assert.equal(addToDay("2027-08-31", { months: 6 }), "2028-02-29");
  assert.equal(addToDay("2026-12-31", { days: 30 }), "2027-01-30");
});

test("extender cuenta desde el vencimiento vigente, no desde hoy; activar cuenta desde hoy", () => {
  const pro = { effective_tier: "pro", pro_ends_at: proEndsAtForLastDay("2026-11-30") };
  assert.equal(periodBase("extend", pro, now), "2026-11-30");
  assert.equal(addToDay(periodBase("extend", pro, now), { days: 30 }), "2026-12-30");
  assert.equal(addToDay(periodBase("extend", pro, now), { months: 12 }), "2027-11-30");
  // Vence hoy: todavía cuenta desde su vencimiento.
  assert.equal(periodBase("extend", { effective_tier: "pro", pro_ends_at: proEndsAtForLastDay("2026-10-13") }, now), "2026-10-13");
  // Un Pro que ya venció, o un consultorio que no es Pro, cuenta desde hoy.
  assert.equal(periodBase("extend", { effective_tier: "free", pro_ends_at: proEndsAtForLastDay("2026-09-30") }, now), "2026-10-13");
  assert.equal(periodBase("activate", pro, now), "2026-10-13");
  assert.equal(periodBase("activate", { effective_tier: "pro_trial", pro_ends_at: null }, now), "2026-10-13");
});

test("la fecha se valida igual que en el servidor: futura, razonable y, al extender, posterior a la vigente", () => {
  const free = { effective_tier: "free", pro_ends_at: null }; const pro = { effective_tier: "pro", pro_ends_at: proEndsAtForLastDay("2026-11-30") };
  assert.equal(lastDayProblem("activate", "2026-11-12", free, now), null);
  assert.equal(lastDayProblem("activate", "2026-10-13", free, now), null);
  assert.equal(lastDayProblem("activate", "2026-10-12", free, now), "La fecha tiene que ser de hoy en adelante.");
  assert.equal(lastDayProblem("activate", "", free, now), "Elegí una fecha.");
  assert.equal(lastDayProblem("activate", "2029-10-14", free, now), "La fecha no puede estar a más de tres años.");
  assert.equal(lastDayProblem("extend", "2026-12-30", pro, now), null);
  assert.equal(lastDayProblem("extend", "2026-11-30", pro, now), "La nueva fecha tiene que ser posterior al vencimiento actual (30/11/2026).");
  assert.equal(lastDayProblem("extend", "2026-11-15", pro, now), "La nueva fecha tiene que ser posterior al vencimiento actual (30/11/2026).");
});

test("acciones: solo el rol admin, y cada plan ofrece las suyas", () => {
  assert.deepEqual(planActions({ effective_tier: "free" }, "admin"), ["activate"]);
  assert.deepEqual(planActions({ effective_tier: "pro_trial" }, "admin"), ["activate"]);
  assert.deepEqual(planActions({ effective_tier: "pro" }, "admin"), ["extend", "downgrade"]);
  // Soporte lee: no se le ofrece ninguna acción. Tampoco a un rol desconocido o ausente.
  for (const role of ["support", null, undefined, "owner"]) for (const tier of ["free", "pro_trial", "pro"]) assert.deepEqual(planActions({ effective_tier: tier }, role), [], `${role} ${tier}`);
  assert.deepEqual(requestActions({ status: "open" }, "admin"), ["activate", "resolve", "dismiss"]);
  assert.deepEqual(requestActions({ status: "resolved" }, "admin"), []);
  assert.deepEqual(requestActions({ status: "dismissed" }, "admin"), []);
  assert.deepEqual(requestActions({ status: "open" }, "support"), []);
  assert.deepEqual(requestActions({ status: "open" }, null), []);
});

test("textos de los modales y de las confirmaciones", () => {
  assert.deepEqual(planDialogCopy.activate, { title: "Activar Bellis Pro", cta: "Activar Bellis Pro" });
  assert.equal(planDialogCopy.extend.title, "Extender Bellis Pro");
  assert.deepEqual(planDialogCopy.downgrade, { title: "Volver a Bellis Free", cta: "Pasar a Bellis Free" });
  assert.equal(downgradeCopy, "El consultorio conservará sus pacientes, turnos, seguimientos, historial y configuración. Las funciones Pro quedarán bloqueadas.");
  assert.match(mercadoPagoKeptCopy, /La conexión de Mercado Pago se conserva/);
  const ends = proEndsAtForLastDay("2026-11-12");
  assert.equal(planChangeNotice({ action: "pro_activated", pro_ends_at: ends, effective_tier: "pro" }), "Bellis Pro quedó activo hasta el 12/11/2026.");
  assert.equal(planChangeNotice({ action: "pro_extended", pro_ends_at: ends, effective_tier: "pro" }), "Bellis Pro quedó extendido hasta el 12/11/2026.");
  assert.equal(planChangeNotice({ action: "downgraded_to_free", pro_ends_at: ends, effective_tier: "free" }), "El consultorio pasó a Bellis Free.");
  // "Volver a Free" es Free: la confirmación no habla de ninguna prueba que siga.
  assert.doesNotMatch(planChangeNotice({ action: "downgraded_to_free", pro_ends_at: ends, effective_tier: "free" }), /prueba/i);
  assert.equal(planChangeNotice({ action: "unchanged", pro_ends_at: ends, effective_tier: "pro" }), "No hubo cambios: el plan ya estaba así.");
  // Si la prueba seguía vigente, el modal avisa antes de confirmar que también termina.
  assert.equal(downgradeTrialNote({ trial_ends_at: proEndsAtForLastDay("2026-11-11") }, now), "Su prueba de Bellis Pro, que seguía vigente hasta el 11/11/2026, también termina ahora. El consultorio queda en Bellis Free desde este momento.");
  assert.equal(downgradeTrialNote({ trial_ends_at: proEndsAtForLastDay("2026-10-01") }, now), null);
  assert.equal(downgradeTrialNote({ trial_ends_at: null }, now), null);
  assert.equal(requestNotice("activate", ends), "Bellis Pro quedó activo hasta el 12/11/2026. La solicitud quedó resuelta.");
  assert.equal(requestNotice("resolve", null), "La solicitud quedó resuelta, sin cambiar el plan.");
  assert.equal(requestNotice("dismiss", null), "La solicitud quedó descartada.");
});

test("errores del servidor en palabras, y nunca el texto crudo de uno desconocido", () => {
  assert.equal(describePlanError("pro_ends_at_required"), "Elegí una fecha de hoy en adelante.");
  assert.equal(describePlanError("pro_end_not_extended"), "La nueva fecha tiene que ser posterior al vencimiento actual.");
  assert.equal(describePlanError("request_not_open"), "Esta solicitud ya fue cerrada. Actualizá la página para ver su estado.");
  for (const raw of ["duplicate key value violates unique constraint \"x\"", "permission denied for table workspaces", "", null, undefined, "not_found"])
    assert.equal(describePlanError(raw), "No pudimos guardar el cambio. Probá de nuevo.");
});

test("historial comercial y estado de una solicitud", () => {
  const ends = proEndsAtForLastDay("2026-11-12");
  const trial = proEndsAtForLastDay("2026-11-01");
  assert.equal(planChangeLabel({ action: "pro_activated", new_pro_ends_at: ends, previous_trial_ends_at: trial, new_trial_ends_at: trial }), "Bellis Pro activado hasta el 12/11/2026");
  assert.equal(planChangeLabel({ action: "pro_extended", new_pro_ends_at: ends, previous_trial_ends_at: null, new_trial_ends_at: null }), "Bellis Pro extendido hasta el 12/11/2026");
  assert.equal(planChangeLabel({ action: "downgraded_to_free", new_pro_ends_at: ends, previous_trial_ends_at: null, new_trial_ends_at: null }), "Pasó a Bellis Free");
  assert.equal(planChangeLabel({ action: "downgraded_to_free", new_pro_ends_at: ends, previous_trial_ends_at: trial, new_trial_ends_at: trial }), "Pasó a Bellis Free");
  // La prueba seguía vigente y se cortó con el cambio.
  assert.equal(planChangeLabel({ action: "downgraded_to_free", new_pro_ends_at: ends, previous_trial_ends_at: trial, new_trial_ends_at: "2026-10-13T18:00:00.000Z" }), "Pasó a Bellis Free (la prueba terminó con el cambio)");
  assert.equal(planChangeLabel({ action: "upgrade_request_dismissed", new_pro_ends_at: null, previous_trial_ends_at: null, new_trial_ends_at: null }), "Solicitud de Pro descartada");
  // Quién lo hizo, como lo nombra el servidor. Nunca un id.
  assert.equal(actorLine({ actor_label: "Vos" }), "Por Vos");
  assert.equal(actorLine({ actor_label: "equipo@ejemplo.com" }), "Por equipo@ejemplo.com");
  assert.equal(actorLine({ actor_label: "" }), "Por alguien del equipo");
  assert.equal(actorLine({}), "Por alguien del equipo");
  assert.equal(resolutionLabel({ status: "open", resolution: null }), "Abierta");
  assert.equal(resolutionLabel({ status: "resolved", resolution: "pro_activated" }), "Resuelta: se activó Bellis Pro");
  assert.equal(resolutionLabel({ status: "resolved", resolution: "upgrade_request_resolved" }), "Resuelta sin activar");
  assert.equal(resolutionLabel({ status: "dismissed", resolution: "upgrade_request_dismissed" }), "Descartada");
});

// ===== Leído del código =====
const sql = read("supabase/migrations/20261018090000_admin_commercial_actions.sql");
const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
const body = (name) => code.split(`create function ${name}(`)[1]?.split("end $$;")[0] ?? "";

test("servidor: cambiar un plan o cerrar un pedido exige el rol admin; leer, cualquier rol del equipo", () => {
  for (const name of ["private.admin_change_workspace_plan", "private.admin_resolve_upgrade_request"])
    assert.match(body(name), /begin\s+perform private\.require_bellis_admin_role\('admin'\);/, `${name} no exige admin antes que nada`);
  for (const name of ["private.admin_upgrade_requests", "private.admin_plan_changes"]) assert.match(body(name), /perform private\.require_bellis_admin\(\);/, `${name} no valida`);
  // El cambio de plan lo sigue haciendo la función de H2.7. Lo único que esta migración escribe en workspaces es el
  // fin de una prueba vigente al volver a Free, y después exige que el resultado sea Free o no confirma nada.
  const change = body("private.admin_change_workspace_plan");
  assert.match(change, /private\.admin_set_workspace_plan\(p_workspace,p_target_plan,p_pro_ends_at\)/);
  assert.deepEqual([...code.matchAll(/update public\.workspaces set ([a-z_]+)=/g)].map((match) => match[1]), ["trial_ends_at"]);
  assert.match(change, /if p_target_plan='free' then\s+update public\.workspaces set trial_ends_at=greatest\(now\(\),trial_started_at \+ interval '1 microsecond'\),plan_updated_at=now\(\)\s+where id=p_workspace and trial_ends_at > now\(\);/);
  assert.match(change, /if private\.workspace_tier\(p_workspace\) <> 'free' then raise exception 'downgrade_incomplete'; end if;/);
  assert.doesNotMatch(code, /trial_started_at\s*=/);
  assert.doesNotMatch(code, /delete from/);
  // Un cambio hecho a mano no se anota como vencimiento: el registro lo distingue por la auditoría.
  const expirations = code.split("create or replace function private.record_plan_expirations()")[1];
  for (const column of ["trial", "pro"]) assert.match(expirations, new RegExp(String.raw`a\.action='downgraded_to_free'\s+and a\.new_${column}_ends_at=w\.${column}_ends_at and a\.previous_${column}_ends_at is distinct from a\.new_${column}_ends_at`), column);
  assert.equal([...expirations.matchAll(/on conflict do nothing;/g)].length, 2);
  assert.match(code, /revoke all on function private\.record_plan_expirations\(\) from public,anon,authenticated;/);
  // Las funciones públicas son envoltorios sin privilegios propios, y anon no las ejecuta.
  for (const name of ["admin_set_workspace_plan", "admin_resolve_upgrade_request", "admin_upgrade_requests", "admin_plan_changes"]) {
    assert.match(code, new RegExp(`create function public\\.${name}\\([^$]*security invoker`), `public.${name} no es security invoker`);
    assert.match(code, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public,anon;`), `public.${name} queda abierta a anon`);
  }
  // La función de H2.7 sigue sin estar al alcance de la API, y nadie queda cargado como admin.
  assert.doesNotMatch(code, /grant[^;]*private\.admin_set_workspace_plan\(uuid,text,timestamptz,timestamptz\)/);
  assert.doesNotMatch(code, /insert into private\.bellis_admins/);
  assert.doesNotMatch(code, /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
});

test("servidor: la auditoría guarda estados y fechas, no datos personales", () => {
  const table = code.split("create table public.plan_change_audit (")[1].split(");")[0];
  for (const column of ["workspace_id", "actor_admin_user_id", "previous_effective_tier", "previous_plan_code", "new_plan_code", "previous_pro_ends_at", "new_pro_ends_at", "action", "created_at"]) assert.match(table, new RegExp(`\\b${column}\\b`), column);
  for (const action of ["pro_activated", "pro_extended", "downgraded_to_free", "upgrade_request_resolved", "upgrade_request_dismissed"]) assert.match(table, new RegExp(`'${action}'`), action);
  for (const column of ["previous_trial_ends_at", "new_trial_ends_at"]) assert.match(table, new RegExp(`\\b${column}\\b`), column);
  assert.doesNotMatch(table, /email|name|phone|note/i);
  // Quién fue se nombra al leer, desde auth.users y solo dentro de la función del backoffice: "Vos" o el email del admin.
  const changes = body("private.admin_plan_changes");
  assert.match(changes, /perform private\.require_bellis_admin\(\);/);
  assert.match(changes, /'actor_label',case when a\.actor_admin_user_id=\(select auth\.uid\(\)\) then 'Vos'/);
  assert.match(changes, /select u\.email::text from auth\.users u where u\.id=a\.actor_admin_user_id/);
  assert.doesNotMatch(changes, /'actor_admin_user_id'/);
  assert.doesNotMatch(code, /grant[^;]*auth\.users/);
  assert.match(read("components/admin/AdminPlans.tsx"), /\{actorLine\(change\)\}/);
  assert.match(code, /revoke all on public\.plan_change_audit from public,anon,authenticated,service_role;/);
  // La lista de pedidos no devuelve el email de contacto guardado en el pedido.
  assert.doesNotMatch(code, /contact_email/);
});

test("pantallas: las acciones pasan por las funciones admin y los botones dependen del rol", () => {
  const detail = read("app/admin/workspaces/[id]/page.tsx"); const upgrades = read("app/admin/upgrades/page.tsx"); const plans = read("components/admin/AdminPlans.tsx");
  assert.match(detail, /adminRpc<PlanChangeResult>\("admin_set_workspace_plan", \{ p_workspace: id, p_target_plan: dialog === "downgrade" \? "free" : "pro", p_pro_ends_at: proEndsAt \}\)/);
  assert.match(upgrades, /adminRpc\("admin_resolve_upgrade_request", \{ p_request: acting\.request\.request_id, p_action: acting\.action, p_pro_ends_at: proEndsAt \}\)/);
  for (const file of [detail, upgrades, plans]) assert.doesNotMatch(file, /\.from\(|\.update\(|\.insert\(|\.delete\(/);
  // Los botones salen de planActions / requestActions, que no devuelven nada para soporte.
  assert.match(plans, /const actions = planActions\(d, role\)/);
  assert.match(plans, /const actions = requestActions\(row, role\)/);
  assert.match(plans, /actions\.length > 0 \? <div className="bo-actions">/);
  assert.match(plans, /\{actions\.length > 0 && <div className="bo-actions">/);
  // Los modales: título propio, último día elegible, y la aclaración de dónde se cuenta al extender.
  assert.match(plans, /role="dialog" aria-modal="true"/);
  assert.match(plans, /Se cuenta desde el vencimiento actual, no desde hoy/);
  assert.match(plans, /<dt>Actual<\/dt>/); assert.match(plans, /"Nuevo vencimiento"/);
});

test("la demo simula las acciones en memoria, sin conectarse a nada", () => {
  for (const file of ["app/demo/admin/page.tsx", "app/demo/admin/admin-data.ts"]) assert.doesNotMatch(read(file), /lib\/supabase|getSupabase|adminRpc|AdminGate|\.rpc\(|fetch\(/, `${file} se conecta`);
  const page = read("app/demo/admin/page.tsx");
  for (const used of ["demoChangePlan", "demoResolveRequest", "PlanDialog", "RequestDialog", "PlanCommercialPanel", "UpgradeRequestsView"]) assert.match(page, new RegExp(used), used);
  assert.match(page, /los cambios de plan se simulan y se pierden al recargar/);
});
