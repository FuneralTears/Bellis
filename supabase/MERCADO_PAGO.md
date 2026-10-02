# Mercado Pago Argentina — fase 3

Esta integración cobra **turnos de pacientes a la cuenta del profesional** mediante Checkout Pro. No cobra la suscripción de Bellis. La aprobación manual de links externos sigue disponible.

## Estado y límites

- El checkout, webhook, verificación de la operación y conciliación al consultar estado están implementados en Edge Functions.
- La cuenta de cada profesional se identifica por `workspace_id`. El token del vendedor está cifrado en Supabase Vault y no aparece en la web ni en `payments`.
- Todavía no existe el flujo OAuth para que cada profesional conecte y renueve su propia cuenta. Hasta entonces, la carga manual en Vault se limita al proyecto de desarrollo y a credenciales de prueba. No activar Mercado Pago en workspaces de producción mediante un token de Bellis.
- Sin una cuenta activa y `MERCADO_PAGO_WEBHOOK_SECRET`, el perfil no ofrece checkout de Mercado Pago.

## Variables

| Variable | Acceso | Uso | Desarrollo | Producción |
| --- | --- | --- | --- | --- |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Privada, solo servidor | Verificar HMAC de Webhooks; habilitar checkout | `supabase/functions/.env` (ignorado por Git) | Supabase Dashboard → Edge Functions → Secrets |
| `BELLIS_SITE_ORIGIN` | Configuración de servidor, no secreta | CORS y URL de retorno del checkout | `supabase/functions/.env` | Supabase Dashboard → Edge Functions → Secrets |
| `BELLIS_ADDITIONAL_ORIGINS` | Configuración de servidor, no secreta | Orígenes HTTPS exactos adicionales de previews autorizados | `supabase/functions/.env` | Supabase Dashboard → Edge Functions → Secrets |
| `SUPABASE_URL` | Inyectada por Supabase | API y URL del webhook | Supabase local | Inyectada por Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Privada, solo servidor; inyectada por Supabase | Escrituras controladas en Edge Functions | Supabase local | Inyectada por Supabase |

El Access Token de cada vendedor **no** es una variable de entorno compartida. Se guarda como secreto individual en Vault. No agregar variables `NEXT_PUBLIC_` para Mercado Pago.

## Preparación manual en desarrollo

1. Crear una aplicación de Mercado Pago Argentina para Bellis y habilitar Checkout Pro.
2. Crear vendedor y comprador de prueba en Mercado Pago. Obtener el Access Token de prueba y el ID numérico del vendedor, sin pegarlos en código ni en el chat.
3. Configurar Webhooks de tipo `payment` para la aplicación. Registrar la URL de prueba `https://pinfdbvfzoratsntjgah.supabase.co/functions/v1/bellis-mp-webhook` y guardar la firma secreta en `MERCADO_PAGO_WEBHOOK_SECRET`. Cada preferencia creada por Bellis indica una `notification_url` con su `intent`.
4. Para **un workspace de prueba** en el proyecto de desarrollo, guardar el Access Token con `vault.create_secret(...)` y asociar el UUID devuelto a `private.mercado_pago_accounts` junto al `workspace_id`, `seller_user_id` y `environment='test'`. Hacerlo en el editor SQL de Supabase sin dejar el token en archivos, capturas ni logs. Esta carga manual es temporal hasta implementar OAuth.
5. Cambiar `workspaces.payment_provider` de ese workspace a `mercado_pago_ar`. El servicio debe estar activo, con precio en ARS y formulario activo. Los demás workspaces conservan `external_link`.

## Prueba sandbox

1. Abrir el perfil público del workspace de prueba y elegir un servicio. Completar formulario y datos del paciente.
2. Confirmar que se crea una sola intención con `payments.status='pending'` y que aún no hay horarios reservables.
3. Abrir el checkout de prueba. Hacer una compra con comprador y tarjeta de prueba según la [guía oficial](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/integration-test/test-purchases).
4. En Mercado Pago, revisar la entrega del webhook `payment`. En Bellis, consultar el estado: debe pasar a `approved` y habilitar los horarios solo después de consultar la operación real en la API de Mercado Pago.
5. Repetir la notificación desde el panel de Mercado Pago: debe quedar un pago y una sola transición de auditoría.
6. Probar un pago rechazado: debe permanecer sin horarios. Repetir con un precio manipulado en el navegador: el checkout debe usar el precio persistido del servicio.
7. Ejecutar `node --test supabase/tests/mercado_pago_provider.test.mjs`. Ejecutar `supabase/tests/mercado_pago_smoke.sql` únicamente en desarrollo; usa datos sintéticos y `ROLLBACK`.

## Antes de producción

Implementar OAuth Authorization Code con `state`/PKCE y renovación de tokens para cada vendedor. Configurar la URL de producción y la firma Webhook de producción en la aplicación Mercado Pago. Probar el flujo completo con cuentas de prueba y luego con una operación real controlada. No marcar Mercado Pago como activo para un profesional hasta conectar su propia cuenta.
