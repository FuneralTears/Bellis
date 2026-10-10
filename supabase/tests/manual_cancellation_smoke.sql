-- H2.5 cancelar un turno manual: permisos, cancelar sin cobrar, cancelar y cobrar, turno ya cobrado, errores,
-- horario liberado y efectos. Datos sintéticos; todo se revierte.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('fc000000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h25-cancel-' || n || '@example.invalid','',now(),'{}','{}',now(),now()
from generate_series(1,6) n;
insert into public.workspaces(id,name,slug,payment_provider) values
  ('fc000000-0000-4000-8000-0000000000a1','Manual cancel smoke','manual-cancel-smoke','external_link'),
  ('fc000000-0000-4000-8000-0000000000a2','Manual cancel smoke B','manual-cancel-smoke-b','external_link');
-- 1 owner, 2 admin, 3 recepción, 4 profesional A, 5 profesional B, 6 owner y profesional del otro workspace.
insert into public.workspace_members(workspace_id,user_id,role) values
  ('fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-000000000001','owner'),
  ('fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-000000000002','admin'),
  ('fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-000000000003','reception'),
  ('fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-000000000004','professional'),
  ('fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-000000000005','professional'),
  ('fc000000-0000-4000-8000-0000000000a2','fc000000-0000-4000-8000-000000000006','owner');
-- A: horarios cada 60 con 30 de descanso. B: cada 60, sin descanso, máximo 1 turno por día.
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug) values
  ('fc000000-0000-4000-8000-0000000000b1','fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-000000000004','Smoke A','Psicología','manual-cancel-a'),
  ('fc000000-0000-4000-8000-0000000000b2','fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-000000000005','Smoke B','Psicología','manual-cancel-b'),
  ('fc000000-0000-4000-8000-0000000000b3','fc000000-0000-4000-8000-0000000000a2','fc000000-0000-4000-8000-000000000006','Smoke C','Psicología','manual-cancel-c');
update public.professionals set slot_interval_minutes=60 where id in ('fc000000-0000-4000-8000-0000000000b1','fc000000-0000-4000-8000-0000000000b2');
update public.professionals set max_appointments_per_day=1 where id='fc000000-0000-4000-8000-0000000000b2';
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes) values
  ('fc000000-0000-4000-8000-0000000000c1','fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-0000000000b1','Consulta A',2500000,60,'online',0),
  ('fc000000-0000-4000-8000-0000000000c2','fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-0000000000b2','Consulta B',2500000,60,'online',0);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'fc000000-0000-4000-8000-0000000000a1',professional,day,'09:00','13:00',buffer
from (values('fc000000-0000-4000-8000-0000000000b1'::uuid,30),('fc000000-0000-4000-8000-0000000000b2',0)) as t(professional,buffer), generate_series(0,6) day;
insert into public.patients(id,workspace_id,first_name,last_name,email,phone)
select ('fc000000-0000-4000-8000-0000000000d' || n)::uuid,'fc000000-0000-4000-8000-0000000000a1','Prueba','Cancela ' || n,
  'h25-p' || n || '@example.invalid','+549115555250' || n
from generate_series(1,9) n;

-- Un turno por día local (d, d+1, …) para A, todos a las 10:00, y uno para B. `paid` = cobrado al crearlo.
create temp table mc_plan(tag text primary key,patient integer,professional text,day_offset integer,hour integer,paid boolean);
insert into mc_plan values
  ('owner_free',1,'a',0,10,false),('admin_cash',2,'a',1,10,false),('reception_transfer',3,'a',2,10,false),
  ('pro_other',4,'a',3,10,false),('already_paid',5,'a',4,10,true),('errors',6,'a',5,10,false),
  ('done',7,'a',6,10,false),('pro_b',8,'b',0,9,false);
create temp table mc as
select p.*,'America/Argentina/Buenos_Aires'::text tz,
  (now() at time zone 'America/Argentina/Buenos_Aires')::date + 7 + p.day_offset as d,
  ('fc000000-0000-4000-8000-0000000000d' || p.patient)::uuid patient_id,
  case p.professional when 'a' then 'fc000000-0000-4000-8000-0000000000b1' else 'fc000000-0000-4000-8000-0000000000b2' end::uuid professional_id,
  case p.professional when 'a' then 'fc000000-0000-4000-8000-0000000000c1' else 'fc000000-0000-4000-8000-0000000000c2' end::uuid service_id,
  null::uuid appointment_id
from mc_plan p;
grant select,update,insert on mc to authenticated;
create function pg_temp.at(p_day date,p_hour integer) returns timestamptz language sql as $$
  select (p_day + make_time(p_hour,0,0)) at time zone 'America/Argentina/Buenos_Aires' $$;
create function pg_temp.as_user(p_n integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub',case when p_n is null then '' else 'fc000000-0000-4000-8000-00000000000' || p_n end,true) $$;
-- Las horas libres de un día, como las ve quien carga turnos: '9,10,11,12'.
create function pg_temp.hours(p_professional uuid,p_service uuid,p_day date) returns text language sql as $$
  select coalesce(string_agg(extract(hour from s.starts_at at time zone 'America/Argentina/Buenos_Aires')::integer::text, ',' order by s.starts_at),'')
  from public.manual_available_slots(p_professional,p_service,p_day) s $$;
-- Espera que una llamada falle con ese error exacto.
create function pg_temp.fails(p_sql text,p_error text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm <> p_error then raise exception 'expected % but got %: %', p_error, sqlerrm, p_sql; end if; return; end;
  raise exception 'expected % but it succeeded: %', p_error, p_sql;
end $$;

-- Anónimo no tiene acceso a la función.
do $$ begin
  if has_function_privilege('anon','public.cancel_manual_appointment(uuid,text,text,integer)','execute')
    or has_function_privilege('anon','private.cancel_manual_appointment(uuid,text,text,integer)','execute')
    or not has_function_privilege('authenticated','public.cancel_manual_appointment(uuid,text,text,integer)','execute')
    then raise exception 'cancel_privileges_wrong'; end if;
end $$;

-- El owner carga todos los turnos por el camino real.
select pg_temp.as_user(1);
set local role authenticated;
update mc set appointment_id = public.create_manual_appointment(professional_id,patient_id,service_id,pg_temp.at(d,hour),
  case when paid then 'transfer' end,case when paid then 2450000 end);
reset role;
-- Un turno ya atendido, y uno del booking público (cargado directo: su alta real no es lo que se prueba acá).
update public.appointments set status='completed' where id=(select appointment_id from mc where tag='done');
with intent as (
  insert into public.booking_intents(workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes,source)
  values('fc000000-0000-4000-8000-0000000000a1','fc000000-0000-4000-8000-0000000000b1','fc000000-0000-4000-8000-0000000000c1',
    'fc000000-0000-4000-8000-0000000000d9','scheduled',2500000,'ARS',60,'public') returning id
), appointment as (
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  select 'fc000000-0000-4000-8000-0000000000a1',intent.id,'fc000000-0000-4000-8000-0000000000b1','fc000000-0000-4000-8000-0000000000d9',
    pg_temp.at((select d from mc where tag='owner_free') + 8,10),pg_temp.at((select d from mc where tag='owner_free') + 8,11) from intent returning id
)
insert into mc(tag,patient,professional,day_offset,hour,paid,tz,d,patient_id,professional_id,service_id,appointment_id)
select 'public',9,'a',8,10,false,'America/Argentina/Buenos_Aires',(select d from mc where tag='owner_free') + 8,
  'fc000000-0000-4000-8000-0000000000d9','fc000000-0000-4000-8000-0000000000b1','fc000000-0000-4000-8000-0000000000c1',appointment.id from appointment;
create temp table mc_before as select
  (select count(*) from public.notification_outbox) outbox,(select count(*) from public.automation_runs) runs,
  (select count(*) from public.internal_notifications) notifications;

set local role authenticated;
do $$ declare r record; v text; v_new uuid;
begin
  -- ERRORES, sobre un turno pendiente que tiene que quedar intacto.
  select * into r from mc where tag='errors';
  perform pg_temp.as_user(null);
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',r.appointment_id,'no_payment'),'authentication_required');
  perform pg_temp.as_user(1);
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',r.appointment_id,'refund'),'invalid_cancel_mode');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,null)',r.appointment_id),'invalid_cancel_mode');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,%L,2500000)',r.appointment_id,'no_payment','cash'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,null,2500000)',r.appointment_id,'no_payment'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',r.appointment_id,'record_payment'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,null,2500000)',r.appointment_id,'record_payment'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,%L)',r.appointment_id,'record_payment','cash'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,%L,0)',r.appointment_id,'record_payment','cash'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,%L,-100)',r.appointment_id,'record_payment','cash'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,%L,2500000)',r.appointment_id,'record_payment','card'),'invalid_payment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',gen_random_uuid(),'no_payment'),'not_authorized');
  -- Un turno público y uno ya atendido no se cancelan desde acá.
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',(select appointment_id from mc where tag='public'),'no_payment'),'not_manual_appointment');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',(select appointment_id from mc where tag='done'),'no_payment'),'appointment_not_cancellable');

  -- PERMISOS: otro workspace y un profesional sobre una agenda ajena, rechazados.
  select * into r from mc where tag='pro_b';
  perform pg_temp.as_user(6);
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',r.appointment_id,'no_payment'),'not_authorized');
  perform pg_temp.as_user(4);
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',r.appointment_id,'no_payment'),'not_authorized');
  -- B tiene máximo 1 por día: con su turno, el día no ofrece nada. Lo cancela él mismo y el día vuelve entero.
  perform pg_temp.as_user(5);
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '' then raise exception 'daily_max_not_applied'; end if;
  perform public.cancel_manual_appointment(r.appointment_id,'no_payment');
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '9,10,11,12' then raise exception 'daily_max_not_recalculated: %', pg_temp.hours(r.professional_id,r.service_id,r.d); end if;
  -- Y no cancela en la agenda de A.
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',(select appointment_id from mc where tag='owner_free'),'no_payment'),'not_authorized');

  -- SIN PAGO (owner): con 30 de descanso, el turno de las 10 deja libre solo las 12. Cancelado, vuelven todas.
  perform pg_temp.as_user(1);
  select * into r from mc where tag='owner_free';
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '12' then raise exception 'buffer_not_applied: %', pg_temp.hours(r.professional_id,r.service_id,r.d); end if;
  if (select pending_payment_count from public.patient_follow_up_opportunities where id=r.patient_id) <> 1 then raise exception 'pending_signal_missing'; end if;
  if public.cancel_manual_appointment(r.appointment_id,'no_payment') <> r.appointment_id then raise exception 'cancel_did_not_return_appointment'; end if;
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '9,10,11,12' then raise exception 'slot_not_released: %', pg_temp.hours(r.professional_id,r.service_id,r.d); end if;
  if (select pending_payment_count from public.patient_follow_up_opportunities where id=r.patient_id) <> 0 then raise exception 'pending_signal_kept'; end if;
  -- Doble cancelación, y cobrar un turno cancelado.
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L)',r.appointment_id,'no_payment'),'appointment_already_cancelled');
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,%L,2500000)',r.appointment_id,'record_payment','cash'),'appointment_already_cancelled');
  perform pg_temp.fails(format('select public.record_offline_payment(%L,%L)',r.appointment_id,'cash'),'appointment_not_active');
  -- El horario liberado se puede volver a cargar: el turno cancelado no lo bloquea.
  v_new := public.create_manual_appointment(r.professional_id,r.patient_id,r.service_id,pg_temp.at(r.d,10));
  insert into mc(tag,patient,professional,day_offset,hour,paid,tz,d,patient_id,professional_id,service_id,appointment_id)
  values('rebooked',r.patient,'a',r.day_offset,10,false,r.tz,r.d,r.patient_id,r.professional_id,r.service_id,v_new);

  -- CANCELAR + COBRAR: admin en efectivo, recepción por transferencia con otro importe, profesional propio con "otro".
  perform pg_temp.as_user(2);
  perform public.cancel_manual_appointment((select appointment_id from mc where tag='admin_cash'),'record_payment','cash',2500000);
  perform pg_temp.as_user(3);
  perform public.cancel_manual_appointment((select appointment_id from mc where tag='reception_transfer'),'record_payment','transfer',1200000);
  perform pg_temp.as_user(4);
  select * into r from mc where tag='pro_other';
  perform public.cancel_manual_appointment(r.appointment_id,'record_payment','other',2500000);
  if pg_temp.hours(r.professional_id,r.service_id,r.d) <> '9,10,11,12' then raise exception 'slot_not_released_after_charge'; end if;
  -- Cobrado y cancelado: no queda como pago pendiente.
  if (select pending_payment_count from public.patient_follow_up_opportunities where id=r.patient_id) <> 0 then raise exception 'pending_after_cancel_and_charge'; end if;

  -- YA PAGADO: no acepta otro cobro (y el turno sigue agendado); cancelar conserva el cobro.
  perform pg_temp.as_user(1);
  select * into r from mc where tag='already_paid';
  perform pg_temp.fails(format('select public.cancel_manual_appointment(%L,%L,%L,2500000)',r.appointment_id,'record_payment','cash'),'payment_already_recorded');
  if (select status from public.appointments where id=r.appointment_id) <> 'scheduled' then raise exception 'rejected_cancel_left_effects'; end if;
  perform public.cancel_manual_appointment(r.appointment_id,'no_payment');
end $$;
reset role;
select pg_temp.as_user(null);

-- Lo que quedó guardado.
do $$ declare v text; v_ws uuid := 'fc000000-0000-4000-8000-0000000000a1';
begin
  -- Turnos y solicitudes: nada se borra; los cancelados quedan cancelados en los dos lados, con su fecha de cambio.
  select string_agg(m.tag || ':' || a.status || ':' || i.status, ' ' order by m.tag) into v
  from mc m join public.appointments a on a.id=m.appointment_id join public.booking_intents i on i.id=a.booking_intent_id;
  if v is distinct from 'admin_cash:cancelled:cancelled already_paid:cancelled:cancelled done:completed:scheduled errors:scheduled:scheduled owner_free:cancelled:cancelled pro_b:cancelled:cancelled pro_other:cancelled:cancelled public:scheduled:scheduled rebooked:scheduled:scheduled reception_transfer:cancelled:cancelled'
    then raise exception 'states_wrong: %', v; end if;
  if exists(select 1 from mc m join public.appointments a on a.id=m.appointment_id where a.status='cancelled' and a.status_changed_at is null)
    then raise exception 'cancel_time_missing'; end if;
  -- Pagos: uno por turno cobrado, offline, aprobado, en ARS, con el medio, el importe y quién lo registró.
  select string_agg(m.tag || ':' || p.method || ':' || p.amount_minor || ':' || right(p.recorded_by::text,1), ' ' order by m.tag) into v
  from mc m join public.appointments a on a.id=m.appointment_id join public.payments p on p.booking_intent_id=a.booking_intent_id;
  if v is distinct from 'admin_cash:cash:2500000:2 already_paid:transfer:2450000:1 pro_other:other:2500000:4 reception_transfer:transfer:1200000:3'
    then raise exception 'payments_wrong: %', v; end if;
  if exists(select 1 from public.payments p where p.workspace_id=v_ws and (p.provider <> 'offline' or p.status <> 'approved' or p.currency_code <> 'ARS'
    or p.approved_at is null or p.provider_order_id is not null or p.provider_payment_id is not null or p.provider_event_id is not null or p.checkout_url is not null))
    then raise exception 'payment_shape_wrong'; end if;
  -- Auditoría: una cancelación por turno cancelado, con su actor; un cobro auditado por pago. Sin duplicados.
  select string_agg(m.tag || ':' || right(e.actor_user_id::text,1), ' ' order by m.tag) into v
  from public.audit_events e join mc m on m.appointment_id=e.object_id
  where e.action='manual_appointment_cancelled' and e.object_type='appointment' and e.workspace_id=v_ws;
  if v is distinct from 'admin_cash:2 already_paid:1 owner_free:1 pro_b:5 pro_other:4 reception_transfer:3' then raise exception 'cancel_audit_wrong: %', v; end if;
  if (select count(*) from public.audit_events e where e.workspace_id=v_ws and e.action='offline_payment_recorded') <> 4
    or (select count(*) from public.audit_events e join public.payments p on p.id=e.object_id and p.recorded_by=e.actor_user_id
      where e.workspace_id=v_ws and e.action='offline_payment_recorded') <> 4 then raise exception 'payment_audit_wrong'; end if;
  if exists(select 1 from public.audit_events e where e.workspace_id=v_ws and e.object_type in ('appointment','payment') and e.action not in ('manual_appointment_created','manual_appointment_cancelled','offline_payment_recorded'))
    then raise exception 'unexpected_audit_action'; end if;
  -- Cero avisos, cero automatizaciones.
  if (select count(*) from public.notification_outbox) <> (select outbox from mc_before)
    or (select count(*) from public.automation_runs) <> (select runs from mc_before)
    or (select count(*) from public.internal_notifications) <> (select notifications from mc_before) then raise exception 'side_effects_found'; end if;
  -- Un pago offline sobre una solicitud cancelada no es un pago tardío de Mercado Pago: sigue siendo offline.
  if exists(select 1 from public.payments p join public.booking_intents i on i.id=p.booking_intent_id
    where i.workspace_id=v_ws and i.status='cancelled' and p.provider='mercado_pago_ar') then raise exception 'provider_changed'; end if;
end $$;
select count(*) as cancelled_manual_appointments from public.appointments a join public.booking_intents i on i.id=a.booking_intent_id
where a.workspace_id='fc000000-0000-4000-8000-0000000000a1' and a.status='cancelled' and i.source='manual';
rollback;
