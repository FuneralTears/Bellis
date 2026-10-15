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

## Pruebas reales contra Google (cuenta de prueba)

Se corren a mano, con la cuenta de prueba, después de conectar en staging. Responden las preguntas que la
documentación no aclara y condicionan H3.1B:

1. Zona horaria del calendario: ¿"Turnos Bellis" se crea con `America/Argentina/Buenos_Aires` (la que manda Bellis)?
   El valor que devuelve Google queda guardado en `calendar_timezone`.
2. FreeBusy sobre `primary` con: un evento normal, uno de día completo, uno rechazado, uno marcado como "Disponible"
   (transparente) y uno de otro calendario de la cuenta. ¿Cuáles aparecen como ocupado?
3. Reutilizar el id de un evento borrado en "Turnos Bellis": ¿Google lo acepta, o responde 409?
4. Volver a conectar la misma cuenta: se reutiliza el mismo calendario y no se pide consentimiento otra vez.
5. Borrar "Turnos Bellis" desde Google y volver a conectar: se crea uno nuevo.
6. Quitar el permiso desde la cuenta de Google y forzar una renovación: la conexión queda `needs_reconnect`.

## Lo que H3.1B tiene que cambiar

- **Desconectar** hoy solo revoca y borra tokens. Cuando existan eventos sincronizados, desconectar también tiene que
  detener la sincronización y los trabajos pendientes del profesional y decidir qué pasa con los vínculos de eventos
  (`event_links`). El calendario sigue sin borrarse de Google.
- `paused` hoy solo se deriva en `google_calendar_status`. Si H3.1B necesita pausar la sincronización cuando cambia el
  plan o el rollout, la pausa tiene que vivir en el lado que sincroniza, no solo en el panel.
- El refresh queda listo para usarse (`getValidGoogleAccessToken`); H3.1B lo llama desde donde sincronice.

## Archivos

- Migración: `supabase/migrations/20261019090000_google_calendar_oauth.sql`
- Edge Function: `supabase/functions/bellis-google-oauth/index.ts` (acciones `start`, `complete`, `disconnect`)
- Lógica compartida: `supabase/functions/_shared/google-calendar-oauth.ts`
- Callback: `app/google-calendar/callback/page.tsx`
- Panel: `components/integrations/GoogleCalendarSettings.tsx`, `lib/google-calendar.ts`
- Pruebas: `supabase/tests/google_calendar_oauth.test.mjs` (Google falso local) y
  `supabase/tests/google_calendar_oauth_smoke.sql` (grupo `calendar`)
