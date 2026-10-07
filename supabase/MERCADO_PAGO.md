# Mercado Pago Argentina

Esta integración cobra **turnos de pacientes a la cuenta del profesional** mediante Checkout Pro. No cobra la suscripción de Bellis. La aprobación manual de links externos sigue disponible.

## Estado y límites

- **Implementado (fase 3):** checkout, webhook, verificación de la operación y conciliación al consultar estado, en Edge Functions.
- **Implementado (G2 y G2.1):** conexión por OAuth de la cuenta de cada workspace: inicio, retorno a una página de Bellis, intercambio del código, guardado de tokens en Vault, renovación, estado de conexión y desconexión.
- **Implementado (G3):** Perfil → Cobros y pagos permite conectar, ver el estado, desconectar y elegir entre Mercado Pago y link de pago externo. La base de datos rechaza Mercado Pago como método si el workspace no tiene una cuenta conectada.
- **Implementado (G4):** el checkout, la consulta de estado y el webhook usan el token renovable de la cuenta conectada. La preferencia vence junto con la solicitud. Al desconectar, el workspace vuelve al link externo.
- **Implementado (G5):** el paciente que vuelve de Mercado Pago recupera su solicitud con un token opaco, aunque vuelva en otra pestaña. Bellis consulta el estado real del pago y decide el paso. Una solicitud cuyo checkout no pudo crearse queda cerrada.
- **Implementado (G7A, sin desplegar):** códigos de error internos, logs estructurados, respuestas del webhook según el tipo de falla, cierre de solicitudes vencidas, regla para pagos tardíos, aviso al desconectar con pagos en curso y las secciones de operación de este documento. Requiere la migración `20261006090000_payment_hardening.sql` y volver a desplegar las tres funciones.
- **Todavía no implementado:**
  - Emails para retomar una solicitud y reembolsos iniciados desde Bellis.
  - Detección inmediata de la desvinculación desde Mercado Pago (`mp-connect`, ver más abajo).
  - La prueba sandbox de punta a punta (G6, **bloqueada**: falta una cuenta y una aplicación de Mercado Pago Argentina con credenciales de prueba) y la salida a producción (G7B).
- **Dónde está desplegado:** solo en **Staging** (G2 a G5: 29 migraciones y las tres funciones). Staging todavía no tiene `MERCADO_PAGO_CLIENT_ID` ni `MERCADO_PAGO_CLIENT_SECRET`, así que la pantalla muestra Mercado Pago sin poder conectar y el link externo sigue funcionando. **Producción no tiene nada de Mercado Pago.**

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
| `bellis-public`, `bellis-mp-webhook` | Edge Functions | Checkout y avisos de pago. |
| `_shared/bellis-webhook.ts` | Módulo de servidor | Qué responde el webhook a cada aviso. |
| `_shared/payment-errors.ts` | Módulo de servidor | Códigos de error, textos para el paciente y el formato de los logs. |

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
| `error` | Mercado Pago rechazó la renovación o dejó de aceptar el token. Hay que volver a conectar. |

`active` siempre vale lo mismo que `status = 'connected'`. La página pública pregunta por `mercado_pago_checkout_ready`, que aplica la misma regla que el panel y no lee ningún token.

### Transiciones

| Qué pasa | Estado después | Efecto |
| --- | --- | --- |
| El owner conecta o vuelve a conectar | `connected` | Reutiliza las entradas de Vault del workspace. Auditoría `mercado_pago_connected`. |
| El owner desconecta | `disconnected` | Se borran los tokens. El método de cobro vuelve a `external_link`. Auditoría `mercado_pago_disconnected`. |
| Mercado Pago rechaza la renovación para siempre (`400`/`401` con el refresh token) | `error` | Sin checkout hasta reconectar. Auditoría `mercado_pago_connection_error`, una sola vez. |
| Mercado Pago responde `401` a una llamada con el token guardado (permiso quitado desde su cuenta, cambio de contraseña) | `error` | Igual que el anterior. Se detecta en el primer uso, no en el momento de la revocación. |
| Mercado Pago caído, lento o con respuesta ilegible (`5xx`, `429`, red) | sin cambio | Se sigue usando el token vigente. Si ya venció, esa solicitud falla y la siguiente vuelve a intentar. |
| Mercado Pago rechaza las credenciales **de Bellis** (`invalid_client`) | sin cambio | Es configuración de Bellis, no del profesional: no se marca ninguna cuenta. Código `mp_config_missing`. |
| Falta `MERCADO_PAGO_CLIENT_ID` o `MERCADO_PAGO_CLIENT_SECRET` | sin cambio | No se intenta renovar. Con el token vigente todo sigue funcionando. |
| Token vencido y sin refresh token | `expired` (derivado) | Sin checkout hasta reconectar. |

`error` es siempre definitivo: nada lo saca de ahí salvo reconectar. Una falla de infraestructura nunca lleva a `error`.

Pendiente de confirmar en G6: que el rechazo de las credenciales de Bellis llegue con `error: "invalid_client"` en el cuerpo. Si Mercado Pago lo informara de otra forma, un client secret mal cargado marcaría como `error` cada cuenta que intente renovar.

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
| `bellis-public`, `status` y `resume` | Buscar el pago en Mercado Pago cuando el paciente consulta. Solo mientras la solicitud espera el pago. | La solicitud sigue pendiente y queda un log `payment_lookup_deferred`. |
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

Una solicitud dura 48 horas; un pago aprobado la extiende 30 días para elegir horario. Vencida, ninguna acción la acepta: `resume` responde 410 y el paciente ve "Esta reserva venció"; la pestaña que estaba consultando deja de hacerlo.

`expire_stale_booking_intents(p_limit)` cierra las solicitudes que vencieron sin pago: la solicitud pasa a `cancelled`, su pago a `expired` y queda la auditoría `booking_intent_expired`. No borra nada, no toca solicitudes pagas y se puede correr las veces que haga falta. **No está programada.** Sin ella nada se rompe (una solicitud vencida ya es inaccesible); lo que se acumula son filas en `pending_payment`. Para correrla a mano con la clave de servicio:

```sql
select public.expire_stale_booking_intents();
```

Si se decide programarla, alcanza con una línea de `pg_cron`, que el proyecto ya usa para las automatizaciones. Va en una migración propia:

```sql
select cron.schedule('bellis-expire-booking-intents','17 * * * *','select public.expire_stale_booking_intents()');
```

El panel ya no cuenta las solicitudes vencidas como pagos pendientes, esté o no programada la tarea.

### Pago tardío

La preferencia vence junto con la solicitud, así que Mercado Pago no acepta pagos nuevos después. Lo que sí puede pasar es que un pago **iniciado a tiempo** se apruebe después (un cupón de pago en efectivo abonado días más tarde), o que el aviso llegue cuando la solicitud ya venció o fue cancelada. La regla:

- El pago aprobado se verifica igual que cualquier otro: preferencia, solicitud, vendedor, monto y moneda.
- El pago **se registra**: queda `approved`, con su `provider_payment_id`, su `provider_event_id`, `approved_at` y la auditoría `mercado_pago_approved`.
- La solicitud **no se reactiva**. Si ya estaba `cancelled` sigue igual; si había vencido y la tarea de limpieza todavía no la había cerrado, se cierra en ese momento (`cancelled`, con `booking_intent_expired`). Nunca pasa a `awaiting_schedule`, no ofrece horarios, no se puede agendar desde ella y no se crea ningún turno. Su vencimiento no se extiende.
- Queda la auditoría `mercado_pago_late_payment_approved` sobre la solicitud: es la señal de que hay plata cobrada sin turno, para que una persona lo revise.
- Repetir el mismo aviso (webhook duplicado, o el mismo pago visto por una consulta de estado) no cambia nada y no duplica la auditoría. El webhook responde 200 en todos los casos.
- Mientras la solicitud está cerrada por vencimiento, un aviso de pago pendiente o rechazado no cambia nada.
- Bellis no devuelve dinero por su cuenta. Si el profesional reembolsa el pago desde Mercado Pago, el reembolso se registra como cualquier otro (pago `refunded`, solicitud `refunded`).

Para encontrar los pagos que esperan revisión:

```sql
select i.id as solicitud, i.workspace_id, p.provider_payment_id, p.amount_minor, p.approved_at
from public.audit_events a
join public.booking_intents i on i.id=a.object_id
join public.payments p on p.booking_intent_id=i.id
where a.action='mercado_pago_late_payment_approved' and p.status='approved'
order by p.approved_at desc;
```

El panel todavía no muestra estos casos: hoy se detectan con esa consulta. Qué hacer con cada uno (devolver el pago desde Mercado Pago o dar el turno a mano con una solicitud nueva) lo decide el profesional.

## Reembolsos y contracargos

Bellis no inicia reembolsos; registra los que ocurren en Mercado Pago.

| Estado en Mercado Pago | En Bellis | Efecto |
| --- | --- | --- |
| `refunded`, `charged_back` | `refunded` | La solicitud pasa a `refunded`, el turno agendado se cancela, auditoría `mercado_pago_refunded`. Debe ser el mismo pago que se aprobó. |
| `approved` con reembolso parcial | `approved` | Sin cambio: Mercado Pago mantiene el pago aprobado. Bellis no registra el monto devuelto. |
| `in_mediation` (reclamo abierto) | `pending` | Sin cambio sobre un pago aprobado. |
| Cualquier otro estado desconocido | — | El webhook responde 200, no registra nada y deja el log `payment_refused` con `mp_payment_status_unsupported`. |

Un pago reembolsado no vuelve a aprobarse ni reactiva la reserva, llegue lo que llegue después. El reembolso llega solo por webhook: la consulta de estado deja de preguntar una vez aprobado el pago.

## Desconectar con pagos en curso

Desconectar no se bloquea. Si hay pagos de Mercado Pago esperando confirmación, la pantalla avisa cuántos son antes de confirmar: "Si desconectás Mercado Pago ahora, Bellis no podrá verificar esos pagos hasta que vuelvas a conectarlo."

Mientras esté desconectado, esas solicitudes siguen en `pending_payment`, el webhook responde 503 y la consulta de estado no puede verificar. Al reconectar **la misma cuenta**, el siguiente aviso o consulta registra el pago. Si se conecta **otra cuenta**, los pagos de la anterior no se pueden verificar (el vendedor no coincide) y hay que resolverlos a mano. Mercado Pago reintenta cada aviso durante un tiempo limitado; pasado ese plazo queda la consulta de estado del paciente.

## Códigos de error

Cada falla tiene un código interno (`_shared/payment-errors.ts`). El código va al log y, como `code`, a la respuesta; el texto que lee el paciente es aparte y nunca lleva detalle técnico.

| Código | Qué significa | Qué ve el paciente o el profesional |
| --- | --- | --- |
| `mp_config_missing` | Falta una variable del servidor, o Mercado Pago rechazó las credenciales de Bellis | Paciente: "No pudimos iniciar el pago en este momento." |
| `mp_unavailable` | Mercado Pago respondió `5xx` o `429` | Igual |
| `mp_connection_missing` | El workspace no tiene cuenta conectada (o está en `error`) | Igual |
| `mp_connection_expired` | Token vencido y sin refresh token | Igual |
| `mp_connection_revoked` | Mercado Pago ya no acepta el token | Igual. Profesional: "Necesita atención" |
| `mp_refresh_failed` | No se pudo renovar el token | Igual |
| `mp_preference_failed` | No se pudo crear o guardar el checkout | Igual |
| `mp_payment_lookup_failed` | No se pudo leer el pago en Mercado Pago | Nada: la solicitud sigue pendiente |
| `mp_payment_mismatch` | El pago no corresponde a la solicitud (preferencia, vendedor, monto, moneda) | Nada: no se registra |
| `mp_payment_status_unsupported` | Estado de pago que Bellis no conoce | Nada: no se registra |
| `mp_oauth_invalid_state` | State inexistente, vencido, usado o de otra persona | Profesional: "No pudimos validar la conexión." |
| `mp_oauth_exchange_failed` | Falló el intercambio del código o el guardado | Profesional: "No pudimos conectar Mercado Pago." |
| `mp_webhook_invalid_signature` | Aviso sin firma válida | — (401) |
| `mp_webhook_malformed` | Aviso firmado con cuerpo inválido | — (400) |
| `booking_resume_invalid` | Token de retorno desconocido, de otro profesional o de una solicitud cerrada | "No pudimos recuperar esta reserva." |
| `booking_resume_expired` | La solicitud venció | "Esta reserva venció." |
| `booking_intent_invalid` | Token de solicitud desconocido o vencido | "La solicitud venció o no existe" |
| `booking_payment_pending` | Se pidió horario sin pago aprobado | "El pago todavía no está confirmado" |
| `booking_slot_unavailable` | El horario ya no está libre | "Ese horario ya no está disponible. Elegí otro." |
| `rate_limited`, `internal_error` | Límite de pedidos; falla no prevista | Mensaje genérico |

`booking_payment_rejected` está reservado: hoy un pago rechazado se informa como estado del pago (`paymentStatus`), no como error.

Los resultados de la conexión que viajan en `?mp=` (`connected`, `cancelled`, `invalid_state`, `error`) no cambian: son el contrato con la pantalla.

## Logs

Las tres funciones escriben una línea JSON por evento, con un conjunto fijo de campos: `ts`, `fn`, `event`, `workspace_id`, `intent_id`, `payment_id`, `provider`, `status`, `error_code`, `action`, `topic`, `http_status`, `retry`, `changed`, `environment`. Cualquier otro campo se descarta, y un valor que no parezca un id o un código corto (más de 48 caracteres, o con forma de token) también.

Nunca se escribe: access token, refresh token, client secret, código de autorización, state, token de retorno, cuerpos de pedidos o respuestas de Mercado Pago, mensajes de error de terceros, ni datos del paciente.

| Evento | Función | Cuándo |
| --- | --- | --- |
| `config_missing` | `bellis-public`, `bellis-mp-oauth` | Al iniciar sin una variable necesaria |
| `webhook_not_configured` | `bellis-mp-webhook` | Llegó un aviso y falta la firma en el servidor |
| `oauth_connected`, `oauth_not_connected` | `bellis-mp-oauth` | Al completar una conexión |
| `checkout_created`, `checkout_unavailable`, `checkout_failed` | `bellis-public` | Al crear una solicitud con Mercado Pago |
| `payment_recorded`, `payment_lookup_deferred` | `bellis-public` | Al consultar el estado |
| `booking_refused` | `bellis-public` | Al rechazar un horario |
| `payment_recorded`, `payment_unchanged` | `bellis-mp-webhook` | Aviso procesado; el segundo es un aviso repetido |
| `payment_deferred` | `bellis-mp-webhook` | Falla temporal: se pide reintento |
| `payment_refused` | `bellis-mp-webhook` | Falla definitiva: no se reintenta. **Revisar siempre.** |
| `webhook_rejected`, `webhook_ignored`, `webhook_unroutable` | `bellis-mp-webhook` | Firma o cuerpo inválidos; otro tipo de aviso; aviso sin solicitud |
| `request_failed` | `bellis-public`, `bellis-mp-oauth` | Falla no prevista (500) |

## Webhook

| Caso | Respuesta | Reintenta Mercado Pago |
| --- | --- | --- |
| Sin firma, firma inválida, o `ts` a más de 10 minutos | 401 | Sí |
| Falta `MERCADO_PAGO_WEBHOOK_SECRET` en el servidor | 503 | Sí |
| Firmado, cuerpo ilegible o que no coincide con `data.id` | 400 | Sí |
| Firmado, otro tipo de aviso (`mp-connect`, reclamos, etc.) | 200, ignorado | No |
| Firmado, sin `intent` o de una solicitud que no existe | 200, `webhook_unroutable` | No |
| Pago verificado y registrado | 200 | No |
| El mismo aviso otra vez | 200, sin duplicar | No |
| Mercado Pago caído, pago todavía no visible, base de datos caída, cuenta desconectada o token rechazado | 503 | Sí |
| El pago no corresponde a la solicitud, reembolso de otro pago, estado desconocido | 200, `payment_refused` | No |

Mercado Pago espera 200 o 201 dentro de 22 segundos; si no, reintenta cada 15 minutos y después espacia los intentos.

**Repetición.** La firma cubre `data.id`, `x-request-id` y `ts`. Un aviso capturado solo sirve para ese mismo pago y durante 10 minutos, y repetirlo no cambia nada: el estado se lee siempre de Mercado Pago con el token del vendedor y el registro es idempotente. El parámetro `intent` no está firmado; si se cambia, el pago leído no corresponde a esa solicitud y se rechaza.

**Riesgos pendientes para G6.** Nada de esto se pudo probar contra Mercado Pago real:

1. **Firma en `notification_url`.** Bellis recibe los avisos por la `notification_url` de cada preferencia, con `?intent=`. La documentación dice que esa URL tiene prioridad sobre la configurada en la aplicación, pero no afirma que esos avisos lleven `x-signature`. Si llegaran sin firma, todos darían 401 y los pagos se confirmarían solo por la consulta de estado del paciente.
2. **Formato del aviso.** Si llegara el formato IPN (`?topic=payment&id=…`) en lugar de `?data.id=…&type=payment`, también daría 401.
3. **`ts` en los reintentos.** Si un reintento conserva el `ts` original, todo reintento posterior a 10 minutos daría 401, y el camino "503 y reintentar" no serviría.
4. **`ts` en segundos o milisegundos.** Se aceptan ambos; hay que confirmar cuál llega.

En los cuatro casos el respaldo es el mismo: la página del paciente consulta el estado cada 8 segundos y al volver del checkout.

## `mp-connect` (vinculación y desvinculación)

Mercado Pago ofrece el tema `mp-connect` ("Vinculación de aplicaciones") para toda integración con OAuth:

- **Cómo llega:** por los Webhooks configurados en la aplicación (Tus integraciones → Webhooks), no por la `notification_url` de una preferencia. `POST …?data.id=<id>&type=mp-connect`.
- **Firma:** la misma `x-signature` con la misma clave secreta.
- **Cuerpo:** `action` (`application.authorized` o `application.deauthorized`), `data.id`, `user_id` ("vendedor para el que se envía la notificación"), `id`, `date_created`, `live_mode`, `type`.
- **Sirve para detectar la revocación:** sí, es su propósito.

**No se implementó.** Requiere configurar Webhooks en una aplicación que todavía no existe, y la documentación no deja claro si el vendedor que desvincula viaja en `user_id`, en `data.id` o en ambos. Lo que sí quedó: el webhook reconoce el aviso, responde 200 y registra `webhook_ignored` con `topic` y `action`, de modo que no rompe nada y en G6 se puede ver qué llega.

Hoy la revocación se detecta en el primer uso del token (Mercado Pago responde 401 y la conexión pasa a `error`).

Propuesta mínima, para después de G6:

1. Activar "Vinculación de aplicaciones" en los Webhooks de la aplicación, con la URL de `bellis-mp-webhook`.
2. En el webhook, para `application.deauthorized`: buscar la cuenta `connected` cuyo `seller_user_id` sea el vendedor informado y pasarla a `error` con una función nueva de servidor, con auditoría. Es idempotente: una cuenta que ya no está `connected` no cambia.
3. Ignorar el aviso si su `date_created` es anterior a `connected_at`, para que una desvinculación vieja no tire una reconexión nueva.
4. `application.authorized` no hace nada: la conexión la completa el flujo OAuth.

## Reintentos e idempotencia

| Operación | Repetirla | Por qué |
| --- | --- | --- |
| OAuth, iniciar | Segura | Cada inicio invalida el state anterior del workspace. Límite de 10 cada 10 minutos por persona. |
| OAuth, completar | No se repite | El state y el código son de un solo uso. Un segundo intento responde `invalid_state` sin efecto. Si falló, se empieza de nuevo. |
| Guardar la conexión | Segura | Reemplaza la conexión del workspace reutilizando sus entradas de Vault. |
| Renovar el token | Segura | Reserva de 30 segundos: una sola solicitud renueva, las demás usan el token vigente. Si la renovación se concreta en Mercado Pago pero no se guarda, la siguiente usa el refresh token anterior; si Mercado Pago ya lo invalidó, la conexión pasa a `error`. |
| Desconectar | Segura | Una cuenta ya desconectada no cambia ni genera auditoría. |
| Crear solicitud y checkout | **No idempotente** | Cada envío del formulario crea una solicitud y una preferencia nuevas. Límite de 8 por hora por IP. Si la preferencia se crea pero no se guarda, la solicitud se cierra y esa preferencia queda huérfana en Mercado Pago: un pago hecho ahí se rechazaría por no coincidir. |
| Consultar el pago (`status`, `resume`) | Segura | Solo lee de Mercado Pago; registrar el mismo estado no cambia nada. |
| Webhook | Segura | Ídem. El mismo aviso da 200 sin duplicar. |
| Recuperar con el token de retorno | Segura | Reutilizable mientras dure la solicitud. |
| Confirmar el turno | Segura | Una solicitud tiene un solo turno (`appointments.booking_intent_id` es único). Repetir devuelve el turno existente. |
| Cerrar solicitudes vencidas | Segura | Cada solicitud se cierra una vez. |

## Dos pestañas

La pestaña original y la que vuelve de Mercado Pago tienen cada una su token, y los dos sirven para la misma solicitud: ambas pueden consultar el estado, ver horarios y confirmar.

Si las dos confirman, se crea **un solo turno**. `schedule_paid_intent` bloquea la solicitud, y la restricción única de `appointments.booking_intent_id` es la fuente de verdad aunque esa verificación fallara. La pestaña que llega segunda recibe el turno que ya existe, aunque haya elegido otro horario, en lugar de un error. Dos pacientes distintos que eligen el mismo horario se resuelven con la restricción `appointments_no_overlap`: el segundo recibe `booking_slot_unavailable`.

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

Sin `MERCADO_PAGO_CLIENT_ID`, `MERCADO_PAGO_CLIENT_SECRET` y `BELLIS_SITE_ORIGIN`, `bellis-mp-oauth` responde 503 a quien tenga sesión (401 a quien no) y no se inicia ni completa ningún flujo.

`BELLIS_SITE_ORIGIN` no tiene valor por defecto. Sin ella, `bellis-public` rechaza cualquier origen que no sea `localhost` y registra `config_missing`: un entorno sin configurar no puede mandar pacientes al sitio de otro entorno.

Las tres funciones necesitan las mismas variables de Mercado Pago, porque las tres pueden tener que renovar un token.

| Variable | Staging | Producción |
| --- | --- | --- |
| `MERCADO_PAGO_CLIENT_ID`, `MERCADO_PAGO_CLIENT_SECRET` | De la aplicación de prueba | De la aplicación productiva |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Firma de esa aplicación | Firma de la aplicación productiva |
| `MERCADO_PAGO_OAUTH_TEST_TOKEN` | `true` | **Sin definir** |
| `MERCADO_PAGO_REDIRECT_URI` | Sin definir, o el callback de staging | Sin definir, o el callback de producción |
| `BELLIS_SITE_ORIGIN` | Origen del sitio de staging | Origen del sitio de producción |
| `BELLIS_ADDITIONAL_ORIGINS` | Previews autorizados, si hay | Vacía |

## URL de callback

La URL que hay que registrar en la aplicación de Mercado Pago (Redirect URL) es la página de Bellis:

```
<BELLIS_SITE_ORIGIN>/mercado-pago/callback
```

- Producción: `https://bellis-six.vercel.app/mercado-pago/callback` (o el dominio definitivo cuando exista).
- Staging: `<origen del sitio de staging>/mercado-pago/callback`, registrada en la aplicación **de prueba**. Nunca la de producción.
- Local: `http://localhost:5173/mercado-pago/callback`. Si Mercado Pago no acepta registrar una URL sin HTTPS, usar un túnel HTTPS y ponerlo en `MERCADO_PAGO_REDIRECT_URI`.
- Sin parámetros ni barra final. Debe coincidir carácter por carácter con la que usa la función: la misma URL viaja en la autorización y en el intercambio.
- Sale de `BELLIS_SITE_ORIGIN`, así que cada entorno usa la suya sin tocar código. `MERCADO_PAGO_REDIRECT_URI` la reemplaza cuando hace falta.
- Mercado Pago solo devuelve a la URL registrada: una preview de Vercel no sirve como callback salvo que se registre.

`bellis-mp-oauth` se despliega con `verify_jwt = false` (ver `supabase/config.toml`) únicamente para que el preflight de CORS del navegador, que no lleva sesión, no sea rechazado. Las dos acciones verifican la sesión contra Supabase Auth dentro de la función.

## Sandbox y producción

- El entorno de cada conexión (`test` o `production`) se guarda según lo que informa Mercado Pago al entregar el token (`live_mode`).
- Para probar: crear vendedor y comprador de prueba, poner `MERCADO_PAGO_OAUTH_TEST_TOKEN=true` y autorizar con el vendedor de prueba.
- Hay dos proyectos de Supabase separados (ver "Separación de entornos"). El que la documentación vieja llamaba "desarrollo" es el de producción.

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
- `node --test supabase/tests/payment_hardening.test.mjs` y `supabase/tests/payment_hardening_smoke.sql` — G7A: respuestas del webhook, reintentos, estados de la conexión, pago tardío, solicitud vencida, reembolso, dos pestañas, desconexión con pago en curso, configuración faltante, logs y cruce de entornos.

Los `.sql` se corren **en Staging o en una base local, nunca en producción**. Para una base local alcanza con la imagen `supabase/postgres`, aplicar las migraciones en orden y correr cada archivo con `psql -v ON_ERROR_STOP=1`.

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

## Separación de entornos

| | Staging | Producción |
| --- | --- | --- |
| Rama | `staging` | `main` |
| Proyecto de Supabase | `hbvmcvemrkfovzhlpgys` (Bellis Staging) | `pinfdbvfzoratsntjgah` |
| Migraciones de Mercado Pago | Aplicadas | **No aplicadas** |
| `bellis-mp-oauth`, `bellis-mp-webhook` | Desplegadas | **No desplegadas** |
| Aplicación de Mercado Pago | De prueba (todavía no existe) | Productiva (todavía no existe) |

Todo cambio de Mercado Pago se hace en `staging`. Checklist antes de cada deploy y antes de cada prueba:

- [ ] `supabase projects list` y `cat supabase/.temp/project-ref`: el proyecto enlazado es el que corresponde. Un `supabase db push` o `functions deploy` va a donde apunte ese archivo.
- [ ] En Vercel, las variables `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` del entorno **Preview** (rama `staging`) son de Staging y las de **Production** son de producción. Las de **Development** son las que baja `vercel env pull` a `.env.local`.
- [ ] `node scripts/payments-health.mjs` con `BELLIS_SITE_URL` pasa la línea "site talks to this same Supabase project".
- [ ] `supabase secrets list` en Staging: ninguna credencial productiva. `MERCADO_PAGO_OAUTH_TEST_TOKEN=true`.
- [ ] `supabase secrets list` en producción: `MERCADO_PAGO_OAUTH_TEST_TOKEN` **no existe**.
- [ ] `BELLIS_SITE_ORIGIN` de cada proyecto es el sitio de ese mismo entorno.
- [ ] En cada aplicación de Mercado Pago, la Redirect URL y la URL de Webhooks apuntan al sitio y al proyecto del mismo entorno. Nada de la aplicación de prueba apunta a producción ni al revés.
- [ ] En Staging, toda fila de `private.mercado_pago_accounts` tiene `environment = 'test'`. En producción, `'production'`.
- [ ] Los `.sql` de `supabase/tests/` no se corren en producción.

Hallazgos de la auditoría G7A, sin resolver porque están fuera del repositorio:

- El `.env.local` de este entorno de trabajo (generado por `vercel env pull`) apunta al proyecto de **producción**. `npm run dev` en local trabaja contra datos reales. Conviene que el entorno Development de Vercel use Staging.
- La configuración de Vercel y los secretos de cada proyecto no se pudieron leer desde el repositorio: el checklist de arriba hay que recorrerlo a mano.

## Orden de deploy

Staging:

1. **Migraciones.** `supabase db push` con el proyecto de Staging enlazado. Las funciones nuevas dependen de ellas (`bellis-public` llama a `mercado_pago_checkout_ready`).
2. **Secrets.** Los de la tabla de variables. Sin valores productivos.
3. `supabase functions deploy bellis-mp-oauth`
4. `supabase functions deploy bellis-public`
5. `supabase functions deploy bellis-mp-webhook`
6. **Frontend de staging.** Push a `staging`; Vercel despliega el preview.
7. **Callback de Mercado Pago.** Registrar `<sitio de staging>/mercado-pago/callback` en la aplicación de prueba.
8. **Webhook.** Configurar en la aplicación la URL `https://<ref>.supabase.co/functions/v1/bellis-mp-webhook`, tema Pagos, y cargar su firma en `MERCADO_PAGO_WEBHOOK_SECRET`.
9. **Chequeos.** `node scripts/payments-health.mjs` y la consulta de funciones de más abajo.
10. **Sandbox de punta a punta** (G6).

Producción: el mismo orden, **solo después de G6 aprobado**, con la aplicación productiva, sin `MERCADO_PAGO_OAUTH_TEST_TOKEN` y con una copia de respaldo de la base antes del paso 1. Mercado Pago no se ofrece a ningún profesional hasta completar el paso 9.

Entre el paso 4 y el 6 conviven la función nueva y el frontend anterior. Lo único que cambia en ese rato es un texto: a una solicitud vencida el frontend anterior le muestra "No pudimos recuperar esta reserva" en lugar de "Esta reserva venció". El frontend nuevo distingue ese caso por el código HTTP (410) y funciona con cualquiera de las dos versiones de la función.

## Rollback

| Qué falla | Qué hacer |
| --- | --- |
| Frontend | En Vercel, promover el deploy anterior. No toca datos. |
| Una Edge Function | Volver a desplegar la versión anterior desde su commit: `git checkout <commit> -- supabase/functions && supabase functions deploy <nombre>`. Las versiones anteriores de `bellis-public` no usan `mercado_pago_checkout_ready`, así que funcionan con o sin la migración nueva. |
| OAuth (no se puede conectar) | No ofrecer Mercado Pago a nuevos workspaces. Los ya conectados siguen cobrando: conectar y cobrar son caminos separados. |
| Webhook | No hace falta revertir nada de urgencia: la página del paciente consulta el estado y confirma el pago igual. Corregir y volver a desplegar; Mercado Pago reintenta los avisos pendientes. |
| Checkout (no se crean preferencias) | Cada profesional afectado puede pasar a link de pago externo desde Cobros y pagos. No cambiar `payment_provider` en masa por SQL. |
| Credenciales comprometidas | Rotar client secret y firma en Mercado Pago y cargar los nuevos secretos. Los tokens de los vendedores no cambian. |
| Migración | Las de Mercado Pago solo agregan tablas, columnas y funciones: no se revierten borrando. Para volver al comportamiento anterior de `record_mercado_pago_payment`, crear una migración nueva con la definición de `20260929000000_mercado_pago_ar.sql`. Nunca aplicar una migración que borre o reescriba datos sin respaldo y plan escrito. |

No borrar filas de `payments`, `booking_intents`, `private.mercado_pago_accounts` ni secretos de Vault como parte de un rollback.

## Chequeos de salud

Sin secretos ni sesión; cualquiera podría enviar estos pedidos:

```
BELLIS_SUPABASE_URL=https://<ref>.supabase.co BELLIS_SITE_URL=https://<sitio> node scripts/payments-health.mjs
```

Comprueba que `bellis-public` responde y llega a la base, que rechaza orígenes ajenos y tokens inventados, que `bellis-mp-oauth` responde 401 sin sesión, que el webhook responde 401 sin firma y con firma falsa, que el sitio y el callback cargan y que el sitio usa ese mismo proyecto de Supabase. No crea ni modifica nada.

Con acceso a la base (SQL Editor del proyecto), las funciones esperadas:

```sql
select count(*) = 16 as ok from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('mercado_pago_credentials','mercado_pago_checkout_ready','mercado_pago_connection_status',
  'start_mercado_pago_oauth','consume_mercado_pago_oauth_state','store_mercado_pago_connection','claim_mercado_pago_refresh',
  'rotate_mercado_pago_tokens','fail_mercado_pago_refresh','disconnect_mercado_pago','create_checkout_intent',
  'attach_mercado_pago_checkout','cancel_unpaid_intent','record_mercado_pago_payment','expire_stale_booking_intents','schedule_paid_intent');
```

A mano, con una sesión de owner: Perfil → Cobros y pagos muestra el estado de la conexión (eso es `mercado_pago_connection_status`). Y el flujo de reserva con link externo de un workspace de prueba sigue funcionando de punta a punta.

No hay ni debe haber un endpoint público de diagnóstico: el estado de la configuración solo se ve en los logs (`config_missing`).

## CI

El repositorio no tiene CI. Propuesta mínima, sin implementar, para `.github/workflows/ci.yml` en push y pull request a `staging` y `main`:

1. `npm ci`
2. `npx tsc --noEmit`
3. `npm run build`
4. `node --test supabase/tests/*.test.mjs tests/*.mjs`
5. `deno check supabase/functions/*/index.ts` (con `denoland/setup-deno`)
6. `npm run lint` — hoy falla por errores anteriores a esta fase; activarlo después de corregirlos, o limitarlo a los archivos cambiados.
7. Opcional: un job con la imagen `supabase/postgres` que aplique las migraciones y corra los `*_smoke.sql` de pagos.

No necesita ningún secreto.

## Antes de producción

- Completar G6, incluidos los riesgos pendientes del webhook.
- Recorrer el checklist de "Separación de entornos" y el "Orden de deploy".
- Registrar la URL de callback de Bellis, la URL de webhook y la firma de producción en la aplicación de Mercado Pago.
- Probar el flujo completo con cuentas de prueba y luego con una operación real controlada.
- No marcar Mercado Pago como activo para un profesional hasta que conecte su propia cuenta.
