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

1. Configurar en Supabase Auth las URL de redirección de `/ingresar` y `/recuperar?mode=update` para el entorno donde se probará.
2. Ejecutar `npm run dev` y abrir `/registro`.
3. Crear una cuenta profesional, confirmar el email si Auth lo exige e ingresar en `/ingresar`.
4. En `/dashboard`, editar el servicio, activar links de cobro en **Cobros**, asignar un link HTTPS general o por servicio, guardar disponibilidad y bloquear un día si corresponde.
5. En `/dashboard/questionnaires`, guardar el formulario del servicio.
6. Copiar el link `/p/[slug]` del panel y abrirlo en otro navegador. Completar la preconsulta. La solicitud y el pago pendiente deben aparecer en Supabase y en **Cobros**.
7. Pagar en el link del profesional. Tras verificar la operación en su proveedor, registrar la referencia en **Cobros**. El paciente consulta el estado y recién entonces ve horarios.
8. Confirmar un horario. Ver el turno en **Agenda**, con sus respuestas y estado de pago. Comprobar en `notification_outbox` que se crearon cuatro jobs.

Para pruebas sin datos personales, ejecutar `supabase/tests/dynamic_conditions_smoke.sql` y `supabase/tests/live_booking_smoke.sql` en el proyecto de desarrollo: ambos usan datos sintéticos y hacen `ROLLBACK`.

## Pendientes para uso con profesionales reales

- Conectar cuentas individuales de Mercado Pago Argentina y sus webhooks para verificación automática. El link externo actual se reconcilia manualmente.
- Contratar y verificar un proveedor/dominio de email; conectar el despachador de `notification_outbox`.
- Publicar política de privacidad, términos, retención y proceso de eliminación/exportación de datos de pacientes.
- Configurar redirecciones de Supabase Auth y revisar protección de contraseñas filtradas.
- Cambiar la audiencia del Site privado cuando se haya completado la preparación para pacientes externos.

Consultar [ARCHITECTURE.md](ARCHITECTURE.md) para el estado técnico.
