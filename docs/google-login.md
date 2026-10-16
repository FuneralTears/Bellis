# Iniciar sesión con Google (H3.1A.1)

"Continuar con Google" en `/ingresar` y `/registro`. Es **solo identidad**: no pide ningún permiso de Google Calendar.
Conectar Google Calendar sigue siendo un consentimiento aparte, en Perfil → Integraciones (ver `docs/google-calendar.md`).

## Login con Google y Google Calendar son cosas distintas

| | Iniciar sesión con Google | Conectar Google Calendar |
| --- | --- | --- |
| Para qué | Entrar a Bellis | Que Bellis use tu calendario |
| Quién habla con Google | Supabase Auth | La Edge Function `bellis-google-oauth` |
| Permisos | `openid`, `email`, `profile` (los de Supabase) | `calendar.app.created`, `calendar.freebusy` |
| Vuelve a | `https://<ref>.supabase.co/auth/v1/callback` → `/auth/callback` | `/google-calendar/callback` |
| Cliente OAuth de Google | **Bellis Sign-In** (uno nuevo) | El de Calendar, sin cambios |
| Tokens de Google | Bellis no guarda ninguno | En Vault |

Se puede usar uno sin el otro: entrar con Google y no conectar Calendar, o entrar con email y contraseña y conectar Calendar.

## Arquitectura

- `components/auth/GoogleSignIn.tsx`: el botón. Solo aparece si el proyecto de Supabase tiene Google habilitado (lo lee
  de `GET /auth/v1/settings`, público). Por eso el código puede estar en producción antes de configurar el proveedor:
  nadie ve un botón que no funciona.
- `lib/auth/google.ts`: el inicio y el callback. El paso de Google usa un cliente de Supabase **propio, con PKCE**: el
  verificador queda en el `sessionStorage` de esa pestaña. En `/auth/callback` el código se cambia por la sesión y esa
  sesión se le pasa al cliente de siempre (`getSupabase`), así todas las páginas leen la misma sesión que con email y
  contraseña. El cliente de siempre no cambia de flujo: los enlaces de confirmación de email y de recuperación de
  contraseña funcionan igual que antes.
- `lib/auth/google-flow.ts`: las reglas, sin navegador, con tests.
- El `redirectTo` se construye exclusivamente como `origin actual + /auth/callback`, después de validar el origin. Se
  permiten `http://localhost:5173`, producción exacta y hosts `bellis-…-bellis1.vercel.app` por HTTPS. Cualquier otro
  origin falla cerrado y el OAuth no comienza.
- `app/auth/callback/page.tsx`: lee el código una sola vez, lo saca de la barra de direcciones y decide el destino por la
  cuenta, nunca por la URL (no hay `next` ni `redirect`). Si algo falla vuelve a `/ingresar?google=<código corto>`.
- `app/registro/completar/page.tsx` y la migración `20261020090000_google_login_account.sql`: ver "Cuenta nueva".
- Destino según la cuenta, igual para cualquier forma de entrar (`landingRouteForUser`): sin consultorio →
  `/registro/completar`; onboarding pendiente → `/onboarding`; si no → `/dashboard`. Ninguna página pregunta con qué
  proveedor entró la persona.

## Cuenta nueva con Google

El alta con email crea consultorio, membresía y perfil profesional en un trigger, con los datos del formulario. Google no
trae esos datos, así que el trigger no crea nada. La persona los completa en `/registro/completar` (los mismos campos,
sin email ni contraseña) y la RPC `public.complete_bellis_account`:

- usa la persona de la sesión (`auth.uid()`), nunca algo del pedido;
- exige el email confirmado (`auth.users.email_confirmed_at`); si no, `email_not_verified` y no se crea nada;
- es idempotente: con un candado por persona, si ya tiene consultorio devuelve ese y no crea nada (doble envío, refresh,
  dos pestañas);
- crea la cuenta con la misma función que el trigger (`private.create_bellis_account`), con las mismas validaciones.

Después sigue el onboarding normal. No se escribe nada en el esquema `auth`.

## Cuentas con el mismo email (vinculación)

Según la documentación de Supabase (Identity Linking), cuando alguien entra con Google y ya existe un usuario con el
mismo email, Supabase **vincula** la identidad de Google a ese usuario (vinculación automática). Supabase no vincula a un
usuario con email sin verificar y, al vincular, elimina las identidades no confirmadas de ese usuario.

| Caso | Qué pasa |
| --- | --- |
| A. Persona nueva, email de Google verificado | Usuario nuevo → `/registro/completar` → onboarding. |
| B. Ya tenía cuenta con email y contraseña (confirmada), mismo email | Supabase vincula Google al mismo usuario. Mismo consultorio, nada duplicado. Puede seguir entrando con email y contraseña. |
| B'. Se registró con email pero nunca confirmó | Supabase vincula y elimina la identidad de email no confirmada: el usuario es el mismo y su consultorio también, pero para volver a usar contraseña tiene que recuperarla. |
| C. Ya entró antes con Google | Login normal. |
| D. Google devuelve el email sin verificar | No se le da sesión de Bellis (se descarta) ni cuenta; mensaje claro. |
| E. Cancela en Google | Vuelve a `/ingresar` con un aviso; nada queda a medias. |
| F. Cuenta sin onboarding completo | Sigue en `/onboarding`. |
| G. Cuenta completa | `/dashboard`. |

No usamos vinculación manual (`linkIdentity`): queda deshabilitada en Supabase. No inventamos vinculaciones a mano.

## Configuración de Google Cloud (la hace una persona)

**Recomendación:** mismo proyecto de Google Cloud de cada entorno (la marca y la pantalla de consentimiento son las
mismas), pero **un cliente OAuth nuevo, solo para iniciar sesión**. El cliente de Calendar no se toca. Así los redirects
y los secretos de cada cosa quedan separados, y revocar uno no afecta al otro.

1. Google Auth Platform → Clients → **Create client** → tipo **Web application**, nombre `Bellis Sign-In (staging)`.
2. **Authorized redirect URIs**: solo la de Supabase del entorno, exacta:
   `https://<STAGING_REF>.supabase.co/auth/v1/callback`
   (cópiala de Supabase → Authentication → Providers → Google). No se agregan URLs de Bellis ni de Vercel: Google vuelve
   a Supabase, y Supabase a Bellis.
3. **Authorized JavaScript origins**: `http://localhost:5173` y el origen estable del sitio de ese entorno.
4. Pantalla de consentimiento (Data access): `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. Son
   permisos no sensibles: no agregan verificación. El proyecto ya tiene los permisos de Calendar para la integración;
   el login no los pide, así que la persona que solo inicia sesión no los ve.
5. Mientras el proyecto esté en **Testing**, solo los test users pueden entrar con Google. Para producción el proyecto
   tiene que estar **In production** (ya lo requiere H3.1A).
6. Copiar Client ID y Client Secret **directamente** en Supabase (paso siguiente). No pegarlos en el chat ni en git.

Producción: lo mismo con `Bellis Sign-In (production)` y la URL de callback del proyecto de producción. No hacerlo
hasta aprobar el release.

## Configuración de Supabase (la hace una persona)

### Staging

1. Authentication → Providers → **Google**: Enable; Client ID y Client Secret del cliente `Bellis Sign-In (staging)`;
   **Skip nonce check: apagado**; dejar "Allow users without an email" apagado.
2. Authentication → URL Configuration:
   - Site URL: `https://bellis-git-staging-bellis1.vercel.app`.
   - Redirect URLs: `http://localhost:5173/auth/callback`,
     `https://bellis-git-staging-bellis1.vercel.app/auth/callback` y
     `https://bellis-*-bellis1.vercel.app/auth/callback`.
   - El último patrón es el mecanismo de Preview recomendado por Supabase, restringido al prefijo del proyecto Bellis,
     al team `bellis1` y al path exacto `/auth/callback`. En los globs de Supabase, `*` no cruza los separadores `.` ni
     `/`; no usar `https://**.vercel.app/**` ni un comodín de host más amplio.
3. Authentication → Sign In / Providers: **Manual linking** apagado (es el valor por defecto).

### Producción

Lo mismo, con el cliente de producción y solo `https://bellis-six.vercel.app/auth/callback` en Redirect URLs. Sin
localhost ni Previews. **No configurar hasta la aprobación del release.**

## Rollback

- Rápido y sin deploy: apagar Google en Supabase → el botón desaparece solo. Las cuentas creadas con Google siguen
  existiendo; pueden entrar con "¿Olvidaste tu contraseña?" para elegir una contraseña.
- Código: revertir el commit; la migración solo agrega funciones y no hace falta revertirla (el trigger sigue haciendo
  exactamente lo mismo que antes).

## QA checklist

- [ ] `/ingresar` y `/registro`: "Continuar con Google" arriba, separador "o", email y contraseña debajo.
- [ ] Al tocarlo, la pantalla de Google pide solo nombre, email y foto (nada de Calendar).
- [ ] A. Cuenta nueva → `/registro/completar` → onboarding → dashboard.
- [ ] B. Cuenta existente con email → mismo consultorio, nada duplicado; email y contraseña siguen funcionando.
- [ ] C. Volver a entrar con Google → dashboard.
- [ ] D. Email no verificado → mensaje y sin sesión (difícil de reproducir con Gmail).
- [ ] E. Cancelar en Google → `/ingresar` con aviso.
- [ ] H. Refresh en `/auth/callback` y dos pestañas → sin errores ni duplicados.
- [ ] Cerrar sesión y volver a entrar.
- [ ] Conectar Google Calendar después de entrar con Google: sigue pidiendo su propio consentimiento.
- [ ] 1440, 1024, 768, 390 y 320 px; foco con teclado; consola sin errores.
