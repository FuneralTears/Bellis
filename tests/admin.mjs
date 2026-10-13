import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { activeFilterCount, activityLine, adminDate, adminGateState, classifyAdminRpc, classifyAuthUser, adminDateTime, adminPageSize, bookingLine, daysAgo, daysRemainingLabel, defaultWorkspaceFilters, eventKind, eventLabel,
  isAdminDenied, lastValidDay, pageCount, planLine, share, shownCapabilities, signInLine, workspaceQuery } from "../lib/admin.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("filtros de la lista: 'todos' no filtra y cada filtro llega al servidor con su nombre", () => {
  assert.deepEqual(workspaceQuery(defaultWorkspaceFilters), { p_search: null, p_onboarding: null, p_tier: null, p_active: null,
    p_upgrade_requested: false, p_booking_paused: false, p_sort: "newest", p_limit: adminPageSize, p_offset: 0 });
  const filters = { search: "  ana  ", onboarding: "complete", tier: "pro_trial", active: "7d", upgradeRequested: true, bookingPaused: true, sort: "trial_ending" };
  assert.deepEqual(workspaceQuery(filters, 2), { p_search: "ana", p_onboarding: "complete", p_tier: "pro_trial", p_active: "7d",
    p_upgrade_requested: true, p_booking_paused: true, p_sort: "trial_ending", p_limit: 25, p_offset: 50 });
  assert.equal(workspaceQuery(defaultWorkspaceFilters, -3).p_offset, 0);
  assert.equal(activeFilterCount(defaultWorkspaceFilters), 0);
  assert.equal(activeFilterCount(filters), 6);
  // El orden no cuenta como filtro.
  assert.equal(activeFilterCount({ ...defaultWorkspaceFilters, sort: "most_active" }), 0);
  assert.equal(pageCount(0), 1); assert.equal(pageCount(25), 1); assert.equal(pageCount(26), 2);
});

test("eventos: dicen qué pasó y de dónde vino, nunca quién es el paciente", () => {
  assert.equal(eventLabel({ event_name: "patient_created", metadata: { source: "manual" } }), "Paciente nuevo, cargado a mano");
  assert.equal(eventLabel({ event_name: "patient_created", metadata: { source: "public" } }), "Paciente nuevo, desde la página pública");
  assert.equal(eventLabel({ event_name: "followup_created", metadata: { source: "automation" } }), "Seguimiento nuevo, creado por una automatización");
  assert.equal(eventLabel({ event_name: "public_booking_completed", metadata: {} }), "Reserva pública completada");
  assert.equal(eventLabel({ event_name: "upgrade_requested", metadata: { plan: "pro" } }), "Pidió Bellis Pro");
  // Un valor desconocido en metadata no se muestra tal cual.
  assert.equal(eventLabel({ event_name: "patient_created", metadata: { source: "Juan Pérez", name: "Juan Pérez" } }), "Paciente nuevo");
  assert.equal(eventLabel({ event_name: "algo_nuevo", metadata: {} }), "Evento");
  // Las acciones que también cuentan como uso: cobros, turnos atendidos o cancelados, notas.
  assert.equal(eventLabel({ event_name: "payment_recorded", metadata: { provider: "offline" } }), "Cobro registrado, cargado a mano");
  assert.equal(eventLabel({ event_name: "payment_recorded", metadata: { provider: "mercado_pago_ar" } }), "Cobro registrado, por Mercado Pago");
  assert.equal(eventLabel({ event_name: "payment_recorded", metadata: { provider: "other", amount_minor: 2500000 } }), "Cobro registrado");
  assert.equal(eventLabel({ event_name: "appointment_completed", metadata: {} }), "Turno atendido");
  assert.equal(eventLabel({ event_name: "appointment_cancelled", metadata: { reason: "no pudo venir" } }), "Turno cancelado");
  assert.equal(eventLabel({ event_name: "patient_note_created", metadata: { content: "texto de la nota" } }), "Nota de paciente nueva");
  for (const name of ["payment_recorded", "appointment_completed", "appointment_cancelled", "patient_note_created"]) assert.equal(eventKind(name), "usage");
  assert.equal(eventKind("patient_created"), "usage"); assert.equal(eventKind("trial_expired"), "plan"); assert.equal(eventKind("user_registered"), "account");
});

test("fechas en hora de Argentina y el último día de un plan", () => {
  // 03:00 UTC es la medianoche de Argentina: el plan vale hasta el día anterior inclusive.
  assert.equal(adminDate("2026-11-12T03:00:00+00:00"), "12/11/2026");
  assert.equal(lastValidDay("2026-11-12T03:00:00+00:00"), "11/11/2026");
  assert.equal(adminDateTime("2026-10-12T23:18:24+00:00"), "12/10/2026 20:18");
  assert.equal(adminDate(null), "—"); assert.equal(lastValidDay(null), "—");
  const now = new Date("2026-10-12T15:00:00Z");
  assert.equal(daysAgo("2026-10-12T12:00:00Z", now), "hoy");
  assert.equal(daysAgo("2026-10-11T12:00:00Z", now), "ayer");
  assert.equal(daysAgo("2026-10-02T12:00:00Z", now), "hace 10 días");
  assert.equal(daysAgo(null, now), "Sin actividad");
});

test("último acceso y última actividad son dos fechas distintas", () => {
  const now = new Date("2026-10-12T15:00:00Z");
  assert.equal(signInLine(null, now), "Sin ingresos todavía");
  assert.equal(signInLine("2026-10-11T12:00:00Z", now), "11/10/2026 (ayer)");
  assert.equal(activityLine(null, now), "Sin actividad todavía");
  assert.equal(activityLine("2026-10-02T12:00:00Z", now), "02/10/2026 (hace 10 días)");
  // La definición de "activo" vive en el servidor: incluye las cuatro acciones nuevas y nada comercial ni el login.
  const sql = read("supabase/migrations/20261017100000_product_events.sql");
  const activity = sql.split("create function private.product_activity_events()")[1].split("$$;")[0];
  for (const name of ["onboarding_completed", "patient_created", "appointment_created", "public_booking_completed", "followup_created", "automation_enabled",
    "payment_recorded", "appointment_completed", "appointment_cancelled", "patient_note_created"]) assert.match(activity, new RegExp(`'${name}'`), name);
  for (const name of ["user_registered", "trial_started", "trial_expired", "upgrade_requested", "pro_activated", "pro_expired", "workspace_suspended", "login", "sign_in"])
    assert.doesNotMatch(activity, new RegExp(`'${name}'`), name);
  // Iniciar sesión no es un evento: no existe con ese nombre y nada escucha a auth.users.
  assert.doesNotMatch(sql, /'(login|user_signed_in|sign_in)'/);
  assert.doesNotMatch(sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n"), /on auth\.users/);
  // El último acceso se lee de auth.users solo dentro de las funciones admin.
  const models = read("supabase/migrations/20261017110000_admin_read_models.sql");
  assert.match(models, /max\(u\.last_sign_in_at\)/);
  // La pantalla dice de quién es ese acceso: del equipo del espacio, no de una persona en particular.
  const ui = read("components/admin/AdminUi.tsx");
  assert.match(ui, /<th>Último acceso del equipo<\/th><th>Última actividad<\/th>/);
  assert.match(ui, /Inicio de sesión más reciente de una persona de este espacio\./);
  assert.equal(ui.split("Último acceso del equipo").length - 1, 4, "lista (encabezado y tarjeta), detalle y solicitudes Pro");
  assert.doesNotMatch(ui, /Último acceso(?! del equipo)/);
});

test("plan en una línea y días que quedan", () => {
  assert.equal(planLine({ effective_tier: "pro_trial", trial_ends_at: "2026-11-12T03:00:00+00:00", pro_ends_at: null, status: "active" }), "Prueba hasta el 11/11/2026");
  assert.equal(planLine({ effective_tier: "pro", trial_ends_at: null, pro_ends_at: "2026-12-01T03:00:00+00:00", status: "active" }), "Pro hasta el 30/11/2026");
  assert.equal(planLine({ effective_tier: "pro", trial_ends_at: null, pro_ends_at: null, status: "active" }), "Pro sin vencimiento");
  assert.equal(planLine({ effective_tier: "free", trial_ends_at: "2026-09-01T03:00:00+00:00", pro_ends_at: null, status: "active" }), "Prueba vencida el 31/08/2026");
  assert.equal(planLine({ effective_tier: "free", trial_ends_at: null, pro_ends_at: null, status: "active" }), "Sin prueba todavía");
  assert.equal(planLine({ effective_tier: "pro", trial_ends_at: null, pro_ends_at: null, status: "suspended" }), "Suspendida");
  assert.equal(daysRemainingLabel(0), "Último día"); assert.equal(daysRemainingLabel(1), "Queda 1 día");
  assert.equal(daysRemainingLabel(12), "Quedan 12 días"); assert.equal(daysRemainingLabel(null), null);
});

test("reservas online: disponible, en pausa y por qué", () => {
  const base = { onboarding_completed: true, status: "active", booking_available: false, payment_provider: "mercado_pago_ar", mercado_pago_connected: false, external_link_configured: false, effective_tier: "pro_trial" };
  assert.equal(bookingLine({ ...base, booking_available: true, mercado_pago_connected: true }), "Reservas online disponibles");
  assert.equal(bookingLine(base), "En pausa: Mercado Pago sin conectar");
  assert.equal(bookingLine({ ...base, effective_tier: "free", mercado_pago_connected: true }), "En pausa: Mercado Pago es parte de Bellis Pro");
  assert.equal(bookingLine({ ...base, payment_provider: "external_link" }), "En pausa: falta el link de pago");
  assert.equal(bookingLine({ ...base, onboarding_completed: false }), "Sin página pública: no terminó el onboarding");
  assert.equal(bookingLine({ ...base, status: "suspended" }), "Cuenta suspendida");
});

test("capacidades visibles, porcentajes y acceso denegado", () => {
  assert.deepEqual(shownCapabilities(["manual_patients", "followups", "reports", "marketing_tools"]), ["Pacientes", "Seguimientos"]);
  assert.equal(share(1, 4), "25%"); assert.equal(share(0, 0), "—");
  // Sin acceso y "no existe" se ven igual: los dos terminan en la página de no encontrado.
  assert.equal(isAdminDenied({ message: "not_found" }), true);
  assert.equal(isAdminDenied({ code: "42501", message: "permission denied for function admin_overview" }), true);
  assert.equal(isAdminDenied({ message: "Failed to fetch" }), false);
  assert.equal(isAdminDenied(null), false);
});

// ===== La puerta del backoffice =====
const user = { id: "9f31e5dc-0000-4000-8000-000000000000" };
const gate = (auth, rpc = "pending", role = null) => adminGateState({ auth, rpc, role });

test("puerta: mientras la sesión o la respuesta no llegaron, ni 404 ni acceso", () => {
  assert.equal(gate("pending"), "checking");
  assert.equal(gate("session_ready", "pending"), "checking");
  // Una sesión que tarda en aparecer y después resulta ser del equipo: primero espera, después entra.
  assert.deepEqual([gate("pending"), gate("session_ready", "pending"), gate("session_ready", "ok", "admin")], ["checking", "checking", "admin"]);
});

test("puerta: sin sesión o sin ser del equipo es 'no encontrado'; solo el servidor lo decide", () => {
  assert.equal(gate("no_session"), "denied");
  assert.equal(gate("session_ready", "denied"), "denied");
  // Una respuesta válida sin un rol conocido no abre nada.
  assert.equal(gate("session_ready", "ok", null), "denied");
  assert.equal(gate("session_ready", "ok", "owner"), "denied");
  assert.equal(gate("session_ready", "ok", "admin"), "admin");
  assert.equal(gate("session_ready", "ok", "support"), "support");
});

test("puerta: un error no es acceso y tampoco es 'no encontrado'", () => {
  assert.equal(gate("error"), "error");
  assert.equal(gate("session_ready", "error"), "error");
  assert.equal(gate("session_ready", "session"), "error");
  // Ningún estado que no sea una respuesta "ok" con rol del equipo deja pasar.
  for (const auth of ["pending", "session_ready", "no_session", "error"]) for (const rpc of ["pending", "denied", "session", "error"]) for (const role of [null, "admin", "support"])
    assert.equal(["admin", "support"].includes(adminGateState({ auth, rpc, role })), false, `${auth} ${rpc} ${role}`);
  for (const auth of ["pending", "no_session", "error"]) assert.equal(["admin", "support"].includes(adminGateState({ auth, rpc: "ok", role: "admin" })), false, auth);
});

test("puerta: qué significa cada respuesta de la sesión y de la RPC", () => {
  assert.equal(classifyAuthUser({ data: { user }, error: null }), "session_ready");
  assert.equal(classifyAuthUser({ data: { user: null }, error: null }), "no_session");
  assert.equal(classifyAuthUser({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" } }), "no_session");
  assert.equal(classifyAuthUser({ data: { user: null }, error: { name: "AuthApiError", status: 403, message: "invalid claim" } }), "no_session");
  // Sin red, o el servidor de auth no responde: no se sabe quién es. No es "nadie".
  assert.equal(classifyAuthUser({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" } }), "error");
  assert.equal(classifyAuthUser({ data: { user: null }, error: { name: "AuthApiError", status: 503, message: "unavailable" } }), "error");
  assert.equal(classifyAuthUser({ data: { user: null }, error: { name: "AuthApiError", status: 429, message: "rate limit" } }), "error");

  assert.equal(classifyAdminRpc(null), "ok");
  assert.equal(classifyAdminRpc({ code: "P0002", message: "not_found" }), "denied");
  assert.equal(classifyAdminRpc({ code: "42501", message: "permission denied for function bellis_admin_session" }), "denied");
  // Un token vencido no es "no sos del equipo": se renueva y se vuelve a preguntar.
  assert.equal(classifyAdminRpc({ code: "PGRST301", message: "JWT expired" }), "session");
  assert.equal(classifyAdminRpc({ code: "PGRST303", message: "JWT expired" }), "session");
  assert.equal(classifyAdminRpc({ message: "TypeError: Failed to fetch" }), "error");
  assert.equal(classifyAdminRpc({ code: "57014", message: "canceling statement due to statement timeout" }), "error");
  // Una función que el servidor no conoce es un error del entorno, no un "no encontrado" del backoffice.
  assert.equal(classifyAdminRpc({ code: "PGRST202", message: "Could not find the function public.bellis_admin_session without parameters in the schema cache" }), "error");
  assert.equal(isAdminDenied({ code: "PGRST301", message: "JWT expired" }), false);
});

test("puerta: usa la misma lectura de sesión que el resto del panel y no registra nada", () => {
  const source = read("app/admin/AdminGate.tsx");
  assert.match(source, /classifyAuthUser\(await client\.auth\.getUser\(\)\)/);
  assert.doesNotMatch(source, /getSession\(\)/);
  // Sin registro de depuración: ni en la puerta ni en lo que la rodea. El id del usuario ni siquiera se lee.
  for (const file of ["app/admin/AdminGate.tsx", "lib/admin.ts", "lib/supabase/browser.ts", "app/api/supabase-config/route.ts", "lib/supabase-target.ts", "components/admin/AdminUi.tsx"])
    assert.doesNotMatch(read(file), /console\.|bellis-admin\]|adminDebug|AdminGateTrace/, file);
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  assert.doesNotMatch(code, /email|access_token|refresh_token|headers|session\.user|user\.id/i);
  // La configuración que recibe el navegador vuelve a ser solo la dirección y la clave publicable.
  assert.match(read("app/api/supabase-config/route.ts"), /Response\.json\(\{ url, publishableKey \}, /);
  // El comportamiento es el mismo: en blanco mientras se resuelve, "no encontrado" si el servidor dijo que no,
  // mensaje con reintento ante un error, y una sola renovación del token.
  assert.match(source, /if \(state === "denied"\) notFound\(\);/);
  assert.match(source, /if \(state === "checking"\) return null;/);
  assert.match(source, /if \(state === "error"\) return <main[^]*Reintentar<\/button>/);
  assert.equal([...source.matchAll(/client\.auth\.refreshSession\(\)/g)].length, 1);
  assert.equal([...source.matchAll(/client\.rpc\("bellis_admin_session"\)/g)].length, 2);
});

// ===== Privacidad y seguridad, leídas del código =====
const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.startsWith("20261017")).sort();
const adminSql = migrations.map((name) => read(`supabase/migrations/${name}`)).join("\n");
// Sin comentarios: lo que se revisa es lo que el SQL hace, no cómo se explica.
const adminCode = adminSql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

test("el backoffice no lee contenido clínico", () => {
  for (const forbidden of ["questionnaire", "first_name", "last_name", "phone", "date_of_birth", "biography", "content", ".description", ".title", "amount_minor", "manual_reference", ".notes", ".email,"])
    assert.equal(adminCode.includes(forbidden), false, `las migraciones del backoffice mencionan ${forbidden}`);
  // De las notas se usa la fila (id, workspace, autor, fecha), nunca el texto: solo aparecen en el trigger y en su backfill.
  const noteLines = adminCode.split("\n").filter((line) => line.includes("patient_notes"));
  assert.deepEqual(noteLines.map((line) => line.trim()), ["create trigger product_event_patient_note after insert on public.patient_notes", "from public.patient_notes n;"]);
  assert.match(adminCode, /select 'patient_note_created',n\.workspace_id,n\.author_id,'patient_note',n\.id,'\{"backfilled":true\}',n\.created_at/);
  // De los seguimientos solo se cuentan filas y se guarda de dónde vinieron.
  assert.doesNotMatch(adminCode, /new\.(title|description|content|first_name|last_name|email|phone)/);
  // Ninguna pantalla del backoffice consulta tablas: solo llama a las funciones admin.
  const screens = ["app/admin/AdminGate.tsx", "app/admin/page.tsx", "app/admin/workspaces/page.tsx", "app/admin/workspaces/[id]/page.tsx", "app/admin/upgrades/page.tsx", "components/admin/AdminUi.tsx", "lib/admin.ts"];
  for (const file of screens) assert.doesNotMatch(read(file), /\.from\(/, `${file} consulta una tabla`);
  assert.deepEqual([...new Set(screens.flatMap((file) => [...read(file).matchAll(/(?:adminRpc<[^(]*|\.rpc)\("([a-z_]+)"/g)].map((match) => match[1])))].sort(),
    ["admin_overview", "admin_recent_activity", "admin_workspace_detail", "admin_workspaces", "bellis_admin_session"]);
});

test("toda función del backoffice valida a quien llama, y nadie queda cargado como admin en git", () => {
  for (const name of ["admin_overview", "admin_workspaces", "admin_workspace_detail", "admin_recent_activity", "bellis_admin_session"]) {
    const body = adminCode.split(`create function private.${name}(`)[1]?.split("end $$;")[0] ?? "";
    assert.match(body, /perform private\.require_bellis_admin\(\);/, `private.${name} no valida`);
    assert.match(adminCode, new RegExp(`create function public\\.${name}\\([^$]*security invoker`), `public.${name} no es security invoker`);
  }
  assert.doesNotMatch(adminCode, /insert into private\.bellis_admins/);
  assert.doesNotMatch(adminCode, /grant[^;]*bellis_admins[^;]*to/);
  // Todavía no hay acciones comerciales: el backoffice no cambia planes.
  assert.doesNotMatch(adminCode, /admin_set_workspace_plan/);
  assert.doesNotMatch(adminCode, /update public\.workspaces|update public\.plan_upgrade_requests/);
});

test("la demo del backoffice no se conecta a nada", () => {
  for (const file of ["app/demo/admin/page.tsx", "app/demo/admin/admin-data.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /lib\/supabase|getSupabase|adminRpc|AdminGate|\.rpc\(|fetch\(/, `${file} se conecta`);
  }
  assert.match(read("app/demo/admin/page.tsx"), /datos ficticios/);
});
