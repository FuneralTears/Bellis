-- H2.7: la frontera entre Bellis Free y Bellis Pro.
--   Free = agenda, pacientes y operación manual: turnos, cobros manuales, notas, página pública y reserva con link de pago.
--   Pro  = todo eso más seguimientos, CRM, automatizaciones y Mercado Pago integrado.
-- Los seguimientos dejan de ser de Free. Nada se borra: un workspace que baja a Free conserva sus seguimientos
-- tal como estaban; lo que no puede es crear ni cambiar ninguno hasta volver a tener Pro.

-- El único lugar donde se decide qué incluye cada plan. Reemplaza el mapa de 20261016090000.
--   followups        crear, editar, completar y cancelar seguimientos
--   crm              señales y filtros que agrupan o priorizan pacientes ("Necesitan atención", oportunidades)
--   smart_followups  sugerencias derivadas del historial
-- Las últimas siete están reservadas para funciones que todavía no existen.
create or replace function private.plan_capabilities(p_tier text) returns text[]
language sql immutable set search_path = '' as $$
  select array['manual_patients','manual_appointments','manual_payments','patient_notes','public_booking','external_payment_link']
    || case when p_tier in ('pro','pro_trial') then array['followups','crm','smart_followups','automations','mercado_pago',
      'patient_origin','advanced_tags','insurance_management','weekly_metrics','advanced_insights','reports','marketing_tools']
      else array[]::text[] end;
$$;

-- Los seguimientos se escriben directo en la tabla, con RLS. El control va en la tabla misma para que valga por
-- cualquier camino: la ficha del paciente, la pantalla de seguimientos o una llamada directa a la API.
-- Leer no se controla: el historial sigue a la vista. Las automatizaciones solo crean seguimientos con Pro.
create function private.require_followups_capability() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.workspace_has_capability(new.workspace_id,'followups') then raise exception 'pro_access_required'; end if;
  return new;
end $$;
revoke all on function private.require_followups_capability() from public,anon,authenticated;
create trigger patient_follow_up_plan_guard before insert or update on public.patient_follow_ups
  for each row execute function private.require_followups_capability();
