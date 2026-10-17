-- Reagendar un turno manual: permisos, horarios ofrecidos, mismo turno con otro horario, conflictos, errores,
-- intención de sincronización con Google Calendar y ausencia de otros efectos. Datos sintéticos; todo se revierte.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f7e00000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'reschedule-' || n || '@example.invalid','',now(),'{}','{}',now(),now()
from generate_series(1,6) n;
insert into public.workspaces(id,name,slug,payment_provider) values
  ('f7e00000-0000-4000-8000-0000000000a1','Manual reschedule smoke','manual-reschedule-smoke','external_link'),
  ('f7e00000-0000-4000-8000-0000000000a2','Manual reschedule smoke B','manual-reschedule-smoke-b','external_link');
-- Pro con la beta de Google Calendar: los turnos de A tienen intención de sincronización desde que se crean.
update public.workspaces set plan_code='pro',pro_started_at='2020-01-01' where id='f7e00000-0000-4000-8000-0000000000a1';
insert into private.workspace_features(workspace_id,feature,enabled_by) values('f7e00000-0000-4000-8000-0000000000a1','google_calendar_beta','smoke');
-- 1 owner, 2 admin, 3 recepción, 4 profesional A, 5 profesional B, 6 owner y profesional del otro workspace.
insert into public.workspace_members(workspace_id,user_id,role) values
  ('f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-000000000001','owner'),
  ('f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-000000000002','admin'),
  ('f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-000000000003','reception'),
  ('f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-000000000004','professional'),
  ('f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-000000000005','professional'),
  ('f7e00000-0000-4000-8000-0000000000a2','f7e00000-0000-4000-8000-000000000006','owner');
-- A: horarios cada 30, sin descanso. B: cada 60, sin descanso, máximo 1 turno por día.
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug) values
  ('f7e00000-0000-4000-8000-0000000000b1','f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-000000000004','Smoke A','Psicología','manual-reschedule-a'),
  ('f7e00000-0000-4000-8000-0000000000b2','f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-000000000005','Smoke B','Psicología','manual-reschedule-b'),
  ('f7e00000-0000-4000-8000-0000000000b3','f7e00000-0000-4000-8000-0000000000a2','f7e00000-0000-4000-8000-000000000006','Smoke C','Psicología','manual-reschedule-c');
update public.professionals set slot_interval_minutes=30 where id='f7e00000-0000-4000-8000-0000000000b1';
update public.professionals set slot_interval_minutes=60,max_appointments_per_day=1 where id='f7e00000-0000-4000-8000-0000000000b2';
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes) values
  ('f7e00000-0000-4000-8000-0000000000c1','f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-0000000000b1','Consulta A',2500000,60,'online',0),
  ('f7e00000-0000-4000-8000-0000000000c2','f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-0000000000b2','Consulta B',2500000,60,'online',0);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'f7e00000-0000-4000-8000-0000000000a1',professional,day,'09:00','13:00',0
from (values('f7e00000-0000-4000-8000-0000000000b1'::uuid),('f7e00000-0000-4000-8000-0000000000b2')) as t(professional), generate_series(0,6) day;
insert into public.patients(id,workspace_id,first_name,last_name,email,phone)
select ('f7e00000-0000-4000-8000-0000000000d' || n)::uuid,'f7e00000-0000-4000-8000-0000000000a1','Prueba','Reagenda ' || n,
  'reschedule-p' || n || '@example.invalid','+549115555270' || n
from generate_series(1,6) n;
-- Google Calendar conectado para A. Referencias de token falsas: acá no se llama a Google ni a las credenciales.
insert into private.google_calendar_accounts(professional_id,workspace_id,google_subject,access_token_secret_id,
  refresh_token_secret_id,token_expires_at,granted_scopes,status,calendar_id,calendar_timezone,connected_at) values
  ('f7e00000-0000-4000-8000-0000000000b1','f7e00000-0000-4000-8000-0000000000a1','reschedule-a',gen_random_uuid(),gen_random_uuid(),
    now()+interval '1 hour','{}','connected','cal-reschedule@example.invalid','America/Argentina/Buenos_Aires',now());

create temp table mr_plan(tag text primary key,patient integer,professional text,day_offset integer,hour integer,paid boolean);
insert into mr_plan values
  ('move',1,'a',0,10,true),('blocker',2,'a',2,10,false),('done',3,'a',3,10,false),('cancelled',4,'a',4,10,false),
  ('pro_b',5,'b',0,9,false);
create temp table mr as
select p.*,(now() at time zone 'America/Argentina/Buenos_Aires')::date + 7 + p.day_offset as d,
  ('f7e00000-0000-4000-8000-0000000000d' || p.patient)::uuid patient_id,
  case p.professional when 'a' then 'f7e00000-0000-4000-8000-0000000000b1' else 'f7e00000-0000-4000-8000-0000000000b2' end::uuid professional_id,
  case p.professional when 'a' then 'f7e00000-0000-4000-8000-0000000000c1' else 'f7e00000-0000-4000-8000-0000000000c2' end::uuid service_id,
  null::uuid appointment_id
from mr_plan p;
grant select,update,insert on mr to authenticated;
create function pg_temp.at(p_day date,p_hour integer,p_minute integer default 0) returns timestamptz language sql as $$
  select (p_day + make_time(p_hour,p_minute,0)) at time zone 'America/Argentina/Buenos_Aires' $$;
create function pg_temp.as_user(p_n integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub',case when p_n is null then '' else 'f7e00000-0000-4000-8000-00000000000' || p_n end,true) $$;
-- Los horarios a los que se puede mover un turno ese día: '9:00,9:30,…'.
create function pg_temp.moves(p_appointment uuid,p_day date) returns text language sql as $$
  select coalesce(string_agg(to_char(s.starts_at at time zone 'America/Argentina/Buenos_Aires','FMHH24:MI'), ',' order by s.starts_at),'')
  from public.manual_reschedule_slots(p_appointment,p_day) s $$;
create function pg_temp.hours(p_professional uuid,p_service uuid,p_day date) returns text language sql as $$
  select coalesce(string_agg(to_char(s.starts_at at time zone 'America/Argentina/Buenos_Aires','FMHH24:MI'), ',' order by s.starts_at),'')
  from public.manual_available_slots(p_professional,p_service,p_day) s $$;
create function pg_temp.fails(p_sql text,p_error text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm <> p_error then raise exception 'expected % but got %: %', p_error, sqlerrm, p_sql; end if; return; end;
  raise exception 'expected % but it succeeded: %', p_error, p_sql;
end $$;

-- Anónimo no tiene acceso; autenticado solo a las funciones públicas y a las privadas que ellas usan.
do $$ begin
  if has_function_privilege('anon','public.reschedule_manual_appointment(uuid,timestamptz)','execute')
    or has_function_privilege('anon','private.reschedule_manual_appointment(uuid,timestamptz)','execute')
    or has_function_privilege('anon','public.manual_reschedule_slots(uuid,date)','execute')
    or has_function_privilege('anon','private.manual_reschedule_slots(uuid,date)','execute')
    or has_function_privilege('authenticated','private.reschedulable_manual_appointment(uuid,boolean)','execute')
    or has_function_privilege('authenticated','private.professional_free_slots(uuid,uuid,date,integer,integer,uuid)','execute')
    or has_function_privilege('authenticated','private.professional_free_slots(uuid,uuid,date,integer,integer)','execute')
    or not has_function_privilege('authenticated','public.reschedule_manual_appointment(uuid,timestamptz)','execute')
    or not has_function_privilege('authenticated','public.manual_reschedule_slots(uuid,date)','execute')
    then raise exception 'reschedule_privileges_wrong'; end if;
end $$;

-- El owner carga los turnos por el camino real.
select pg_temp.as_user(1);
set local role authenticated;
update mr set appointment_id = public.create_manual_appointment(professional_id,patient_id,service_id,pg_temp.at(d,hour),
  case when paid then 'transfer' end,case when paid then 2450000 end);
reset role;
update public.appointments set status='completed' where id=(select appointment_id from mr where tag='done');
update public.appointments set status='cancelled' where id=(select appointment_id from mr where tag='cancelled');
-- Un turno del booking público, cargado directo: su alta real no es lo que se prueba acá.
with intent as (
  insert into public.booking_intents(workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes,source)
  values('f7e00000-0000-4000-8000-0000000000a1','f7e00000-0000-4000-8000-0000000000b1','f7e00000-0000-4000-8000-0000000000c1',
    'f7e00000-0000-4000-8000-0000000000d6','scheduled',2500000,'ARS',60,'public') returning id
), appointment as (
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  select 'f7e00000-0000-4000-8000-0000000000a1',intent.id,'f7e00000-0000-4000-8000-0000000000b1','f7e00000-0000-4000-8000-0000000000d6',
    pg_temp.at((select d from mr where tag='move') + 5,10),pg_temp.at((select d from mr where tag='move') + 5,11) from intent returning id
)
insert into mr(tag,patient,professional,day_offset,hour,paid,d,patient_id,professional_id,service_id,appointment_id)
select 'public',6,'a',5,10,false,(select d from mr where tag='move') + 5,
  'f7e00000-0000-4000-8000-0000000000d6','f7e00000-0000-4000-8000-0000000000b1','f7e00000-0000-4000-8000-0000000000c1',appointment.id from appointment;

-- El turno a mover ya está en Google: evento vigente en su generación 1.
update private.google_calendar_event_sync s set event_id='bellis' || replace(s.appointment_id::text,'-','') || 'g1',generation=1,
  state='synced',last_success_at=now() where s.appointment_id=(select appointment_id from mr where tag='move');
create temp table mr_before as select
  (select count(*) from public.appointments where workspace_id='f7e00000-0000-4000-8000-0000000000a1') appointments,
  (select count(*) from public.booking_intents where workspace_id='f7e00000-0000-4000-8000-0000000000a1') intents,
  (select count(*) from public.payments where workspace_id='f7e00000-0000-4000-8000-0000000000a1') payments,
  (select count(*) from public.notification_outbox) outbox,(select count(*) from public.automation_runs) runs,
  (select count(*) from public.internal_notifications) notifications,
  (select desired_revision from private.google_calendar_event_sync where appointment_id=(select appointment_id from mr where tag='move')) revision,
  (select a.booking_intent_id from public.appointments a where a.id=(select appointment_id from mr where tag='move')) intent;
grant select on mr_before to authenticated;

set local role authenticated;
do $$ declare r record; b record;
begin
  select * into r from mr where tag='move';
  -- ERRORES, con el turno intacto.
  perform pg_temp.as_user(null);
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d,11)),'authentication_required');
  perform pg_temp.fails(format('select public.manual_reschedule_slots(%L,%L)',r.appointment_id,r.d),'authentication_required');
  perform pg_temp.as_user(1);
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',gen_random_uuid(),pg_temp.at(r.d,11)),'not_authorized');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,null)',r.appointment_id),'slot_in_past');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,now() - interval '1 hour'),'slot_in_past');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d,10)),'slot_unchanged');
  -- Fuera de la grilla, fuera del horario de atención y encima de otro turno.
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d,10,17)),'slot_unavailable');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d,15)),'slot_unavailable');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d + 2,10)),'slot_unavailable');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d + 2,10,30)),'slot_unavailable');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d + 2,9,30)),'slot_unavailable');
  -- Solo turnos manuales agendados.
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',(select appointment_id from mr where tag='public'),pg_temp.at(r.d,12)),'not_manual_appointment');
  perform pg_temp.fails(format('select public.manual_reschedule_slots(%L,%L)',(select appointment_id from mr where tag='public'),r.d),'not_manual_appointment');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',(select appointment_id from mr where tag='done'),pg_temp.at(r.d,12)),'appointment_not_reschedulable');
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',(select appointment_id from mr where tag='cancelled'),pg_temp.at(r.d,12)),'appointment_not_reschedulable');
  perform pg_temp.fails(format('select public.manual_reschedule_slots(%L,%L)',(select appointment_id from mr where tag='cancelled'),r.d),'appointment_not_reschedulable');
  -- PERMISOS: otro workspace y un profesional sobre una agenda ajena.
  perform pg_temp.as_user(6);
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d,11)),'not_authorized');
  perform pg_temp.fails(format('select public.manual_reschedule_slots(%L,%L)',r.appointment_id,r.d),'not_authorized');
  perform pg_temp.as_user(5);
  perform pg_temp.fails(format('select public.reschedule_manual_appointment(%L,%L)',r.appointment_id,pg_temp.at(r.d,11)),'not_authorized');
  if (select starts_at from public.appointments where id=r.appointment_id) <> pg_temp.at(r.d,10) then raise exception 'rejected_reschedule_moved_turn'; end if;

  -- HORARIOS OFRECIDOS. El propio turno no ocupa lugar y su horario actual no se ofrece: de 9 a 12 cada 30, sin las 10.
  perform pg_temp.as_user(4);
  if pg_temp.moves(r.appointment_id,r.d) <> '9:00,9:30,10:30,11:00,11:30,12:00' then raise exception 'moves_wrong: %', pg_temp.moves(r.appointment_id,r.d); end if;
  -- Para un turno nuevo de 60 minutos, el mismo día sí está ocupado de 9:30 a 10:30. La firma de siempre no cambió.
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '9:00,11:00,11:30,12:00' then raise exception 'shared_slots_changed: %', pg_temp.hours(r.professional_id,r.service_id,r.d); end if;
  -- El otro turno de A sí bloquea su horario.
  if pg_temp.moves(r.appointment_id,r.d + 2) <> '9:00,11:00,11:30,12:00' then raise exception 'other_turn_not_blocking: %', pg_temp.moves(r.appointment_id,r.d + 2); end if;

  -- REAGENDAR (profesional dueño de la agenda): media hora más tarde, encima de su propio horario anterior.
  if public.reschedule_manual_appointment(r.appointment_id,pg_temp.at(r.d,10,30)) <> r.appointment_id then raise exception 'reschedule_did_not_return_appointment'; end if;
  if (select starts_at || '/' || ends_at from public.appointments where id=r.appointment_id) <> pg_temp.at(r.d,10,30) || '/' || pg_temp.at(r.d,11,30)
    then raise exception 'first_move_wrong'; end if;
  -- Ahora ocupa de 10:30 a 11:30: las 9:30 quedan libres para un turno nuevo y las 11 ya no.
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '9:00,9:30,11:30,12:00' then raise exception 'old_slot_not_released: %', pg_temp.hours(r.professional_id,r.service_id,r.d); end if;
  -- Recepción lo pasa a otro día.
  perform pg_temp.as_user(3);
  perform public.reschedule_manual_appointment(r.appointment_id,pg_temp.at(r.d + 1,11));
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '9:00,9:30,10:00,10:30,11:00,11:30,12:00' then raise exception 'day_not_released: %', pg_temp.hours(r.professional_id,r.service_id,r.d); end if;

  -- MÁXIMO DIARIO: B tiene 1 por día y ya lo usa ese turno. Moverlo dentro del mismo día no cuenta dos veces.
  select * into b from mr where tag='pro_b';
  perform pg_temp.as_user(5);
  if pg_temp.hours(b.professional_id,b.service_id,b.d) <> '' then raise exception 'daily_max_not_applied'; end if;
  if pg_temp.moves(b.appointment_id,b.d) <> '10:00,11:00,12:00' then raise exception 'daily_max_counts_itself: %', pg_temp.moves(b.appointment_id,b.d); end if;
  perform public.reschedule_manual_appointment(b.appointment_id,pg_temp.at(b.d,11));
  if pg_temp.hours(b.professional_id,b.service_id,b.d) <> '' then raise exception 'daily_max_lost_after_move'; end if;
end $$;
reset role;
select pg_temp.as_user(null);

-- Lo que quedó guardado.
do $$ declare v text; v_ws uuid := 'f7e00000-0000-4000-8000-0000000000a1'; r record; s private.google_calendar_event_sync%rowtype;
begin
  select * into r from mr where tag='move';
  -- El mismo turno: mismo id, misma solicitud, mismo paciente y profesional, misma duración, sigue agendado.
  if (select a.booking_intent_id from public.appointments a where a.id=r.appointment_id) <> (select intent from mr_before)
    or (select a.patient_id::text || a.professional_id::text || a.status from public.appointments a where a.id=r.appointment_id)
      <> r.patient_id::text || r.professional_id::text || 'scheduled'
    or (select a.starts_at || '/' || a.ends_at from public.appointments a where a.id=r.appointment_id) <> pg_temp.at(r.d + 1,11) || '/' || pg_temp.at(r.d + 1,12)
    then raise exception 'moved_turn_wrong'; end if;
  -- Ningún turno, solicitud ni pago nuevo. El cobro sigue en su solicitud.
  if (select count(*) from public.appointments where workspace_id=v_ws) <> (select appointments from mr_before)
    or (select count(*) from public.booking_intents where workspace_id=v_ws) <> (select intents from mr_before)
    or (select count(*) from public.payments where workspace_id=v_ws) <> (select payments from mr_before)
    then raise exception 'reschedule_created_rows'; end if;
  if (select string_agg(p.method || ':' || p.amount_minor, ' ') from public.payments p where p.booking_intent_id=(select intent from mr_before)) is distinct from 'transfer:2450000'
    then raise exception 'payment_changed'; end if;
  -- Google Calendar: la misma fila, el mismo evento y la misma generación; cada cambio de horario pidió una actualización.
  select * into s from private.google_calendar_event_sync where appointment_id=r.appointment_id;
  if s.id is null or s.event_id <> 'bellis' || replace(r.appointment_id::text,'-','') || 'g1' or s.generation <> 1
    or s.desired_action <> 'upsert' or s.state <> 'pending' or s.desired_revision <> (select revision from mr_before) + 2
    or s.desired_starts_at <> pg_temp.at(r.d + 1,11) or s.desired_ends_at <> pg_temp.at(r.d + 1,12)
    then raise exception 'sync_intent_wrong: % % % % %', s.event_id, s.generation, s.desired_action, s.state, s.desired_revision; end if;
  if (select count(*) from private.google_calendar_event_sync where appointment_id=r.appointment_id) <> 1 then raise exception 'sync_row_duplicated'; end if;
  -- Auditoría: un reagendado por movimiento, con su actor, sin horarios ni datos del paciente.
  select string_agg(m.tag || ':' || right(e.actor_user_id::text,1), ' ' order by e.id) into v
  from public.audit_events e join mr m on m.appointment_id=e.object_id
  where e.action='manual_appointment_rescheduled' and e.object_type='appointment' and e.workspace_id=v_ws;
  if v is distinct from 'move:4 move:3 pro_b:5' then raise exception 'reschedule_audit_wrong: %', v; end if;
  -- Cero avisos, cero automatizaciones.
  if (select count(*) from public.notification_outbox) <> (select outbox from mr_before)
    or (select count(*) from public.automation_runs) <> (select runs from mr_before)
    or (select count(*) from public.internal_notifications) <> (select notifications from mr_before) then raise exception 'side_effects_found'; end if;
end $$;
select count(*) as rescheduled_manual_appointments from public.audit_events
where workspace_id='f7e00000-0000-4000-8000-0000000000a1' and action='manual_appointment_rescheduled';
rollback;
