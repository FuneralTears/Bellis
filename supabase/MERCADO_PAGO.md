# Mercado Pago Argentina

Esta integración cobra **turnos de pacientes a la cuenta del profesional** mediante Checkout Pro. No cobra la suscripción de Bellis. La aprobación manual de links externos sigue disponible.

## Estado y límites

- **Implementado (fase 3):** checkout, webhook, verificación de la operación y conciliación al consultar estado, en Edge Functions.
- **Implementado (G2 y G2.1):** conexión por OAuth de la cuenta de cada workspace: inicio, retorno a una página de Bellis, intercambio del código, guardado de tokens en Vault, renovación, estado de conexión y desconexión.
- **Implementado (G3):** Perfil → Cobros y pagos permite conectar, ver el estado, desconectar y elegir entre Mercado Pago y link de pago externo. La base de datos rechaza Mercado Pago como método si el workspace no tiene una cuenta conectada.
- **Implementado (G4):** el checkout, la consulta de estado y el webhook usan el token renovable de la cuenta conectada. La preferencia vence junto con la solicitud. Al desconectar, el workspace vuelve al link externo.
- **Implementado (G5):** el paciente que vuelve de Mercado Pago recupera su solicitud con un token opaco, aunque vuelva en otra pestaña. Bellis consulta el estado real del pago y decide el paso. Una solicitud cuyo checkout no pudo crearse queda cerrada.
- **Todavía no implementado:**
  - Emails para retomar una solicitud, reembolsos de punta a punta y una tarea que marque como vencidas las solicitudes viejas.
  - La prueba sandbox de punta a punta y la salida a producción (G6, G7).
- **Nada de esto está desplegado todavía:** la migración no se aplicó, la función `bellis-mp-oauth` no se publicó y no hay credenciales cargadas. Mientras tanto la pantalla muestra Mercado Pago como "No disponible" y el link externo sigue funcionando.

**Conectar una cuenta no significa que el checkout completo esté listo.** Deja al workspace con credenciales válidas; cobrar con ellas de punta a punta depende de las fases siguientes.

## Arquitectura

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| `bellis-mp-oauth` | Edge Function | `POST ?action=start` crea el state y devuelve la URL de autorización. `POST ?action=complete` termina la conexión. Las dos exigen sesión. |
| `/mercado-pago/callback` | Página de Bellis | A donde vuelve la persona desde Mercado Pago. Entrega `code` y `state` al servidor junto con su sesión. |
| `_shared/mercado-pago-oauth.ts` | Módulo de servidor | URL de autorización, intercambio y renovación de tokens, `getValidMercadoPagoAccessToken`. |
| `private.mercado_pago_oauth_states` | Tabla privada | Un intento de autorización: hash del state, workspace, usuario, vencimiento, uso. |
| `private.mercado_pago_accounts` | Tabla privada | La conexión del workspace: vendedor, referencias a Vault, vencimiento, estado. |
| Supabase Vault | Base de datos | Access token y refresh token de cada vendedor, cifrados. |
| `bellis-public`, `bellis-mp-webhook` | Edge Functions | Checkout y avisos de pago. Sin cambios en G2. |

Ninguna tabla privada ni Vault es legible con una sesión. Los tokens solo se leen con la clave de servicio, dentro de las Edge Functions.

## Flujo OAuth

1. El panel llama a `bellis-mp-oauth?action=start` con la sesión de la persona (`Authorization: Bearer <token de sesión>`).
2. La función verifica la sesión y resuelve el workspace **por membresía**; nunca lo recibe del navegador. Solo el rol `owner` puede conectar.
3. Genera un state aleatorio de 32 bytes, guarda su SHA-256 con workspace, usuario y vencimiento de 10 minutos, e invalida los intentos anteriores del mismo workspace.
4. Devuelve `{ authorizationUrl }`. El navegador navega a esa URL en Mercado Pago.
5. Mercado Pago devuelve a la persona a `/mercado-pago/callback`, **en Bellis**, con `code` y `state`.
6. La página toma la sesión actual de Bellis y llama a `bellis-mp-oauth?action=complete` con `code` y `state`. Sin sesión no envía nada.
7. La función verifica la sesión y consume el state solo si **quien lo presenta es exactamente quien lo inició** y sigue siendo owner de ese workspace.
8. Recién entonces intercambia el código en `https://api.mercadopago.com/oauth/token` con el client secret.
9. Guarda access token y refresh token en Vault, el vendedor (`user_id`), el vencimiento y el entorno; marca la conexión como `connected` y deja un evento de auditoría.
10. Responde `{ outcome }`: `connected`, `invalid_state` o `error`. La página vuelve a `/dashboard?section=Perfil&tab=cobros&mp=<resultado>`.
11. Cobros y pagos usa `mp` solo para mostrar un mensaje y lo quita de la dirección. El estado real lo lee siempre de `mercado_pago_connection_status`.

### Por qué el callback vive en Bellis

Tener el link de autorización no alcanza para conectar una cuenta. Si alguien inicia la conexión y le pasa el link a otra persona, esa persona autoriza con su Mercado Pago y vuelve a Bellis **con su propia sesión o sin ninguna**: el servidor rechaza la conexión, el código nunca se intercambia y el state queda quemado. La identidad y el workspace salen de la sesión verificada y del state guardado; el cuerpo del pedido solo lleva `code` y `state`.

Reglas del state:

- No existe, venció o ya se usó → `invalid_state`.
- Lo presenta otra persona con sesión → `invalid_state`, y el state se invalida para que no pueda completarse después.
- Quien lo inició ya no es owner, o el state apunta a un workspace que no le pertenece → `invalid_state`.
- Llega sin sesión → la página no envía nada, se queda pidiendo que inicie sesión, y la función responde 401 sin tocar el state.
- Mercado Pago devuelve a la persona sin `code` (canceló) → la página no envía nada y vuelve con `mp=cancelled`. El state vence solo.

Si el intercambio o el guardado fallan, no queda ninguna conexión parcial.

Límite conocido: si la persona que autorizó copia a mano la dirección completa a la que volvió (con el código) y se la entrega a quien inició el flujo dentro de los 10 minutos, este último podría completarla con su sesión. Equivale a entregar una credencial y ningún flujo OAuth lo evita; la página borra el código de la barra de direcciones apenas carga para que no quede a la vista.

## Estados de la conexión

| Estado | Significado |
| --- | --- |
| `disconnected` | No hay cuenta, o se desconectó. Bellis no conserva tokens. |
| `connected` | Hay credenciales utilizables. |
| `expired` | Derivado: figura conectada, el token venció y no hay refresh token (cargas manuales viejas). |
| `error` | Mercado Pago rechazó la renovación. Hay que volver a conectar. |

`active` (lo que lee el checkout actual) siempre vale lo mismo que `status = 'connected'`.

### Lo que puede consultar y hacer el panel

- `mercado_pago_connection_status(p_workspace)` — roles `owner` y `admin` del workspace. Devuelve `connected`, `provider`, `status`, `account_hint` (últimos 4 dígitos del vendedor), `environment`, `connected_at`, `token_expires_at`. Nunca un token.
- `disconnect_mercado_pago(p_workspace)` — solo `owner`. Borra los tokens de Vault y marca la conexión como `disconnected`. **No revoca la autorización dentro de Mercado Pago**: la persona puede quitarla desde su cuenta de Mercado Pago. Si Mercado Pago era el método de cobro, el workspace pasa a `external_link`: con un link guardado los pacientes siguen pagando por ahí; sin link queda sin método utilizable (`external_link` sin URL, la misma representación de un workspace sin configurar) hasta que el owner cargue uno.
- Elegir el método es una escritura sobre `workspaces.payment_provider`, permitida solo al `owner` por RLS. El trigger `workspace_mercado_pago_guard` rechaza el cambio a `mercado_pago_ar` con `mercado_pago_not_connected` si el workspace no tiene una cuenta conectada (tampoco con la conexión en `error` o `expired`). Vale para cualquier cliente, no solo para la pantalla.
- En la pantalla, un `admin` ve el estado pero no tiene acciones; los demás roles no ven la conexión.

## Cómo se obtiene un token dentro del servidor

```ts
import { getValidMercadoPagoAccessToken, oauthConfigFromEnv, supabaseConnectionStore } from "../_shared/mercado-pago-oauth.ts";

const account = await getValidMercadoPagoAccessToken(supabaseConnectionStore(db), oauthConfigFromEnv(read, siteOrigin), workspaceId);
// { seller_user_id, access_token, environment }
```

- Si al token le queda más de un día, lo devuelve sin llamar a Mercado Pago.
- Si está por vencer o venció, toma una reserva de 30 segundos (`claim_mercado_pago_refresh`), renueva con el refresh token y guarda el nuevo par. Las demás solicitudes simultáneas siguen usando el token actual mientras sirva, o esperan el nuevo.
- Si Mercado Pago rechaza la renovación (400/401) la conexión pasa a `error`. Un fallo temporal no cambia el estado.
- Si a la función le faltan `MERCADO_PAGO_CLIENT_ID` o `MERCADO_PAGO_CLIENT_SECRET`, no intenta renovar y no marca la cuenta como fallida.
- `db` debe ser un cliente con la clave de servicio. No usar este helper ni `mercado_pago_credentials` fuera de una Edge Function.

### Dónde se usa

| Lugar | Para qué | Si no hay token utilizable |
| --- | --- | --- |
| `bellis-public`, `create_intent` | Crear la preferencia. Se pide **antes** de crear la solicitud, con el workspace tomado del servicio guardado. | Responde 503 con "No pudimos iniciar el pago en este momento. Intentá nuevamente más tarde." No se crea solicitud ni se puede reservar. |
| `bellis-public`, `status` | Buscar el pago en Mercado Pago cuando el paciente consulta. | La solicitud sigue pendiente. |
| `bellis-mp-webhook` | Leer el pago notificado para verificarlo. | Responde 503 y Mercado Pago reenvía la notificación. |

Si Mercado Pago responde 401 a una llamada hecha con el token guardado (la persona quitó a Bellis desde su cuenta), la conexión pasa a `error` y el panel pide volver a conectar. `bellis-public` y `bellis-mp-webhook` necesitan por eso los mismos `MERCADO_PAGO_CLIENT_ID` y `MERCADO_PAGO_CLIENT_SECRET` que `bellis-mp-oauth`.

La preferencia se crea con `expires` y `expiration_date_to` iguales al vencimiento de la solicitud (48 horas), para que el checkout no quede abierto indefinidamente.

## Retorno del paciente

Mercado Pago se abre en otra pestaña. La pestaña original guarda el token de la solicitud en `sessionStorage`, que no se comparte entre pestañas, así que antes de G5 la pestaña de retorno llegaba a `/p/[slug]` sin saber de qué solicitud se trataba.

| Qué | Cómo |
| --- | --- |
| Token de retorno | 32 bytes aleatorios. Se crea junto con el checkout. En la base solo se guarda su SHA-256, en `booking_intents.resume_token_hash` (único). |
| Dónde viaja | En las `back_urls` de la preferencia: `/p/<slug>?resume=<token>&mp=success|pending|failure`. No lleva ids de solicitud, workspace, paciente ni montos. |
| Cuánto dura | Lo mismo que la solicitud. Es reutilizable: el paciente puede volver varias veces mientras el pago se resuelve. |
| Qué permite | Lo mismo que el token de la pestaña original para esa única solicitud: consultar el estado, ver horarios y reservar cuando el pago está aprobado. |
| `mp` | Solo cambia el texto mientras no hay ningún pago registrado. Nunca decide el paso. |

Al cargar `/p/[slug]?resume=…` la página quita el token de la dirección y llama a `bellis-public?action=resume` con el token y el slug. El servidor:

1. Busca la solicitud por el hash del token. Si no existe, o el slug no es el de su profesional, responde 404 "No pudimos recuperar esta reserva." (la misma respuesta en ambos casos).
2. Si sigue pendiente de pago, consulta el pago real en Mercado Pago y lo registra, igual que `status`.
3. Responde solo lo necesario: paso (`payment`, `schedule` o `done`), estado del pago, datos del servicio, la dirección del checkout mientras se puede pagar, y el turno si ya está reservado.
4. Una solicitud vencida responde 410; una cancelada, reembolsada o completada, 404.

Los horarios se muestran solo con la solicitud desbloqueada **y** un pago aprobado registrado. El resto del flujo (`status`, `slots`, `book`) acepta cualquiera de los dos tokens de la solicitud.

### Volver a pagar

Hay un solo checkout por solicitud (`attach_mercado_pago_checkout` no admite reemplazarlo). Un pago rechazado o cancelado se reintenta en esa misma preferencia, cuya dirección queda guardada en `payments.checkout_url`. Así un pago que llegue tarde nunca corresponde a una preferencia olvidada. Cuando la preferencia vence, también venció la solicitud: el paciente empieza de nuevo.

### Solicitud sin checkout

Si la preferencia no se puede crear o registrar, `cancel_unpaid_intent` cierra la solicitud (`cancelled`, pago `cancelled`) y deja el evento de auditoría `checkout_not_created`. No se borra nada. Solo puede cerrarse así una solicitud que nunca tuvo checkout.

### Vencimiento

Una solicitud dura 48 horas; un pago aprobado la extiende 30 días para elegir horario. Vencida, ninguna acción la acepta: `resume` responde 410 y el paciente ve "Esta reserva venció"; la pestaña que estaba consultando deja de hacerlo. No hay una tarea que cambie el estado guardado de las solicitudes vencidas.

## Variables

| Variable | Acceso | Uso |
| --- | --- | --- |
| `MERCADO_PAGO_CLIENT_ID` | Solo servidor | Identifica la aplicación de Mercado Pago. Viaja en la URL de autorización. |
| `MERCADO_PAGO_CLIENT_SECRET` | **Privada, solo servidor** | Intercambio y renovación de tokens. |
| `MERCADO_PAGO_REDIRECT_URI` | Solo servidor, opcional | URL de callback. Por defecto `<BELLIS_SITE_ORIGIN>/mercado-pago/callback`. |
| `MERCADO_PAGO_OAUTH_TEST_TOKEN` | Solo servidor, opcional | `true` pide credenciales de prueba al intercambiar el código. |
| `MERCADO_PAGO_WEBHOOK_SECRET` | **Privada, solo servidor** | Verificar HMAC de Webhooks; habilitar checkout. |
| `BELLIS_SITE_ORIGIN` | Configuración de servidor, no secreta | CORS y origen de la URL de callback. |
| `BELLIS_ADDITIONAL_ORIGINS` | Configuración de servidor, no secreta | Orígenes HTTPS exactos adicionales de previews autorizados. |
| `SUPABASE_URL` | Inyectada por Supabase | API y URL del webhook. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Privada**, inyectada por Supabase | Escrituras controladas en Edge Functions. |

Se cargan en Supabase Dashboard → Edge Functions → Secrets, o en `supabase/functions/.env` para desarrollo (ignorado por Git). La lista de nombres está en `supabase/functions/env.example`. No agregar variables `NEXT_PUBLIC_` para Mercado Pago ni configurar ninguna de estas en Vercel.

Sin `MERCADO_PAGO_CLIENT_ID`, `MERCADO_PAGO_CLIENT_SECRET` y `BELLIS_SITE_ORIGIN`, la función responde 503 y no se inicia ni completa ningún flujo.

## URL de callback

La URL que hay que registrar en la aplicación de Mercado Pago (Redirect URL) es la página de Bellis:

```
<BELLIS_SITE_ORIGIN>/mercado-pago/callback
```

- Producción: `https://bellis-six.vercel.app/mercado-pago/callback` (o el dominio definitivo cuando exista).
- Local: `http://localhost:5173/mercado-pago/callback`. Si Mercado Pago no acepta registrar una URL sin HTTPS, usar un túnel HTTPS y ponerlo en `MERCADO_PAGO_REDIRECT_URI`.
- Sin parámetros ni barra final. Debe coincidir carácter por carácter con la que usa la función: la misma URL viaja en la autorización y en el intercambio.
- Sale de `BELLIS_SITE_ORIGIN`, así que cada entorno usa la suya sin tocar código. `MERCADO_PAGO_REDIRECT_URI` la reemplaza cuando hace falta.
- Mercado Pago solo devuelve a la URL registrada: una preview de Vercel no sirve como callback salvo que se registre.

`bellis-mp-oauth` se despliega con `verify_jwt = false` (ver `supabase/config.toml`) únicamente para que el preflight de CORS del navegador, que no lleva sesión, no sea rechazado. Las dos acciones verifican la sesión contra Supabase Auth dentro de la función.

## Sandbox y producción

- El entorno de cada conexión (`test` o `production`) se guarda según lo que informa Mercado Pago al entregar el token (`live_mode`).
- Para probar: crear vendedor y comprador de prueba, poner `MERCADO_PAGO_OAUTH_TEST_TOKEN=true` y autorizar con el vendedor de prueba.
- La documentación anterior llamaba "desarrollo" al mismo proyecto de Supabase que hoy usa producción. Antes de conectar cuentas reales hay que decidir si se separan.

## Cómo probar la conexión

1. Aplicar la migración `20261004090000_mercado_pago_oauth.sql` y desplegar `bellis-mp-oauth`.
2. Cargar los secretos y registrar la URL de callback en la aplicación de Mercado Pago.
3. Con una sesión iniciada en Bellis como owner, ir a Perfil → Cobros y pagos y tocar "Conectar Mercado Pago".
4. Autorizar en Mercado Pago. Al volver, Cobros y pagos muestra "Mercado Pago quedó conectado" y la tarjeta pasa a "Conectado".
5. Elegir Mercado Pago como método y guardar.
6. Repetir el paso 3, copiar la URL de Mercado Pago antes de autorizar y abrirla en otro navegador con otra cuenta de Bellis (o sin sesión): no debe conectarse nada.
7. Desconectar y comprobar que la tarjeta vuelve a "No conectado".

Pruebas automáticas:

- `node --test supabase/tests/mercado_pago_oauth.test.mjs` — quién puede completar una conexión (casos A a H), token vigente, renovación, fallos y concurrencia.
- `supabase/tests/mercado_pago_oauth_smoke.sql` — los mismos casos A a H contra la base, la regla del método de cobro, permisos por rol, aislamiento entre workspaces, Vault, estado y desconexión. Usa datos sintéticos y `ROLLBACK`.
- `node --test supabase/tests/mercado_pago_checkout.test.mjs` — checkout y webhook con el token renovable: vigente, renovado, renovación simultánea, rechazos, vendedor incorrecto, sin conexión, monto manipulado y notificación duplicada.
- `node --test supabase/tests/booking_return.test.mjs` y `supabase/tests/booking_return_smoke.sql` — retorno del paciente: token válido, inválido, vencido, de otro profesional, pago aprobado, pendiente, rechazado, reintento y solicitud sin checkout.
- `node --test supabase/tests/mercado_pago_provider.test.mjs` y `supabase/tests/mercado_pago_smoke.sql` — checkout y webhook existentes.

## Carga manual (anterior a OAuth)

Sigue funcionando para un workspace de prueba: guardar el Access Token con `vault.create_secret(...)` y asociar el UUID a `private.mercado_pago_accounts` junto al `workspace_id`, `seller_user_id` y `environment='test'`. Esas filas no tienen refresh token ni vencimiento. No usarla con cuentas reales ni con un token de Bellis.

## Prueba sandbox del checkout

1. Cambiar `workspaces.payment_provider` del workspace de prueba a `mercado_pago_ar`. El servicio debe estar activo, con precio en ARS y formulario activo.
2. Configurar Webhooks de tipo `payment` en la aplicación con la URL `https://<ref-del-proyecto>.supabase.co/functions/v1/bellis-mp-webhook` y guardar la firma en `MERCADO_PAGO_WEBHOOK_SECRET`.
3. Abrir el perfil público, elegir un servicio y completar formulario y datos. Debe crearse una sola solicitud con `payments.status='pending'` y sin horarios reservables.
4. Pagar con comprador y tarjeta de prueba según la [guía oficial](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/integration-test/test-purchases).
5. Revisar la entrega del webhook. En Bellis el pago debe pasar a `approved` y habilitar los horarios solo después de consultar la operación real en Mercado Pago.
6. Repetir la notificación: debe quedar un pago y una sola transición de auditoría.
7. Probar un pago rechazado (sin horarios) y un precio manipulado en el navegador (el checkout usa el precio guardado del servicio).

## Antes de producción

- Completar G6.
- Registrar la URL de callback de Bellis, la URL de webhook y la firma de producción en la aplicación de Mercado Pago.
- Probar el flujo completo con cuentas de prueba y luego con una operación real controlada.
- No marcar Mercado Pago como activo para un profesional hasta que conecte su propia cuenta.
