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

## Lo que H3.1B tiene que cambiar

- **Desconectar** hoy solo revoca y borra tokens. Cuando existan eventos sincronizados, desconectar también tiene que
  detener la sincronización y los trabajos pendientes del profesional y decidir qué pasa con los vínculos de eventos
  (`event_links`). El calendario sigue sin borrarse de Google.
- `paused` hoy solo se deriva en `google_calendar_status`. Si H3.1B necesita pausar la sincronización cuando cambia el
  plan o el rollout, la pausa tiene que vivir en el lado que sincroniza, no solo en el panel.
- El refresh queda listo para usarse (`getValidGoogleAccessToken`); H3.1B lo llama desde donde sincronice.
- **Ids de evento con generación (obligatorio).** Un id borrado no se puede reusar (ver arriba). `event_links` guarda
  una `generation` y el id efectivo es `bellis<uuid del turno sin guiones>g<N>` (base32hex). Al sincronizar:
  `events.get(id)` primero; `confirmed`: se reconcilia o actualiza ese mismo evento; `cancelled`: se pasa a la
  generación siguiente y se guarda; 404: se crea. Si un `insert` da 409 `duplicate`, se vuelve a leer antes de
  decidir; nunca se toma como éxito a ciegas. Un HTTP 200 no significa "evento activo": se mira `status`. No se
  reactivan lápidas (`cancelled` → `confirmed`) sin una prueba aparte.

## Archivos

- Migración: `supabase/migrations/20261019090000_google_calendar_oauth.sql`
- Edge Function: `supabase/functions/bellis-google-oauth/index.ts` (acciones `start`, `complete`, `disconnect`)
- Lógica compartida: `supabase/functions/_shared/google-calendar-oauth.ts`
- Callback: `app/google-calendar/callback/page.tsx`
- Panel: `components/integrations/GoogleCalendarSettings.tsx`, `lib/google-calendar.ts`
- Pruebas: `supabase/tests/google_calendar_oauth.test.mjs` (Google falso local) y
  `supabase/tests/google_calendar_oauth_smoke.sql` (grupo `calendar`)
