# Google Calendar (H3.1A): conexión de la cuenta

H3.1A conecta la cuenta de Google de un profesional y crea su calendario **Turnos Bellis**. Todavía no se escribe
ningún turno ni se lee disponibilidad: eso empieza en H3.1B.

## Qué hace hoy

- Perfil → Integraciones → **Conectar Google Calendar** manda a Google con estos permisos y ningún otro:
  `openid`, `email`, `https://www.googleapis.com/auth/calendar.app.created` y
  `https://www.googleapis.com/auth/calendar.freebusy`. No se piden `profile`, `calendar`, `calendar.events` ni
  `calendar.readonly`.
- Al volver, Bellis crea un calendario secundario llamado "Turnos Bellis" en la cuenta y guarda su id. Nunca lista
  los calendarios de la persona. Si la misma cuenta de Google se vuelve a conectar, se reutiliza el calendario
  guardado; si ese calendario ya no existe (Google responde 404), se crea uno nuevo.
- Los tokens quedan en Vault (`description = 'Bellis Google Calendar'`). El navegador no ve ningún token, ni el id
  del calendario, ni el identificador de la cuenta de Google: solo `google_calendar_status`, que devuelve si está
  disponible y por qué no, el estado, el email, "Turnos Bellis", la fecha de conexión, la última renovación y el
  último código de error.
- Identidad: la cuenta de Google se identifica por el `sub` del ID token, que se verifica como indica Google: firma
  RS256 contra las claves publicadas en `https://www.googleapis.com/oauth2/v3/certs` (librería `jose`, que las cachea y
  las vuelve a pedir cuando aparece un `kid` desconocido, así la rotación no necesita nada), `aud` = `GOOGLE_CLIENT_ID`,
  `iss` de Google, `exp` vigente y `sub` presente. Sin verificación no se conecta nada; si no se pueden leer las claves
  de Google, se informa `google_jwks_unavailable`. El email es solo un dato que se muestra, nunca la identidad. No se usa
  `tokeninfo`.
- OAuth: acceso offline, PKCE S256, un `state` de un solo uso guardado como hash (10 minutos, ligado a la persona que
  empezó), verificación de los permisos concedidos, `prompt=consent` solo cuando Bellis no tiene un refresh token que
  funcione. Si Google no manda un refresh token nuevo, se conserva el guardado, pero solo para la misma cuenta.
- Renovación: `getValidGoogleAccessToken` (en `supabase/functions/_shared/google-calendar-oauth.ts`) renueva con
  un lease de 30 segundos para que dos pedidos no gasten el mismo refresh token. Si Google responde `invalid_grant`,
  la conexión pasa a `needs_reconnect` y se borran los tokens.
- **Desconectar** revoca el permiso en Google, borra los tokens de Vault y marca la conexión como `disconnected`.
  Se conservan `google_subject` y `calendar_id`, y el calendario no se borra de Google. No requiere el plan ni el
  rollout. Si no se pudo revocar en Google, Bellis igual olvida los tokens y lo anota (`google_revoke_failed`).

## Disponibilidad: plan Y rollout

Google Calendar está disponible para un workspace solo si se cumplen las dos cosas:

- `private.workspace_has_capability(ws, 'google_calendar_sync')`: es parte del plan (Pro y prueba de Pro).
- `private.workspace_has_feature(ws, 'google_calendar_beta')`: el workspace está en la beta.

La capacidad es el derecho comercial; el feature es el rollout. Uno no reemplaza al otro. La regla vive solo en la base
de datos (`private.google_calendar_available`). El panel muestra lo que contesta `google_calendar_status`:

| `available` | `unavailable_reason` | Qué ve la persona |
| --- | --- | --- |
| `true` | `null` | Conectar / conectado / volver a conectar |
| `false` | `plan_required` | "Disponible en Bellis Pro" |
| `false` | `not_enabled` | Nada: la pestaña Integraciones no aparece (salvo que haya una conexión guardada, que se puede desconectar) |
| `false` | `no_professional` | Nada para conectar |

Una conexión guardada en un workspace que ya no está habilitado se lee como `paused`: se puede desconectar, no se usa.

## Habilitar la beta en un workspace (manual, por entorno)

`private.workspace_features` no se lee ni se escribe desde el navegador y no tiene ninguna RPC: se cambia a mano, con
acceso `postgres` (SQL Editor de Supabase). **No se carga ningún workspace por migración ni se deja ningún email ni id
en git.** `enabled_by` es una nota operativa en texto libre, no una auditoría.

1. Identificar el workspace de QA. El email se escribe en el momento, en el editor; no se guarda en ningún archivo:

   ```sql
   select w.id, w.name, m.role
   from auth.users u
   join public.workspace_members m on m.user_id = u.id
   join public.workspaces w on w.id = m.workspace_id
   where u.email = 'EMAIL_DE_LA_CUENTA_QA';
   ```

   Tiene que devolver exactamente el workspace esperado. Si devuelve otra cosa, no seguir.

2. Habilitar:

   ```sql
   insert into private.workspace_features (workspace_id, feature, enabled_by)
   values ('ID_DEL_WORKSPACE', 'google_calendar_beta', 'QA H3.1A')
   on conflict (workspace_id, feature) do nothing
   returning workspace_id, feature, enabled_at;
   ```

3. Ver quiénes la tienen:

   ```sql
   select f.workspace_id, w.name, f.enabled_at, f.enabled_by
   from private.workspace_features f join public.workspaces w on w.id = f.workspace_id
   where f.feature = 'google_calendar_beta' order by f.enabled_at;
   ```

4. Quitarla (la conexión guardada queda `paused` y se puede desconectar desde el panel):

   ```sql
   delete from private.workspace_features
   where workspace_id = 'ID_DEL_WORKSPACE' and feature = 'google_calendar_beta'
   returning workspace_id;
   ```

El workspace además tiene que tener Pro o la prueba de Pro.

## Configuración de Google Cloud (la hace una persona)

Bellis no crea proyectos ni credenciales desde código. Para staging/desarrollo:

1. Un proyecto de Google Cloud solo para pruebas, con la Google Calendar API habilitada.
2. Pantalla de consentimiento en modo **Testing**, con la cuenta de prueba agregada como test user. En Testing los
   refresh tokens vencen a los 7 días: reconectar es esperable.
3. Permisos de la pantalla de consentimiento: exactamente los cuatro de arriba.
4. Cliente OAuth de tipo **Web application**. URIs de redirección autorizadas (exactas, sin comodines):
   - Desarrollo: `http://localhost:5173/google-calendar/callback`
   - Staging estable, cuando exista un host fijo de staging: `https://HOST_DE_STAGING/google-calendar/callback`
   - Nunca una URL de Preview de Vercel: cambian con cada deploy y Google compara la dirección exacta. El código las
     rechaza (`preview_url`).
   - Producción: no configurar todavía.
5. Secretos de la Edge Function en el proyecto de Supabase de staging (Dashboard → Edge Functions → Secrets), cargados
   por la persona, nunca en git ni en `NEXT_PUBLIC_`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`: la dirección exacta del entorno que se está probando. Para probar desde
     `localhost:5173` contra staging: `http://localhost:5173/google-calendar/callback`. Si falta, se usa
     `BELLIS_SITE_ORIGIN` + `/google-calendar/callback`.

Sin estos secretos, `bellis-google-oauth` responde 503 al conectar ("Google Calendar todavía no está disponible") y
registra `google_config_missing` con el **nombre** de lo que falta, nunca un valor. Desconectar funciona igual.

## Pruebas reales contra Google (resultados observados)

Corridas en staging del 15 al 16 de octubre de 2026, con la cuenta QA (zona horaria de su calendario: Ciudad de
México, UTC−6), solo con los permisos de Bellis (`calendar.app.created` y `calendar.freebusy`). Las consultas
FreeBusy fueron de solo lectura sobre `primary`, pedidas en `America/Argentina/Buenos_Aires`. Los eventos de
`primary` los creó y borró una persona, a mano. Se registra lo observado, sin inferir causas.

| Caso | Resultado observado |
| --- | --- |
| Zona horaria de "Turnos Bellis" | Creado con `America/Argentina/Buenos_Aires`; es lo que guarda `calendar_timezone`. |
| Evento propio "Ocupado" (3 PM CDMX, 15/10) | BUSY. FreeBusy devolvió 18:00–18:45 −03:00 (45 min); la duración no se explicó. |
| Evento propio "Disponible" (4 PM CDMX, 15/10) | BUSY en 19:00–19:30; al borrarlo, NOT BUSY. Anomalía de ese evento: no se reprodujo. |
| Evento propio "Disponible", nuevo (4 PM CDMX, 16/10) | NOT BUSY antes, con el evento y después de borrarlo. Lo transparente no bloquea. |
| Evento invitado, rechazado ("No") | NOT BUSY. |
| Evento invitado, aceptado ("Sí", "No disponible", en `primary`) | NOT BUSY en su horario, y ningún bloque en todo el día, con espera y con token renovado. **Caso límite sin explicar.** |
| Evento de todo el día "Ocupado" (20/10) | BUSY durante 24 h, del día calendario de la cuenta: 00:00–24:00 CDMX = 03:00–03:00 en Argentina. |
| Fuera de la oficina | NOT TESTED: no está disponible en la cuenta QA. |
| Tiempo de concentración (focus time) | NOT TESTED: no está disponible en la cuenta QA. |
| Ubicación de trabajo (working location) | NOT TESTED. |
| Reusar el id de un evento borrado en "Turnos Bellis" | **No se puede.** `events.delete` 204; `events.get` sigue dando 200 con `status: cancelled`; un `insert` con el mismo id da 409 `duplicate` ("The requested identifier already exists."). El mismo id con sufijo `g1` se crea sin problema. |

Para V1, Bellis toma FreeBusy tal cual responde Google: no amplía permisos para explicar el caso del evento invitado.
Un día completo bloquea según la zona horaria del calendario de la persona, no la del consultorio.

Siguen pendientes del E2E (no son pruebas de FreeBusy): volver a conectar la misma cuenta y reutilizar el calendario,
borrar "Turnos Bellis" y volver a conectar, y quitar el permiso desde Google para ver `needs_reconnect`.

## H3.1B: sincronización de turnos

`private.google_calendar_event_sync` es a la vez vínculo y outbox, una fila por turno. Guarda el workspace, profesional,
conexión/calendario usados, id efectivo, generación, estado deseado, revisión, lease, intentos y el último resultado.
Es privada, con RLS, sin policies ni grants para el navegador. El trigger de `appointments` solo persiste intención;
nunca espera a Google y un problema de Calendar no puede revertir una reserva.

Estados: `pending`/`retry` → `processing` → `synced` o `deleted`. `blocked` pausa una fila si falta conexión, Pro o la
beta, sin revocar nada ni borrar el calendario. `failed` es terminal para un error permanente o después de ocho
intentos. Un barrido recupera leases vencidos, reactiva filas bloqueadas al volver la capacidad y descubre turnos que
entran en la ventana futura de 90 días. No hay backfill histórico.

El worker interno `bellis-google-calendar-sync` corre cada minuto mediante `pg_cron` + `pg_net` (extensión habilitada
como prerrequisito de infraestructura del entorno, antes de aplicar la migración). Reclama hasta 25 filas
con `FOR UPDATE SKIP LOCKED` y un lease de 90 segundos. Reutiliza `getValidGoogleAccessToken`: un 401 fuerza una sola
renovación; `invalid_grant` mantiene la transición H3.1A a `needs_reconnect`. 403 de cuota, 429, 5xx, timeout y red
reintentan con backoff. El job de cron es un no-op hasta que existan sus dos secretos de entorno en Vault.

Payload: `summary = "Turno Bellis"`, visibilidad privada, inicio/fin con la zona IANA del workspace, descripción y
ubicación vacías, sin asistentes y `reminders.useDefault = false`. No salen nombre, email, teléfono, servicio, motivo,
notas ni respuestas. La única metadata técnica es el UUID del turno sin guiones y su generación en
`extendedProperties.private`.

Mapeo de estados reales: `scheduled` y `completed` crean o actualizan el mismo evento; completar no borra el historial
del calendario. `cancelled` elimina. Cualquier otro valor del enum amplio de booking falla cerrado y no crea. Un turno
ya vinculado que se mueve después de +90 días se elimina y el barrido lo vuelve a crear cuando entre en la ventana.

El id es `bellis<uuid sin guiones>g<N>`. Antes de crear se hace `events.get`: activo se actualiza; `cancelled`/410
incrementa la generación (máximo 8); 404 permite crear. Un 409 siempre vuelve a GET y reconcilia. Si el turno cambia
mientras Google responde, la revisión vieja conserva el resultado externo (incluido el id que alcanzó a crear) y deja
la fila nuevamente pendiente para aplicar la versión nueva.

### Configurar el scheduler por entorno

Generar un secreto aleatorio distinto por entorno y guardar el mismo valor como secret de la Edge Function
`GOOGLE_CALENDAR_SYNC_SECRET` y en Vault con nombre `bellis_google_calendar_sync_secret`. Guardar además en Vault la URL
exacta `https://<project-ref>.supabase.co/functions/v1/bellis-google-calendar-sync` con nombre
`bellis_google_calendar_sync_url`. Ninguno de los valores se imprime ni se versiona. Producción se configura solo en su
release autorizado; H3.1B configura staging únicamente.

Antes de aplicar la migración, habilitar `pg_net` en ese proyecto Supabase. Se hace fuera de la migración porque el
release de Bellis ensaya cada migración dentro de una transacción y, por seguridad, rechaza `CREATE EXTENSION` como un
efecto que podría no revertirse. La migración falla cerrada si el prerrequisito no está presente.

### E2E manual en staging

- A. Crear un turno futuro: aparece un único evento privado “Turno Bellis” en “Turnos Bellis”.
- B. Cambiar hora/duración: cambia ese evento, sin crear otro.
- C. Cancelar: el evento desaparece; reactivar el mismo turno crea `g1`, no intenta revivir la lápida.
- D. Repetir el worker/refrescar durante sync: sigue habiendo un evento y una fila.
- E. Simular cuota/5xx: la fila queda `retry`; al recuperar Google termina `synced`.
- F. Revocar Google: el refresh rechazado deja `needs_reconnect`, tokens borrados y fila `blocked`.
- G. Bajar a Free o apagar beta: no hay llamadas nuevas; conexión/calendario quedan. Rehabilitar reconcilia hasta +90 días.
- H. Inspeccionar el evento: no contiene PII, notas, motivo, ubicación, asistentes ni recordatorios personalizados.

## Archivos

- Migración: `supabase/migrations/20261019090000_google_calendar_oauth.sql`
- Edge Function: `supabase/functions/bellis-google-oauth/index.ts` (acciones `start`, `complete`, `disconnect`)
- Lógica compartida: `supabase/functions/_shared/google-calendar-oauth.ts`
- H3.1B: `supabase/migrations/20261020100000_google_calendar_event_sync.sql`,
  `supabase/functions/bellis-google-calendar-sync/index.ts` y
  `supabase/functions/_shared/google-calendar-events.ts`
- Callback: `app/google-calendar/callback/page.tsx`
- Panel: `components/integrations/GoogleCalendarSettings.tsx`, `lib/google-calendar.ts`
- Pruebas: `supabase/tests/google_calendar_oauth.test.mjs` (Google falso local),
  `supabase/tests/google_calendar_oauth_smoke.sql`, `supabase/tests/google_calendar_events.test.mjs` y
  `supabase/tests/google_calendar_events_smoke.sql` (grupo `calendar`)
