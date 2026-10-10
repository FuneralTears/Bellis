# Base de datos Bellis

Hay dos proyectos: **producción** `pinfdbvfzoratsntjgah` (`sa-east-1`, el que este documento llamaba "desarrollo") y **Staging** `hbvmcvemrkfovzhlpgys`. Las migraciones de Mercado Pago están aplicadas en los dos y el flujo de cobro está desplegado y validado en producción. Las pruebas `.sql` se corren, por regla general, en Staging o en una base local y se evitan en producción; la excepción fue el release de H1 + H1.5, donde se ejecutaron pruebas explícitamente seguras, con `BEGIN`/`ROLLBACK` y verificación de que no quedaron datos persistentes (ver más abajo). Ver "Separación de entornos" en `MERCADO_PAGO.md`.

Entidades reales: `workspaces`, `workspace_members`, `professionals`, `services`, `availability_rules`, `availability_blocks`, `patients`, `questionnaires`, `questionnaire_sections`, `questionnaire_questions`, `questionnaire_conditions`, `questionnaire_answers`, `booking_intents`, `payments`, `appointments`, `notification_outbox`, `audit_events` y `public_request_limits`. Las tablas antiguas `forms`/`form_questions` no se usan en el flujo actual.

El registro crea workspace y profesional por trigger de Auth. Los formularios se versionan. La Edge Function `bellis-public` lee el perfil y coordina `create_checkout_intent`, `available_slots_for_intent` y `schedule_paid_intent`. Solo la función, con `service_role`, puede escribir pacientes, respuestas, intenciones y turnos. La aprobación manual de un link externo usa `confirm_external_payment` con identidad y rol verificados en SQL. El enlace de retorno no confirma el pago. FKs compuestas y RLS mantienen el aislamiento por workspace.

Las pruebas SQL en `tests/` hacen `ROLLBACK`. `live_booking_smoke.sql` cubre el flujo pago → slots → turno, rechazo de doble reserva, jobs y aislamiento; `dynamic_conditions_smoke.sql` cubre preguntas condicionales. El asesor de seguridad muestra avisos informativos para tablas sin políticas de cliente (son tablas solo de servidor) y una advertencia de Auth sobre protección de contraseñas filtradas: [guía de Supabase](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Pendiente antes de datos clínicos reales: dominio de email y despachador, verificación automática de Mercado Pago por cuenta profesional, redirecciones de Auth, política de privacidad/retención y operación de exportación/eliminación de datos.

## H1 + H1.5 en producción (2026-10-09)

**Estado: DEPLOYED** en `pinfdbvfzoratsntjgah` y `https://bellis-six.vercel.app`. `main` en `0624796` ("merge: integrate H1 patient notes and H1.5 smart availability"). Migraciones del release: `20261010090000_patient_note_types` y `20261011090000_smart_availability`; producción y Staging quedaron en 33 de 33 (local = remoto).

### H1 — Notas internas de pacientes

- `public.patient_notes` sigue siendo la fuente de verdad. Se agregó `note_type` (`text not null`, default `general`).
- Tipos: `general` (General), `follow_up` (Seguimiento), `administrative` (Administrativa) y `payment` (Pago). No hay tipo clínico: guardar datos clínicos espera la política de privacidad y retención.
- Permisos: el autor edita y elimina sus notas; owner y admin, todas las del workspace. La lectura y el alta no cambiaron. `anon` no tiene privilegios sobre la tabla.
- Auditoría: el trigger `patient_note_audit` registra `patient_note_created`, `patient_note_updated` y `patient_note_deleted` en `audit_events`. El texto de la nota no se copia.
- Las notas se ven solo en la ficha del paciente; el booking público y las funciones públicas no las leen.

### H1.5 — Disponibilidad inteligente

- `professionals.slot_interval_minutes`: cada cuánto se ofrece un horario de inicio. Valores: 15, 30 o 60. No es la duración del turno ni el descanso entre turnos.
- Default para profesionales nuevos: 30. Los que existían al migrar conservaron 15, en Staging y en producción.
- `professionals.max_appointments_per_day`: opcional, entre 1 y 50; `null` es sin límite. Cuentan los turnos agendados y completados del día local del workspace; al llegar al máximo ese día deja de ofrecer horarios.
- `available_slots_for_intent` usa la frecuencia y el máximo. `schedule_paid_intent` toma un candado por profesional y día local antes de volver a validar el horario.
- Se editan en Dashboard → Disponibilidad → "Reserva de turnos" con un update directo: lo cubren `professional_self_update` (el propio profesional) y `professional_write` (owner y admin). No se agregaron al onboarding.
- Booking público: el selector muestra primero 8 horarios y el botón "Ver más horarios" cuando hay más. Es solo presentación: el servidor sigue devolviendo todos los horarios.

### Validación

- Antes de migrar producción: backup lógico de `public` tomado el mismo día, fuera del repositorio, y verificación de que las funciones, políticas y permisos que reemplazan las migraciones coincidían con el repositorio.
- Pruebas SQL con `ROLLBACK`: `patient_notes_smoke`, `smart_availability_smoke`, `live_booking_smoke`, `mercado_pago_smoke`, `payment_hardening_smoke` y `booking_return_smoke`. Pasaron en Staging y, por decisión explícita para este release, también en producción; los conteos de todas las tablas quedaron iguales antes y después.
- `scripts/payments-health.mjs` contra producción después del release: 14/14.
- Pendiente sin cambios: producción no tiene backups automáticos ni PITR.
