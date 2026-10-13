-- H2.8A: qué pasa en el producto, para el backoffice interno. Hechos, no contenido.
-- Cada fila dice que algo ocurrió, en qué workspace, sobre qué fila y cuándo. Nunca guarda nombres de pacientes,
-- notas, respuestas de formularios, títulos de seguimientos, montos, motivos ni ningún texto libre: metadata solo lleva
-- unos pocos valores cerrados (de dónde vino un turno, por qué medio entró un cobro, hasta cuándo vale un plan) que
-- escriben las funciones de este archivo. De una nota se anota que se escribió una, nunca qué dice.
-- Nadie escribe ni lee esta tabla desde el navegador: se llena con triggers y se lee con las funciones del backoffice.

create table public.product_events (
  id bigint generated always as identity primary key,
  event_name text not null check (event_name in (
    'user_registered','onboarding_completed','patient_created','appointment_created','public_booking_completed',
    'followup_created','automation_enabled','payment_recorded','appointment_completed','appointment_cancelled','patient_note_created',
    'trial_started','trial_expired','upgrade_requested','pro_activated','pro_expired','workspace_suspended')),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  entity_type text check (entity_type in ('workspace','patient','appointment','follow_up','automation_rule','upgrade_request','payment','patient_note')),
  entity_id uuid,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata)='object' and pg_column_size(metadata) <= 512),
  created_at timestamptz not null default now()
);
create index product_events_workspace_time on public.product_events(workspace_id,created_at desc);
create index product_events_name_time on public.product_events(event_name,created_at desc);
create index product_events_time on public.product_events(created_at desc);
-- Un vencimiento se anota una sola vez por plan y fecha, aunque el registro corra muchas veces.
create unique index product_events_one_expiry on public.product_events(workspace_id,event_name,(metadata->>'ended_at'))
  where event_name in ('trial_expired','pro_expired');
alter table public.product_events enable row level security;
revoke all on public.product_events from public,anon,authenticated,service_role;
grant select on public.product_events to service_role;

-- Los eventos que cuentan como uso del producto. Registrarse, iniciar sesión o cambiar de plan no es usarlo:
-- "activo" es quien cargó un paciente, agendó, recibió una reserva, atendió o canceló un turno, registró un cobro,
-- escribió una nota, creó un seguimiento o activó una automatización. El inicio de sesión ni siquiera es un evento.
create function private.product_activity_events() returns text[]
language sql immutable set search_path = '' as $$
  select array['onboarding_completed','patient_created','appointment_created','public_booking_completed','followup_created','automation_enabled',
    'payment_recorded','appointment_completed','appointment_cancelled','patient_note_created'];
$$;
revoke all on function private.product_activity_events() from public,anon,authenticated;

-- El único camino de escritura. Un fallo acá nunca debe impedir una reserva, un pago ni un registro:
-- se avisa en el log y la operación del usuario sigue.
create function private.record_product_event(
  p_event text,p_workspace uuid,p_user uuid,p_entity_type text,p_entity uuid,p_metadata jsonb default '{}',p_at timestamptz default now()
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
  values(p_event,p_workspace,p_user,p_entity_type,p_entity,coalesce(p_metadata,'{}'::jsonb),coalesce(p_at,now()));
exception when others then
  raise warning 'product_event_not_recorded: % (%)', p_event, sqlerrm;
end $$;
revoke all on function private.record_product_event(text,uuid,uuid,text,uuid,jsonb,timestamptz) from public,anon,authenticated;

-- ===== De dónde sale cada evento =====

-- Registro: el alta crea el workspace y a su dueño en el mismo paso.
create function private.product_event_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role='owner' then
    perform private.record_product_event('user_registered',new.workspace_id,new.user_id,'workspace',new.workspace_id);
  end if;
  return new;
end $$;
create trigger product_event_member after insert on public.workspace_members
  for each row execute function private.product_event_member();

-- Onboarding, prueba, Pro y suspensión: los cuatro son cambios en la fila del workspace.
create function private.product_event_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid());
begin
  if new.onboarding_completed_at is not null and (tg_op='INSERT' or old.onboarding_completed_at is null) then
    perform private.record_product_event('onboarding_completed',new.id,v_user,'workspace',new.id);
  end if;
  if new.trial_started_at is not null and (tg_op='INSERT' or old.trial_started_at is null) then
    perform private.record_product_event('trial_started',new.id,v_user,'workspace',new.id,
      jsonb_build_object('ends_at',new.trial_ends_at));
  end if;
  -- Un Pro nuevo, no una extensión del mismo período.
  if new.plan_code='pro' and (tg_op='INSERT' or old.plan_code<>'pro' or old.pro_started_at is distinct from new.pro_started_at) then
    perform private.record_product_event('pro_activated',new.id,v_user,'workspace',new.id,
      jsonb_build_object('ends_at',new.pro_ends_at));
  end if;
  if new.status='suspended' and (tg_op='INSERT' or old.status<>'suspended') then
    perform private.record_product_event('workspace_suspended',new.id,v_user,'workspace',new.id);
  end if;
  return new;
end $$;
create trigger product_event_workspace after insert or update on public.workspaces
  for each row execute function private.product_event_workspace();

-- Paciente nuevo. Solo de dónde vino: cargado a mano o llegado por la página pública.
create function private.product_event_patient() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.record_product_event('patient_created',new.workspace_id,new.created_by,'patient',new.id,
    jsonb_build_object('source',case when new.created_by is null then 'public' else 'manual' end));
  return new;
end $$;
create trigger product_event_patient after insert on public.patients
  for each row execute function private.product_event_patient();

-- Turno nuevo. Si vino de la página pública es además una reserva pública completada.
-- Después, el momento en que se atiende o se cancela. De una cancelación no se guarda el motivo ni quién la pidió.
create function private.product_event_appointment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_source text; v_user uuid;
begin
  if tg_op='INSERT' then
    select i.source,i.created_by into v_source,v_user from public.booking_intents i where i.id=new.booking_intent_id;
    v_source := coalesce(v_source,'public');
    perform private.record_product_event('appointment_created',new.workspace_id,v_user,'appointment',new.id,
      jsonb_build_object('source',v_source));
    if v_source='public' then
      perform private.record_product_event('public_booking_completed',new.workspace_id,null,'appointment',new.id);
    end if;
  end if;
  if new.status in ('completed','cancelled') and (tg_op='INSERT' or old.status is distinct from new.status) then
    perform private.record_product_event(case when new.status='completed' then 'appointment_completed' else 'appointment_cancelled' end,
      new.workspace_id,(select auth.uid()),'appointment',new.id);
  end if;
  return new;
end $$;
create trigger product_event_appointment after insert or update of status on public.appointments
  for each row execute function private.product_event_appointment();

-- Cobro registrado: un pago que queda aprobado, lo haya cargado el profesional o lo haya confirmado Mercado Pago.
-- Solo por qué medio entró. Ni el monto ni la referencia.
create function private.product_event_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status='approved' and (tg_op='INSERT' or old.status is distinct from new.status) then
    perform private.record_product_event('payment_recorded',new.workspace_id,new.recorded_by,'payment',new.id,
      jsonb_build_object('provider',case when new.provider in ('offline','mercado_pago_ar','external_link') then new.provider else 'other' end));
  end if;
  return new;
end $$;
create trigger product_event_payment after insert or update of status on public.payments
  for each row execute function private.product_event_payment();

-- Nota de paciente: que se escribió una, y nada más. El texto no se lee en ningún momento.
create function private.product_event_patient_note() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.record_product_event('patient_note_created',new.workspace_id,new.author_id,'patient_note',new.id);
  return new;
end $$;
create trigger product_event_patient_note after insert on public.patient_notes
  for each row execute function private.product_event_patient_note();

-- Seguimiento nuevo: a mano o creado por una automatización. Ni el título ni la descripción.
create function private.product_event_follow_up() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.record_product_event('followup_created',new.workspace_id,
    case when new.source='manual' then new.created_by end,'follow_up',new.id,jsonb_build_object('source',new.source));
  return new;
end $$;
create trigger product_event_follow_up after insert on public.patient_follow_ups
  for each row execute function private.product_event_follow_up();

-- Automatización encendida. Las reglas nacen apagadas: cuenta el momento en que alguien la activa.
create function private.product_event_automation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.enabled and (tg_op='INSERT' or not old.enabled) then
    perform private.record_product_event('automation_enabled',new.workspace_id,(select auth.uid()),'automation_rule',new.id,
      jsonb_build_object('rule',new.rule_key));
  end if;
  return new;
end $$;
create trigger product_event_automation after insert or update of enabled on public.automation_rules
  for each row execute function private.product_event_automation();

create function private.product_event_upgrade_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.record_product_event('upgrade_requested',new.workspace_id,new.requested_by,'upgrade_request',new.id,
    jsonb_build_object('plan',new.requested_plan));
  return new;
end $$;
create trigger product_event_upgrade_request after insert on public.plan_upgrade_requests
  for each row execute function private.product_event_upgrade_request();

revoke all on function private.product_event_member() from public,anon,authenticated;
revoke all on function private.product_event_workspace() from public,anon,authenticated;
revoke all on function private.product_event_patient() from public,anon,authenticated;
revoke all on function private.product_event_appointment() from public,anon,authenticated;
revoke all on function private.product_event_payment() from public,anon,authenticated;
revoke all on function private.product_event_patient_note() from public,anon,authenticated;
revoke all on function private.product_event_follow_up() from public,anon,authenticated;
revoke all on function private.product_event_automation() from public,anon,authenticated;
revoke all on function private.product_event_upgrade_request() from public,anon,authenticated;

-- Vencimientos. Una prueba o un Pro vencen por fecha, sin que se escriba nada (ver private.workspace_tier):
-- no hay fila que dispare un trigger. Esta función anota los que ya vencieron, con la fecha en que ocurrió,
-- y puede correr las veces que haga falta.
create function private.record_plan_expirations() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0; v_step integer;
begin
  insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
  select 'trial_expired',w.id,'workspace',w.id,jsonb_build_object('ended_at',w.trial_ends_at),w.trial_ends_at
  from public.workspaces w where w.trial_ends_at <= now()
  on conflict do nothing;
  get diagnostics v_step = row_count; v_count := v_count + v_step;
  insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
  select 'pro_expired',w.id,'workspace',w.id,jsonb_build_object('ended_at',w.pro_ends_at),w.pro_ends_at
  from public.workspaces w where w.pro_started_at is not null and w.pro_ends_at <= now()
  on conflict do nothing;
  get diagnostics v_step = row_count; v_count := v_count + v_step;
  return v_count;
end $$;
revoke all on function private.record_plan_expirations() from public,anon,authenticated;

-- Cada hora, dentro de la base, sin red ni secretos. cron.schedule reemplaza un job del mismo nombre.
-- Para desactivarlo: select cron.unschedule('bellis-plan-expirations');
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('bellis-plan-expirations','20 * * * *','select private.record_plan_expirations()');

-- ===== Lo que ya pasó antes de esta migración =====
-- Se reconstruye desde las tablas, con la fecha en que ocurrió, para que el backoffice no arranque vacío.
-- metadata.backfilled lo distingue de lo registrado en el momento. Solo se reconstruye lo que tiene una fecha
-- guardada y confiable; donde no la hay no se inventa un evento:
--   cobros                  los aprobados que tienen approved_at.
--   notas                   todas, por su created_at.
--   turnos atendidos        los que están 'completed' y tienen status_changed_at (la fecha del último cambio de estado).
--   turnos cancelados       los que están 'cancelled' y tienen status_changed_at.
-- Quedan afuera los turnos atendidos o cancelados sin status_changed_at (anteriores a que esa fecha existiera o
-- cargados ya en ese estado), y los turnos que pasaron por 'completed' y después cambiaron: su fecha se pisó.
insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
select 'user_registered',m.workspace_id,m.user_id,'workspace',m.workspace_id,'{"backfilled":true}',m.created_at
from public.workspace_members m where m.role='owner';

insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
select 'onboarding_completed',w.id,'workspace',w.id,'{"backfilled":true}',w.onboarding_completed_at
from public.workspaces w where w.onboarding_completed_at is not null;

insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
select 'trial_started',w.id,'workspace',w.id,jsonb_build_object('ends_at',w.trial_ends_at,'backfilled',true),w.trial_started_at
from public.workspaces w where w.trial_started_at is not null;

insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
select 'pro_activated',w.id,'workspace',w.id,jsonb_build_object('ends_at',w.pro_ends_at,'backfilled',true),w.pro_started_at
from public.workspaces w where w.plan_code='pro' and w.pro_started_at is not null;

insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
select 'patient_created',p.workspace_id,p.created_by,'patient',p.id,
  jsonb_build_object('source',case when p.created_by is null then 'public' else 'manual' end,'backfilled',true),p.created_at
from public.patients p;

insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
select 'appointment_created',a.workspace_id,i.created_by,'appointment',a.id,jsonb_build_object('source',i.source,'backfilled',true),a.created_at
from public.appointments a join public.booking_intents i on i.id=a.booking_intent_id;

insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
select 'public_booking_completed',a.workspace_id,'appointment',a.id,'{"backfilled":true}',a.created_at
from public.appointments a join public.booking_intents i on i.id=a.booking_intent_id where i.source='public';

insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
select case when a.status='completed' then 'appointment_completed' else 'appointment_cancelled' end,a.workspace_id,'appointment',a.id,'{"backfilled":true}',a.status_changed_at
from public.appointments a where a.status in ('completed','cancelled') and a.status_changed_at is not null;

insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
select 'payment_recorded',p.workspace_id,p.recorded_by,'payment',p.id,
  jsonb_build_object('provider',case when p.provider in ('offline','mercado_pago_ar','external_link') then p.provider else 'other' end,'backfilled',true),p.approved_at
from public.payments p where p.status='approved' and p.approved_at is not null;

insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
select 'patient_note_created',n.workspace_id,n.author_id,'patient_note',n.id,'{"backfilled":true}',n.created_at
from public.patient_notes n;

insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
select 'followup_created',f.workspace_id,case when f.source='manual' then f.created_by end,'follow_up',f.id,
  jsonb_build_object('source',f.source,'backfilled',true),f.created_at
from public.patient_follow_ups f;

insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
select 'automation_enabled',r.workspace_id,'automation_rule',r.id,jsonb_build_object('rule',r.rule_key,'backfilled',true),r.enabled_at
from public.automation_rules r where r.enabled and r.enabled_at is not null;

insert into public.product_events(event_name,workspace_id,user_id,entity_type,entity_id,metadata,created_at)
select 'upgrade_requested',r.workspace_id,r.requested_by,'upgrade_request',r.id,jsonb_build_object('plan',r.requested_plan,'backfilled',true),r.created_at
from public.plan_upgrade_requests r;

select private.record_plan_expirations();
