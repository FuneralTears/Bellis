# Bellis — entorno de desarrollo

## Requisitos

- Node.js 22 o superior y `npm ci`.
- Proyecto Supabase con las migraciones de `supabase/migrations/` aplicadas en orden.
- `.env.local` (no subir a Git):

```env
SUPABASE_URL=https://<proyecto>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<clave publicable>
```

La Edge Function `bellis-public` debe desplegarse con `verify_jwt=false` porque atiende a pacientes sin cuenta. Su código valida la procedencia, limita solicitudes y usa la clave de servicio disponible solo dentro de Supabase Functions. Para otro dominio, establecer `BELLIS_SITE_ORIGIN` como secreto de la función. Nunca colocar una clave de servicio en `.env.local` ni en el navegador.

## Probar

1. Configurar las URL exactas de Supabase Auth indicadas abajo.
2. Ejecutar `npm run dev` y abrir `/registro`.
3. Crear una cuenta profesional, confirmar el email si Auth lo exige e ingresar en `/ingresar`. La cuenta nueva debe abrir `/onboarding`; completar sesión y horarios. Volver a ingresar debe abrir `/dashboard` directamente.
4. En `/dashboard`, editar el servicio, activar links de cobro en **Cobros**, asignar un link HTTPS general o por servicio, guardar disponibilidad y bloquear un día si corresponde.
5. En `/dashboard/questionnaires`, guardar el formulario del servicio.
6. Copiar el link `/p/[slug]` del panel y abrirlo en otro navegador. Completar la preconsulta. La solicitud y el pago pendiente deben aparecer en Supabase y en **Cobros**.
7. Pagar en el link del profesional. Tras verificar la operación en su proveedor, registrar la referencia en **Cobros**. El paciente consulta el estado y recién entonces ve horarios.
8. Confirmar un horario. Ver el turno en **Agenda**, con sus respuestas y estado de pago. Comprobar en `notification_outbox` que se crearon cuatro jobs.

Para pruebas sin datos personales, ejecutar `supabase/tests/auth_onboarding_smoke.sql`, `supabase/tests/dynamic_conditions_smoke.sql` y `supabase/tests/live_booking_smoke.sql` en el proyecto de desarrollo: usan datos sintéticos y hacen `ROLLBACK`.

## Supabase Auth: URL Configuration

En **Authentication → URL Configuration** del proyecto Bellis:

- **Site URL:** `https://bellis-agenda.pint-solutio-0057.chatgpt.site`
- **Redirect URLs del sitio publicado:**
  - `https://bellis-agenda.pint-solutio-0057.chatgpt.site/ingresar?confirmed=1`
  - `https://bellis-agenda.pint-solutio-0057.chatgpt.site/recuperar?mode=update`
- **Redirect URLs de desarrollo local** (cuando se use `npm run dev` en el puerto 5173):
  - `http://localhost:5173/ingresar?confirmed=1`
  - `http://localhost:5173/recuperar?mode=update`

En **Authentication → Providers → Email**, mantener habilitado email y contraseña y decidir si se exige confirmación de email. Si está habilitada, la persona debe confirmar antes de entrar al onboarding. En **Authentication → Emails → SMTP Settings**, configurar un proveedor SMTP y dominio verificado para entrega confiable a profesionales reales; el envío predeterminado de Supabase puede tener restricciones. Los enlaces de confirmación y recuperación usan los Redirect URLs anteriores. No incluir tokens ni contraseñas en estas URL configuradas.

### Prueba de Auth

1. Registrar un email nuevo en `/registro` y completar datos básicos. Verificar que se creó una sola organización y un solo perfil.
2. Confirmar el email desde el mensaje recibido, si la confirmación está activa. Ingresar con la contraseña; debe abrir `/onboarding`.
3. Completar servicio y horarios. Refrescar `/dashboard` y comprobar que el servicio persiste.
4. Cerrar sesión; abrir `/dashboard` y `/dashboard/questionnaires` por URL. Deben volver a `/ingresar`.
5. Ingresar otra vez; debe abrir `/dashboard` sin repetir onboarding. Refrescar y reabrir el navegador para comprobar persistencia.
6. Probar contraseña incorrecta y email inexistente. Solicitar un enlace en `/recuperar`, abrirlo, cambiar la contraseña y volver a ingresar.

## Pendientes para uso con profesionales reales

- Conectar cuentas individuales de Mercado Pago Argentina y sus webhooks para verificación automática. El link externo actual se reconcilia manualmente.
- Contratar y verificar un proveedor/dominio de email; conectar el despachador de `notification_outbox`.
- Publicar política de privacidad, términos, retención y proceso de eliminación/exportación de datos de pacientes.
- Configurar redirecciones de Supabase Auth y revisar protección de contraseñas filtradas.
- Cambiar la audiencia del Site privado cuando se haya completado la preparación para pacientes externos.

Consultar [ARCHITECTURE.md](ARCHITECTURE.md) para el estado técnico.
