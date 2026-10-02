# Bellis MVP — estado técnico

Bellis usa React/TypeScript con Next.js App Router y Supabase Auth + PostgreSQL. La compilación de Vercel usa Next.js; vinext (Vite) queda disponible para el runtime anterior de Sites. El mercado inicial es Argentina (`AR`, `ARS`, `es-AR`, `America/Argentina/Buenos_Aires`). El dashboard real está en `/dashboard`; el constructor versionado de preconsultas sigue en `/dashboard/questionnaires`; la página pública de cada profesional está en `/p/[slug]`. `/demo`, `/profesional/ana-lopez` y `/admin` siguen siendo ejemplos visuales.

## Flujo implementado

1. El registro de Supabase Auth crea workspace, owner, profesional, servicio y reglas semanales. El login conserva la sesión, hay cierre de sesión y recuperación de contraseña.
2. El profesional puede editar perfil, servicios, precios, links de cobro por servicio o generales, reglas semanales y días bloqueados. El constructor de formularios guarda versiones y condiciones por servicio.
3. La Edge Function `bellis-public` publica únicamente datos del perfil, servicios y formulario activos. Recibe el formulario, valida las respuestas en un RPC, crea paciente, intención y pago pendiente en una transacción, y devuelve un token opaco al navegador. El token se guarda en `sessionStorage`, no en la URL.
4. El paciente abre el link externo configurado. El profesional verifica el cobro en su proveedor y registra una referencia mediante `confirm_external_payment`. Ese RPC valida su acceso al workspace, el monto y el estado. Un retorno del link nunca aprueba el pago.
5. La Edge Function revela horarios solo si el pago está aprobado. PostgreSQL calcula los slots en la zona horaria del workspace, aplicando duración, reglas semanales, bloqueos, anticipación, pausas y turnos existentes. Al confirmar revalida el slot y una exclusión GiST impide doble reserva concurrente.
6. El turno aparece en el dashboard junto a paciente, servicio, respuestas y pago. Se crean cuatro jobs en `notification_outbox` para confirmación y recordatorios.

## Seguridad y límites

RLS delimita lectura y escritura por workspace y rol. Las claves de servicio solo viven en Edge Functions; el navegador recibe la clave publicable. FKs compuestas impiden enlazar entidades de distintos workspaces. El endpoint público limita solicitudes y no recibe datos privados en URLs. Los datos sintéticos de las pruebas HTTP se eliminaron.

El cobro por link externo exige verificación manual del profesional y **no equivale a integración automática con el proveedor**. Mercado Pago por cuenta profesional requiere OAuth y aún no está conectado. Sin proveedor de email configurado, los jobs quedan en cola y no se envían. Antes de usar Vercel con pacientes externos, la lista de redirecciones de Supabase Auth y el origen admitido por `bellis-public` deben incluir su URL real. Falta política de privacidad, retención y eliminación operativa antes de usar datos clínicos reales.

## Pruebas

`supabase/tests/live_booking_smoke.sql` ejecuta un flujo transaccional sintético con pago pendiente/aprobado, disponibilidad, turno, rechazo de doble reserva, outbox y aislamiento RLS. `supabase/tests/dynamic_conditions_smoke.sql` valida condiciones del formulario. Se verificó además por HTTP real el endpoint público con datos sintéticos: perfil, intención, bloqueo previo al pago, aprobación, slots y reserva; luego se eliminaron esos registros.
