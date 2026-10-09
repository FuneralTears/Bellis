# Mercado Pago Argentina

Esta integración cobra **turnos de pacientes a la cuenta del profesional** mediante Checkout Pro. No cobra la suscripción de Bellis. La aprobación manual de links externos sigue disponible.

## Estado y límites

- **Implementado (fase 3):** checkout, webhook, verificación de la operación y conciliación al consultar estado, en Edge Functions.
- **Implementado (G2 y G2.1):** conexión por OAuth de la cuenta de cada workspace: inicio, retorno a una página de Bellis, intercambio del código, guardado de tokens en Vault, renovación, estado de conexión y desconexión.
- **Implementado (G3):** Perfil → Cobros y pagos permite conectar, ver el estado, desconectar y elegir entre Mercado Pago y link de pago externo. La base de datos rechaza Mercado Pago como método si el workspace no tiene una cuenta conectada.
- **Implementado (G4):** el checkout, la consulta de estado y el webhook usan el token renovable de la cuenta conectada. La preferencia vence junto con la solicitud. Al desconectar, el workspace vuelve al link externo.
- **Implementado (G5):** el paciente que vuelve de Mercado Pago recupera su solicitud con un token opaco, aunque vuelva en otra pestaña. Bellis consulta el estado real del pago y decide el paso. Una solicitud cuyo checkout no pudo crearse queda cerrada.
- **Implementado (G7A):** códigos de error internos, logs estructurados, respuestas del webhook según el tipo de falla, cierre de solicitudes vencidas, regla para pagos tardíos, aviso al desconectar con pagos en curso y las secciones de operación de este documento. Requiere la migración `20261006090000_payment_hardening.sql` y volver a desplegar las tres funciones.
- **Todavía no implementado:**
  - Emails para retomar una solicitud y reembolsos iniciados desde Bellis.
  - Detección inmediata de la desvinculación desde Mercado Pago (`mp-connect`, ver más abajo).
  - La prueba sandbox de punta a punta (G6, **bloqueada**: falta una cuenta y una aplicación de Mercado Pago Argentina con credenciales de prueba) y la salida a producción (G7B).
- **Dónde está desplegado:** en **Staging** y en **Producción** desde el 2026-10-09 (30 migraciones y las tres funciones en ambos). El detalle está en "Release de producción (2026-10-09)".

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

`expire_stale_booking_intents(p_limit)` cierra las solicitudes que vencieron sin pago: la solicitud pasa a `cancelled`, su pago a `expired` y queda la auditoría `booking_intent_expired`. No borra nada, no toca solicitudes pagas y se puede correr las veces que haga falta. **Todavía no está programada en ningún entorno** (verificado en `cron.job` de los dos proyectos el 2026-10-09): la migración que la programa está escrita y sin aplicar. Sin ella nada se rompe (una solicitud vencida ya es inaccesible); lo que se acumula son filas en `pending_payment`. Para correrla a mano con la clave de servicio:

```sql
select public.expire_stale_booking_intents();
```

#### Programarla (migración preparada, sin aplicar)

El proyecto ya usa `pg_cron` para las automatizaciones, así que no hace falta nada nuevo. La migración `supabase/migrations/20261009090000_expire_booking_intents_cron.sql` registra la tarea `bellis-expire-booking-intents`, cada 15 minutos. Antes de registrarla comprueba que exista la función y falla si falta.

**No está aplicada en ningún proyecto.** Al estar en `supabase/migrations/`, el próximo `supabase db push` la aplica en el proyecto que esté enlazado: no correr `db push` contra un entorno donde todavía no se quiera la tarea.

Revisión del 2026-10-09 — **lista para producción**:

| Criterio | Resultado |
| --- | --- |
| Frecuencia | Cada 15 minutos (`*/15 * * * *`). |
| Idempotente | Sí. `cron.schedule` con nombre reemplaza la tarea (pg_cron 1.6.4 en ambos proyectos); la función devuelve 0 en la segunda corrida. La migración se aplicó dos veces en una base local (`supabase/postgres` 15.8.1.060): queda una sola tarea. |
| Solo `pending_payment` vencidas | Sí: `status='pending_payment' and expires_at<now()` y sin pago `approved` ni `refunded`. |
| No toca `scheduled`, `awaiting_schedule`, pagos `approved` ni `refunded` | Sí, por el filtro anterior; el pago solo cambia si no está `approved` ni `refunded`. Cubierto por `payment_hardening_smoke.sql`. |
| Sin secretos | Sí. Corre dentro de la base como `postgres`, dueño de la función; sin red ni Vault. |
| Sin loops | Sí. El único trigger que dispara es `payment_automation_enqueue`, que solo actúa cuando un pago pasa a `pending`. Una solicitud cerrada deja de cumplir el filtro. |

Al 2026-10-09 había 0 solicitudes vencidas sin cerrar en producción y 1 en Staging: la primera corrida no cierra nada en producción.

| | |
| --- | --- |
| Qué cambia | Una solicitud `pending_payment` con `expires_at` pasado y sin pago aprobado ni reembolsado: pasa a `cancelled`, su pago a `expired`, auditoría `booking_intent_expired`. Una vez. |
| Qué no toca | `awaiting_schedule`, `payment_confirmed`, `scheduled`, `completed`, `refunded`, ni nada que tenga un pago `approved` o `refunded`. No borra. |
| Con qué permisos corre | Dentro de la base, como su dueño. Sin llamadas de red, sin secretos y sin permisos nuevos: la función sigue siendo ejecutable solo por `service_role`. |
| Carga | Hasta 500 solicitudes por corrida, con `SKIP LOCKED`: no espera a un pago que se está registrando en ese momento. |
| Repetirla | `cron.schedule` reemplaza la tarea del mismo nombre. Correr el script dos veces no duplica nada. |
| Un pago que llega justo después | Es el caso de "Pago tardío": se registra y la solicitud sigue cerrada. |

Para aplicarla, cuando se decida, primero en Staging y después en producción (`supabase migration list` tiene que mostrar solo `20261009090000` como pendiente):

```
npx supabase link --project-ref <ref>
npx supabase migration list --linked
npx supabase db push --linked
```

Para comprobarla y para apagarla:

```sql
select jobname,schedule,active from cron.job where jobname='bellis-expire-booking-intents';
select d.status,d.return_message,d.start_time from cron.job_run_details d join cron.job j using(jobid)
  where j.jobname='bellis-expire-booking-intents' order by d.start_time desc limit 5;
select cron.unschedule('bellis-expire-booking-intents');
```

`cron.job_run_details` crece con cada corrida (96 filas por día): conviene limpiarla junto con la de las automatizaciones.

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

#### En el panel

El profesional ve estos casos en dos lugares, sin tablas ni funciones nuevas:

- **Perfil → Cobros y pagos**, sección "Pagos recibidos fuera de término": paciente, servicio, monto, fecha de aprobación, la marca "Sin turno" y un acceso a la ficha del paciente. La pestaña muestra la cantidad. La sección no aparece si no hay ninguno.
- **Ficha del paciente**: en Pagos, el pago lleva la etiqueta "Fuera de término" en lugar de "Aprobado"; en el historial, "Pago recibido fuera de término … sin turno".

La regla es una sola y está en `lib/late-payments.ts`: pago de Mercado Pago `approved` sobre una solicitud `cancelled`. Ese par de estados solo lo produce `record_mercado_pago_payment` en el camino de pago tardío (el mismo que deja la auditoría). El panel no lee `audit_events`: ningún miembro del workspace tiene permiso de lectura sobre esa tabla, y no hizo falta dárselo.

El panel solo muestra. No reactiva la solicitud, no ofrece horarios y no agenda. Qué hacer con cada pago lo decide el profesional: devolverlo desde Mercado Pago (el reembolso llega por webhook, la solicitud pasa a `refunded` y el caso sale de la lista) o coordinar un turno con una solicitud nueva.

Límites conocidos:

- No hay "marcar como revisado". Un pago que el profesional decide conservar (porque dio el turno por otra vía) sigue en la lista. Resolverlo necesita guardar ese dato, es decir una migración.
- Ese pago suma en "Ingresos cobrados" del Resumen, porque el dinero efectivamente se cobró.
- El panel carga hasta 300 pagos y 300 solicitudes del workspace; más allá de eso un caso viejo podría no verse en Cobros (sí en la ficha del paciente).

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
| `webhook_rejected`, `webhook_ignored`, `webhook_unroutable` | `bellis-mp-webhook` | Firma o cuerpo inválidos; otro tipo de aviso, o un aviso en formato IPN (`topic` empieza con `ipn:`); aviso sin solicitud |
| `request_failed` | `bellis-public`, `bellis-mp-oauth` | Falla no prevista (500) |

## Webhook

### Formatos de aviso

| Formato | Cómo llega | Firma | Qué hace Bellis |
| --- | --- | --- | --- |
| **Webhook** de pago | `POST …?data.id=<pago>&type=payment`, cuerpo JSON con `type` y `data.id` | `x-signature` + `x-request-id` | **El único que se procesa.** Verifica la firma, lee el pago en Mercado Pago y lo registra. |
| Webhook de otro tema (`mp-connect`, `order`, reclamos…) | `POST …?data.id=<id>&type=<tema>` | La misma | 200, `webhook_ignored`. No toca pagos. |
| **IPN** de pago (formato anterior) | `POST …?topic=payment&id=<pago>` | **No tiene** | 200, `webhook_ignored` con `topic: ipn:payment`. **No se procesa.** |
| IPN de otros temas (`merchant_order`, `chargebacks`, `point_integration_ipn`, `delivery`, `invoice`…) | `POST …?topic=<tema>&id=<id>` | No tiene | 200, `webhook_ignored` con `topic: ipn:<tema>`. No se procesa. |
| Cualquier otra cosa sin firma | — | — | 401. |

Por qué 200 y no 401 para IPN. Un aviso IPN no trae nada con qué comprobar quién lo envió, así que **nunca se toma como un pago**: no se lee la solicitud, no se pide el token del vendedor, no se consulta Mercado Pago y no se escribe nada. Responder 401 tampoco agregaría seguridad (ya no se procesa) y sí haría que Mercado Pago lo reintente durante días por un aviso que Bellis no va a usar nunca. El 200 dice "recibido", no "aceptado". El pago no depende de ese aviso: llega por el Webhook firmado y, si no, por la consulta de estado de la página del paciente.

Se reconoce como IPN un pedido con `topic` y sin `data.id`. Si trae `data.id`, va por el camino firmado aunque también traiga `topic`. La decisión se toma antes de mirar el secreto: un servidor sin `MERCADO_PAGO_WEBHOOK_SECRET` tampoco pide reintentos de IPN.

Si en los logs aparece `ipn:payment` y **no** aparecen `payment_recorded` del webhook, la aplicación de Mercado Pago está enviando solo IPN: hay que configurar Webhooks (Tus integraciones → Webhooks → tema Pagos). Los pagos se siguen confirmando por la consulta de estado, pero más tarde.

Bellis no implementa IPN y no lo va a implementar: Mercado Pago lo da por discontinuado a favor de Webhooks. Lo afirmado acá sobre IPN (sin firma, reintentos) sale de la documentación de Mercado Pago tal como se conocía al escribir G7B; no se volvió a contrastar con la documentación en línea.

### Respuestas

| Caso | Respuesta | Reintenta Mercado Pago |
| --- | --- | --- |
| Formato IPN (`?topic=…&id=…`, sin firma) | 200, ignorado, **no se procesa** | No |
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
2. **Formato del aviso.** Resuelto en G7B: el formato IPN (`?topic=payment&id=…`) se responde 200 y se ignora (ver "Formatos de aviso"). En G6 el Webhook firmado llegó por la `notification_url` y el duplicado real respondió 200/200.
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

- `node --test tests/late-payments.mjs` — G7B: qué cuenta como pago fuera de término, la lista del panel y cómo lo nombra la ficha del paciente.
- `node --test tests/assert-staging-env.mjs` — G7B: la guarda de entorno, por archivo, por variable exportada y por proyecto enlazado.
- Los formatos de aviso (Webhook firmado, IPN de pago, otros temas IPN) están en `payment_hardening.test.mjs`, casos "IPN A" a "IPN C".

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

### Guarda de entorno

`vercel env pull` escribe en `.env.local` las variables del entorno Development de Vercel, que hoy apuntan a **producción**. Para que una rama que no es `main` no llegue ahí por accidente hay tres capas:

1. **Overrides locales.** `.env.development.local` (para `next dev`) y `.env.production.local` (para `next build` / `next start`) fijan `SUPABASE_URL` en Staging. Next.js los lee antes que `.env.local`, y `vercel env pull` no los pisa. Están ignorados por Git. Si falta la clave publicable de Staging, el sitio responde "Supabase no está configurado" en lugar de usar otra.
2. **`scripts/assert-staging-env.mjs`.** Lee la dirección del proyecto de los mismos archivos y en el mismo orden que Next.js, y el proyecto al que está enlazado el CLI de Supabase. En cualquier rama que no sea `main` falla (código 1) si alguno de los tres caminos llega a producción o a un proyecto que no conoce. Imprime solo refs de proyecto, nunca una clave; no escribe nada ni hace pedidos.
3. **`npm run dev` lo corre solo** (`predev`). Con `.env.local` de producción y sin override, en `staging` el servidor no arranca.

```
npm run env:check                              # los tres caminos
node scripts/assert-staging-env.mjs --dev      # lo que usaría next dev
node scripts/assert-staging-env.mjs --build    # lo que usaría next build / next start
node scripts/assert-staging-env.mjs --cli      # a dónde iría supabase db push / functions deploy
```

Antes de una migración o de un deploy desde `staging`: `node scripts/assert-staging-env.mjs --cli && npx supabase db push`. En `main` el script deja pasar producción: ahí la guarda es el runbook de más abajo.

Lo que el script no cubre: un `--project-ref` o un `--db-url` escritos a mano en el comando, las variables cargadas en Vercel y los secretos de cada proyecto. Para Vercel sigue valiendo el checklist de arriba y la línea "site talks to this same Supabase project" de `payments-health.mjs`. Lo que cerraría el problema de raíz, fuera del repositorio: que el entorno **Development** de Vercel use Staging, así `vercel env pull` deja de traer producción.

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

### Si falla `mercado_pago_checkout_ready`

`bellis-public` la llama al armar el perfil público, **solo** para un workspace con Mercado Pago como método y solo si existe `MERCADO_PAGO_WEBHOOK_SECRET`. Si la función falta o falla, el perfil público de esos workspaces responde 500; los de link externo no se enteran.

1. Confirmar: `select public.mercado_pago_checkout_ready('<workspace>')` con la clave de servicio, y `supabase migration list` (falta `20261006090000`).
2. Si falta la migración: aplicarla. Es la corrección, y solo crea o reemplaza funciones.
3. Si no se puede aplicar en el momento: quitar `MERCADO_PAGO_WEBHOOK_SECRET` del proyecto. Sin ella `bellis-public` no llama a la función y deja de ofrecer Mercado Pago; el perfil vuelve a cargar. Los profesionales afectados pueden pasar a link externo desde Cobros y pagos. Volver a cargar el secreto cuando esté corregido.
4. Como último recurso, volver a la versión anterior de `bellis-public`, que no usa esa función.

### Volver a la versión anterior de una función

Antes de desplegar, anotar la salida de `npx supabase functions list` (versión y fecha de cada una) y el commit desplegado. Para volver, sin tocar el árbol de trabajo:

```
git worktree add ../bellis-rollback <commit-anterior>
cd ../bellis-rollback && npx supabase functions deploy <nombre> --project-ref <ref>
cd - && git worktree remove ../bellis-rollback
```

Supabase no tiene "promover la versión anterior": volver es desplegar de nuevo el código viejo, y queda como una versión más. `bellis-mp-oauth` y `bellis-mp-webhook` no existían antes en producción: no hay versión anterior. No hace falta borrarlas; sin sus secretos responden 503/401 y no hacen nada. Para dejar de recibir avisos, quitar la URL de Webhooks en la aplicación de Mercado Pago.

### Qué se puede revertir de cada migración

| Migración | Qué hace | Volver atrás |
| --- | --- | --- |
| `20261004090000_mercado_pago_oauth` | Columnas y restricciones en `private.mercado_pago_accounts`, tabla de states, funciones de conexión, un trigger sobre `workspaces`. Actualiza filas existentes (`status='disconnected'` donde `not active`). | **No se revierte.** Agrega estructura; quitarla borraría conexiones y tokens. Si algo falla, se corrige hacia adelante con otra migración. |
| `20261005090000_booking_payment_return` | Columnas `booking_intents.resume_token_hash` y `payments.checkout_url`; funciones `attach_mercado_pago_checkout` y `cancel_unpaid_intent`. | **No se revierte.** Las columnas nuevas son opcionales y el código anterior las ignora: dejarlas no rompe nada. |
| `20261006090000_payment_hardening` | Solo funciones: crea `mercado_pago_checkout_ready` y `expire_stale_booking_intents`, reemplaza `record_mercado_pago_payment`. Sin tablas, columnas ni datos. | **Reversible sin pérdida**, con una migración nueva que restaure la definición anterior de `record_mercado_pago_payment` (la de `20260929000000_mercado_pago_ar.sql`). Las dos funciones nuevas se pueden dejar. |
| `20261009090000_expire_booking_intents_cron` (sin aplicar) | Registra una tarea. | `select cron.unschedule('bellis-expire-booking-intents');` Las solicitudes que ya cerró no se reabren, y no hace falta. |

Ninguna borra ni reescribe pagos, solicitudes o turnos. El respaldo previo al deploy es para el caso que este cuadro no prevé, no parte del plan.

## Runbook de producción

Para ejecutar una sola vez, con dos personas si se puede, en un horario de poco uso. **Se ejecutó el 2026-10-09** (ver "Release de producción (2026-10-09)"); queda como referencia para un próximo release. Cada paso tiene su comprobación; si una falla, parar y aplicar "Rollback".

Proyecto: `pinfdbvfzoratsntjgah`. Sitio: `https://bellis-six.vercel.app`. Migraciones pendientes en producción: `20261004090000`, `20261005090000`, `20261006090000` (confirmarlo en el paso 3).

**0. Antes de empezar**

- [ ] La aplicación **productiva** de Mercado Pago existe, con Redirect URL `https://bellis-six.vercel.app/mercado-pago/callback`.
- [ ] Checklist de variables de más abajo, completo.
- [ ] `staging` mergeada a `main` por pull request, con los tests de "CI" en verde.

**1. Respaldo**

- [ ] Dashboard → Database → Backups: hay un respaldo de hoy (o tomar uno, según el plan).
- [ ] Copia lógica local, fuera del repositorio:
  ```
  npx supabase link --project-ref pinfdbvfzoratsntjgah
  npx supabase db dump -f ../bellis-prod-schema-$(date +%F).sql
  npx supabase db dump --data-only -f ../bellis-prod-data-$(date +%F).sql
  ```
  El segundo archivo tiene datos de pacientes: guardarlo cifrado y borrarlo cuando el deploy esté estable.

**2. `main` limpio**

- [ ] `git checkout main && git pull && git status` → sin cambios ni archivos sin seguimiento que importen.
- [ ] `git log -1` es el commit que se quiere desplegar. Anotarlo.
- [ ] `node scripts/assert-staging-env.mjs --cli` → muestra `pinfdbvfzoratsntjgah (production)` **y la rama es `main`**.

**3. Estado de las migraciones**

- [ ] `npx supabase migration list` → Local y Remote coinciden hasta la última aplicada y solo faltan en Remote las tres de arriba. Si falta otra, o Remote tiene una que Local no, parar.
- [ ] `npx supabase functions list` → anotar versión y fecha de `bellis-public`.

**4. Aplicar**

- [ ] `npx supabase db push --dry-run` → lista exactamente las tres.
- [ ] `npx supabase db push`

**5. Verificar**

- [ ] `npx supabase migration list` → Local == Remote hasta `20261006090000`.
- [ ] La consulta de 16 funciones de "Chequeos de salud" devuelve `ok = true`.
- [ ] El sitio sigue funcionando con la versión **anterior** de `bellis-public`: abrir un perfil público y ver horarios de prueba.

**6. Secretos y funciones**

- [ ] Cargar los secretos del checklist. `npx supabase secrets list` → están los nombres esperados y **no** está `MERCADO_PAGO_OAUTH_TEST_TOKEN`.
- [ ] `npx supabase functions deploy bellis-mp-oauth`
- [ ] `npx supabase functions deploy bellis-public`
- [ ] `npx supabase functions deploy bellis-mp-webhook`

**7. Versiones**

- [ ] `npx supabase functions list` → las tres, con fecha de hoy; `bellis-public` con una versión más que la anotada.
- [ ] Vercel: el deploy de producción corresponde al commit anotado.

**8. Chequeo de salud**

- [ ] `BELLIS_SUPABASE_URL=https://pinfdbvfzoratsntjgah.supabase.co BELLIS_SITE_URL=https://bellis-six.vercel.app node scripts/payments-health.mjs` → 14/14.
- [ ] En la aplicación de Mercado Pago: Webhooks → URL `https://pinfdbvfzoratsntjgah.supabase.co/functions/v1/bellis-mp-webhook`, tema Pagos. "Simular" responde 200 o 401 según el caso, nunca 503.

**9. Camino feliz controlado**

Con un workspace propio, no el de un profesional real:

- [ ] Conectar una cuenta real de Mercado Pago desde Cobros y pagos → "Conectado", sin "Cuenta de prueba".
- [ ] Elegir Mercado Pago, reservar desde el perfil público un servicio de monto mínimo y pagarlo.
- [ ] El pago queda `approved`, la solicitud `awaiting_schedule`, se puede elegir horario y se crea **un** turno.
- [ ] En los logs de `bellis-mp-webhook`: `payment_recorded` con `http_status: 200`.
- [ ] Reembolsar ese pago desde Mercado Pago → pago y solicitud `refunded`, turno cancelado.
- [ ] Un flujo completo con link externo en otro workspace sigue funcionando.

**10. Después**

- [ ] Mercado Pago no se ofrece a ningún profesional hasta completar el paso 9.
- [ ] Mirar los logs durante el primer día: `payment_refused`, `config_missing`, `request_failed`, `ipn:payment`.
- [ ] Volver a enlazar el CLI a Staging: `npx supabase link --project-ref hbvmcvemrkfovzhlpgys`.
- [ ] Si algo falló: "Rollback", en este orden: frontend, función, y la migración solo hacia adelante.

### Checklist de variables de producción

Sin valores. Los nombres de Vercel son los que lee `app/api/supabase-config`.

**Vercel → entorno Production**

| Variable | Debe ser | Distinta de Staging |
| --- | --- | --- |
| `SUPABASE_URL` | `https://pinfdbvfzoratsntjgah.supabase.co` | Sí |
| `SUPABASE_PUBLISHABLE_KEY` | La clave publicable de **ese** proyecto | Sí |
| Dominio de producción | `bellis-six.vercel.app`. El sitio no tiene una variable de origen: el origen se configura del lado de Supabase (`BELLIS_SITE_ORIGIN`). | Sí |

Ninguna variable de Mercado Pago va en Vercel, y ninguna lleva `NEXT_PUBLIC_`. El entorno **Preview** de la rama `staging` tiene las dos de Staging.

**Supabase producción → Edge Functions → Secrets**

| Variable | Debe ser | Distinta de Staging |
| --- | --- | --- |
| `BELLIS_SITE_ORIGIN` | `https://bellis-six.vercel.app`, sin barra final | Sí |
| `BELLIS_ADDITIONAL_ORIGINS` | Vacía o sin definir | Sí |
| `MERCADO_PAGO_CLIENT_ID` | De la aplicación **productiva** | Sí |
| `MERCADO_PAGO_CLIENT_SECRET` | De la aplicación productiva | Sí |
| `MERCADO_PAGO_REDIRECT_URI` | Sin definir (se arma con el origen), o exactamente `https://bellis-six.vercel.app/mercado-pago/callback` | Sí |
| `MERCADO_PAGO_WEBHOOK_SECRET` | La firma de Webhooks de la aplicación productiva | Sí |
| `MERCADO_PAGO_OAUTH_TEST_TOKEN` | **No debe existir.** El código solo mira si vale `true`, así que `false` tiene el mismo efecto, pero la regla es no definirla. | Sí (`true` en Staging) |

Ningún valor se copia de un proyecto al otro: todos difieren.

**Lo que tiene que apuntar a `bellis-six.vercel.app`**

- `BELLIS_SITE_ORIGIN`, y `MERCADO_PAGO_REDIRECT_URI` si se define.
- La Redirect URL de la aplicación productiva de Mercado Pago: `https://bellis-six.vercel.app/mercado-pago/callback`.

**Lo que tiene que apuntar a `pinfdbvfzoratsntjgah.supabase.co`**

- `SUPABASE_URL` de Vercel Production.
- La URL de Webhooks de la aplicación productiva: `https://pinfdbvfzoratsntjgah.supabase.co/functions/v1/bellis-mp-webhook`.

## Release de producción (2026-10-09)

| | |
| --- | --- |
| Commit de producción | `e6f0ccc` (`main`, "chore: rebuild production with prod env"), sobre `439fc3a` de `staging`. |
| Proyecto y sitio | `pinfdbvfzoratsntjgah` · `https://bellis-six.vercel.app` |
| Migraciones aplicadas | Las 30 de `supabase/migrations/` hasta `20261006090000_payment_hardening` (`supabase migration list`, local = remoto). Las de este release: `20261004090000`, `20261005090000`, `20261006090000`. |
| Funciones en producción | `bellis-public` v12, `bellis-mp-webhook` v9, `bellis-mp-oauth` v2; las tres `ACTIVE`, `verify_jwt=false`, desplegadas 2026-10-09 03:08 UTC. |
| Funciones en Staging | `bellis-public` v10, `bellis-mp-webhook` v11, `bellis-mp-oauth` v9. Mismo código que producción (igual `ezbr_sha256` en las tres). |
| Chequeos de salud | `scripts/payments-health.mjs` contra producción: **14/14**, antes y después de la limpieza de secretos del 2026-10-09. |
| Smoke de producción | **PASS**: recorrido real completo con un pago de Mercado Pago. |
| Tarea de vencimiento | **Sin programar** en los dos proyectos. Migración `20261009090000_expire_booking_intents_cron` lista y sin aplicar (ver "Vencimiento"). La única tarea activa es `bellis-crm-automations-hourly`. |

### Limpieza posterior al release

| Ítem | Estado |
| --- | --- |
| `BELLIS_ADDITIONAL_ORIGINS` en producción | **Eliminada** el 2026-10-09. Contenía solo `https://bellis-six.vercel.app`, el mismo valor que `BELLIS_SITE_ORIGIN`. Después: salud 14/14, preflight CORS de `bellis-public` y `bellis-mp-oauth` desde el sitio con 204, origen ajeno 403. |
| Secreto mal formado en Staging | **Eliminado** el 2026-10-09: se llamaba `BELLIS_SITE_ORIGIN` seguido de un salto de línea y un guion. El `BELLIS_SITE_ORIGIN` correcto y los secretos de Mercado Pago no cambiaron. |
| Tarea de vencimiento | Pendiente: aplicar la migración en Staging y después en producción. |
| ESLint | Quedan 1 error y 1 advertencia, anteriores al release. `app/recuperar/page.tsx:21` (`react-hooks/set-state-in-effect`): corregirlo cambia cómo arranca la pantalla de recuperación de contraseña, no es un arreglo chico. `app/dashboard/page.tsx:106` (`react-hooks/exhaustive-deps`, falta `dayOf`): sin efecto, porque `dayOf` solo depende de `data`, que ya está en la lista. |
| CI | Sigue sin existir (ver "CI"). |

### Rollback de este release

Vale la sección "Rollback". Lo particular de este release:

- **Frontend:** promover en Vercel el deploy anterior a `e6f0ccc`.
- **Funciones:** `bellis-public` y `bellis-mp-webhook` vuelven desplegando el código de `2131368` (el `main` anterior). `bellis-mp-oauth` no existía antes: sin sus secretos no hace nada.
- **Migraciones:** `20261004090000` y `20261005090000` no se revierten; `20261006090000` se revierte hacia adelante (ver "Qué se puede revertir de cada migración").
- **`BELLIS_ADDITIONAL_ORIGINS`:** `npx supabase secrets set BELLIS_ADDITIONAL_ORIGINS=https://bellis-six.vercel.app --project-ref pinfdbvfzoratsntjgah`. No hace falta para que el sitio funcione.
- **Tarea de vencimiento, una vez aplicada:** `select cron.unschedule('bellis-expire-booking-intents');`

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
6. `npm run lint` — hoy falla por un error anterior (`app/recuperar/page.tsx`, ver "Release de producción (2026-10-09)"); activarlo después de corregirlo, o limitarlo a los archivos cambiados.
7. Opcional: un job con la imagen `supabase/postgres` que aplique las migraciones y corra los `*_smoke.sql` de pagos.

No necesita ningún secreto.

## Antes de producción

- Completar G6, incluidos los riesgos pendientes del webhook.
- Recorrer el checklist de "Separación de entornos" y el "Orden de deploy".
- Registrar la URL de callback de Bellis, la URL de webhook y la firma de producción en la aplicación de Mercado Pago.
- Probar el flujo completo con cuentas de prueba y luego con una operación real controlada.
- No marcar Mercado Pago como activo para un profesional hasta que conecte su propia cuenta.
