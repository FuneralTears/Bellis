# Automatizaciones internas de Bellis

La migración `20261002090000_crm_automations.sql` crea tres reglas por workspace, todas desactivadas. Al activar una regla se toma ese momento como inicio: no se programan acciones por eventos anteriores. Los cambios de plazo afectan eventos futuros; las ejecuciones ya programadas conservan su fecha. Desactivar una regla hace que sus ejecuciones pendientes se omitan al procesarse.

Los triggers de turnos completados y pagos pendientes agregan ejecuciones con una clave única `(automation_rule_id, reference_id)`. Un barrido SQL por hora recupera eventos nuevos que no hayan sido encolados y procesa hasta 100 tareas vencidas con `FOR UPDATE SKIP LOCKED`. `pg_cron` ejecuta `private.run_automation_cycle()` a los cinco minutos de cada hora. La función también puede invocarse manualmente desde SQL por personal con privilegios de base de datos para diagnóstico.

Antes de crear un seguimiento, el motor vuelve a consultar turno, pago, paciente, próximo turno, última consulta y seguimientos pendientes equivalentes. Si cambió la situación, registra `skipped` con el motivo. Si falla, reintenta una vez luego de 15 minutos; el segundo fallo queda en `failed` con mensaje y auditoría. Cada ejecución guarda `triggered_at`, `scheduled_for`, `executed_at`, `result` y, si corresponde, `follow_up_id`.

Las fechas de ejecución son `timestamptz`; la fecha del seguimiento se calcula con el `timezone` del workspace. La actividad `automation_created_follow_up` guarda únicamente el título, motivo y los ID de la ejecución y seguimiento. No se envían mensajes externos. Si un pago se aprueba después de crear el seguimiento, este queda para revisión manual; si se aprueba antes, la ejecución se omite.

Para comprobar el despliegue: revisar `cron.job` y `cron.job_run_details`, ejecutar `supabase/tests/crm_phase4_smoke.sql` como postgres en desarrollo y comprobar la ruta `/automatizaciones`. El script de prueba usa datos sintéticos y termina con `ROLLBACK`.
