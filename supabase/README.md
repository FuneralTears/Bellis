# Base de datos Bellis

Proyecto de desarrollo: `pinfdbvfzoratsntjgah` (`sa-east-1`). Las migraciones de `migrations/` ya están aplicadas a este proyecto; no repetirlas manualmente allí.

Entidades reales: `workspaces`, `workspace_members`, `professionals`, `services`, `availability_rules`, `availability_blocks`, `patients`, `questionnaires`, `questionnaire_sections`, `questionnaire_questions`, `questionnaire_conditions`, `questionnaire_answers`, `booking_intents`, `payments`, `appointments`, `notification_outbox`, `audit_events` y `public_request_limits`. Las tablas antiguas `forms`/`form_questions` no se usan en el flujo actual.

El registro crea workspace y profesional por trigger de Auth. Los formularios se versionan. La Edge Function `bellis-public` lee el perfil y coordina `create_checkout_intent`, `available_slots_for_intent` y `schedule_paid_intent`. Solo la función, con `service_role`, puede escribir pacientes, respuestas, intenciones y turnos. La aprobación manual de un link externo usa `confirm_external_payment` con identidad y rol verificados en SQL. El enlace de retorno no confirma el pago. FKs compuestas y RLS mantienen el aislamiento por workspace.

Las pruebas SQL en `tests/` hacen `ROLLBACK`. `live_booking_smoke.sql` cubre el flujo pago → slots → turno, rechazo de doble reserva, jobs y aislamiento; `dynamic_conditions_smoke.sql` cubre preguntas condicionales. El asesor de seguridad muestra avisos informativos para tablas sin políticas de cliente (son tablas solo de servidor) y una advertencia de Auth sobre protección de contraseñas filtradas: [guía de Supabase](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Pendiente antes de datos clínicos reales: dominio de email y despachador, verificación automática de Mercado Pago por cuenta profesional, redirecciones de Auth, política de privacidad/retención y operación de exportación/eliminación de datos.
