-- H2.4 señal de "pago pendiente" del CRM: cuenta los turnos manuales sin cobrar, sin duplicar los del booking
-- público, sin cruzar workspaces y sin tocar las demás señales. Datos sintéticos; todo se revierte.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('fb000000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h24-pending-' || n || '@example.invalid','',now(),'{}','{}',now(),now()
from generate_series(1,2) n;
insert into public.workspaces(id,name,slug,payment_provider) values
  ('fb000000-0000-4000-8000-0000000000a1','Pending payment smoke','pending-payment-smoke','external_link'),
  ('fb000000-0000-4000-8000-0000000000a2','Pending payment smoke B','pending-payment-smoke-b','external_link');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('fb000000-0000-4000-8000-0000000000a1','fb000000-0000-4000-8000-000000000001','owner'),
  ('fb000000-0000-4000-8000-0000000000a2','fb000000-0000-4000-8000-000000000002','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug) values
  ('fb000000-0000-4000-8000-0000000000b1','fb000000-0000-4000-8000-0000000000a1','fb000000-0000-4000-8000-000000000001','Smoke A','Psicología','pending-payment-a'),
  ('fb000000-0000-4000-8000-0000000000b2','fb000000-0000-4000-8000-0000000000a2','fb000000-0000-4000-8000-000000000002','Smoke B','Psicología','pending-payment-b');
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes) values
  ('fb000000-0000-4000-8000-0000000000c1','fb000000-0000-4000-8000-0000000000a1','fb000000-0000-4000-8000-0000000000b1','Consulta',2500000,60,'online',0),
  ('fb000000-0000-4000-8000-0000000000c2','fb000000-0000-4000-8000-0000000000a2','fb000000-0000-4000-8000-0000000000b2','Consulta',2500000,60,'online',0);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'fb000000-0000-4000-8000-0000000000a1','fb000000-0000-4000-8000-0000000000b1',day,'09:00','18:00',0 from generate_series(0,6) day;
-- 1 manual sin cobrar · 2 manual cobrado · 3 público esperando pago · 4 público esperando + manual sin cobrar
-- 5 manual sin cobrar pero cancelado · 6 manual ya atendido sin cobrar · 7 sin turnos, con un seguimiento vencido
-- 8 del otro workspace, manual sin cobrar
insert into public.patients(id,workspace_id,first_name,last_name,email,phone)
select ('fb000000-0000-4000-8000-0000000000d' || n)::uuid,
  case when n = 8 then 'fb000000-0000-4000-8000-0000000000a2' else 'fb000000-0000-4000-8000-0000000000a1' end::uuid,
  'Prueba','Pago ' || n,'h24-p' || n || '@example.invalid','+549115555240' || n
from generate_series(1,8) n;

-- Las solicitudes y turnos se cargan directo: lo que se prueba es la vista, no el alta (eso es manual_booking_smoke).
create temp table h24_rows(tag text primary key,patient integer,source text,intent_status text,appointment_status text,payment text,day_offset integer,hour integer);
insert into h24_rows values
  ('manual_unpaid',1,'manual','scheduled','scheduled',null,7,9),
  ('manual_paid',2,'manual','scheduled','scheduled','offline',7,10),
  ('public_waiting',3,'public','pending_payment',null,'pending',null,null),
  ('both_public',4,'public','pending_payment',null,'pending',null,null),
  ('both_manual',4,'manual','scheduled','scheduled',null,7,11),
  ('manual_cancelled',5,'manual','scheduled','cancelled',null,7,12),
  ('manual_completed',6,'manual','scheduled','completed',null,-2,9),
  ('public_paid',6,'public','scheduled','scheduled','approved',7,13),
  ('other_workspace',8,'manual','scheduled','scheduled',null,7,9);
create temp table h24_ids as
select r.*,gen_random_uuid() intent_id,gen_random_uuid() appointment_id,
  ('fb000000-0000-4000-8000-0000000000d' || r.patient)::uuid patient_id,
  case when r.patient = 8 then 'fb000000-0000-4000-8000-0000000000a2' else 'fb000000-0000-4000-8000-0000000000a1' end::uuid workspace_id,
  case when r.patient = 8 then 'fb000000-0000-4000-8000-0000000000b2' else 'fb000000-0000-4000-8000-0000000000b1' end::uuid professional_id,
  case when r.patient = 8 then 'fb000000-0000-4000-8000-0000000000c2' else 'fb000000-0000-4000-8000-0000000000c1' end::uuid service_id
from h24_rows r;
grant select on h24_ids to authenticated;
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes,source,created_by)
select intent_id,workspace_id,professional_id,service_id,patient_id,intent_status::public.booking_status,2500000,'ARS',60,source,
  case when source='manual' then (select user_id from public.professionals p where p.id=professional_id) end
from h24_ids;
insert into public.appointments(id,workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select appointment_id,workspace_id,intent_id,professional_id,patient_id,
  ((now() at time zone 'America/Argentina/Buenos_Aires')::date + day_offset + make_time(hour,0,0)) at time zone 'America/Argentina/Buenos_Aires',
  ((now() at time zone 'America/Argentina/Buenos_Aires')::date + day_offset + make_time(hour + 1,0,0)) at time zone 'America/Argentina/Buenos_Aires',
  appointment_status::public.booking_status
from h24_ids where appointment_status is not null;
insert into public.payments(workspace_id,booking_intent_id,provider,method,provider_order_id,amount_minor,currency_code,status,approved_at,recorded_by)
select workspace_id,intent_id,case when payment='offline' then 'offline' else 'external_link' end,case when payment='offline' then 'cash' end,
  case when payment='offline' then null else intent_id::text end,2500000,'ARS',
  (case when payment='offline' then 'approved' else payment end)::public.payment_status,
  case when payment in ('offline','approved') then now() end,
  case when payment='offline' then (select user_id from public.professionals p where p.id=professional_id) end
from h24_ids where payment is not null;
insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by)
values('fb000000-0000-4000-8000-0000000000a1','fb000000-0000-4000-8000-0000000000d7','fb000000-0000-4000-8000-0000000000b1','Llamar',
  (now() at time zone 'America/Argentina/Buenos_Aires')::date - 3,'fb000000-0000-4000-8000-000000000001');

-- La vista conserva sus columnas, su orden y sus permisos.
do $$ begin
  if (select string_agg(column_name,',' order by ordinal_position) from information_schema.columns
    where table_schema='public' and table_name='patient_follow_up_opportunities' and ordinal_position > (select count(*) from information_schema.columns
      where table_schema='public' and table_name='patient_crm_overview'))
    is distinct from 'completed_turn_count,last_completed_turn,pending_payment_count,overdue_follow_up_count,without_next_turn,first_completed_without_next,inactive_after_care,has_pending_payment,has_overdue_follow_up,has_upcoming_turn,is_new_patient,is_recurrent_patient'
    then raise exception 'view_columns_changed'; end if;
  if has_table_privilege('anon','public.patient_follow_up_opportunities','select') or not has_table_privilege('authenticated','public.patient_follow_up_opportunities','select')
    then raise exception 'view_privileges_changed'; end if;
  if not exists(select 1 from pg_catalog.pg_class c where c.oid='public.patient_follow_up_opportunities'::regclass and 'security_invoker=true' = any(c.reloptions))
    then raise exception 'view_is_not_invoker'; end if;
end $$;

-- Como owner del primer workspace: lo que la pantalla de Pacientes ve.
select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$ declare v text; begin
  select string_agg(right(o.id::text,1) || ':' || o.pending_payment_count || ':' || o.has_pending_payment, ' ' order by o.id) into v
  from public.patient_follow_up_opportunities o where o.workspace_id='fb000000-0000-4000-8000-0000000000a1';
  -- 1 manual sin cobrar=1 · 2 cobrado=0 · 3 público esperando=1 · 4 uno de cada uno=2, sin duplicar
  -- 5 cancelado=0 · 6 atendido sin cobrar=1 (el público pago no suma) · 7 sin turnos=0
  if v is distinct from '1:1:true 2:0:false 3:1:true 4:2:true 5:0:false 6:1:true 7:0:false' then raise exception 'pending_counts_wrong: %', v; end if;
  -- El filtro "Pagos pendientes" de la pantalla usa esta columna.
  if (select count(*) from public.patient_follow_up_opportunities where workspace_id='fb000000-0000-4000-8000-0000000000a1' and has_pending_payment) <> 4
    then raise exception 'pending_filter_wrong'; end if;
  -- Las demás señales no cambiaron: el seguimiento vencido del paciente 7, y nada más vencido.
  if (select string_agg(right(o.id::text,1), ',' order by o.id) from public.patient_follow_up_opportunities o
    where o.workspace_id='fb000000-0000-4000-8000-0000000000a1' and o.has_overdue_follow_up) is distinct from '7' then raise exception 'overdue_signal_changed'; end if;
  if (select overdue_follow_up_count from public.patient_follow_up_opportunities where id='fb000000-0000-4000-8000-0000000000d7') <> 1 then raise exception 'overdue_count_changed'; end if;
  if (select has_upcoming_turn from public.patient_follow_up_opportunities where id='fb000000-0000-4000-8000-0000000000d1') is not true
    or (select completed_turn_count from public.patient_follow_up_opportunities where id='fb000000-0000-4000-8000-0000000000d6') <> 1 then raise exception 'turn_signals_changed'; end if;
  -- Aislamiento: nada del otro workspace.
  if exists(select 1 from public.patient_follow_up_opportunities where workspace_id='fb000000-0000-4000-8000-0000000000a2') then raise exception 'foreign_workspace_visible'; end if;
  -- Registrar el cobro apaga la señal de ese turno, y solo de ese.
  perform public.record_offline_payment((select appointment_id from h24_ids where tag='manual_unpaid'),'transfer',2000000);
  perform public.record_offline_payment((select appointment_id from h24_ids where tag='both_manual'),'cash');
  select string_agg(right(o.id::text,1) || ':' || o.pending_payment_count, ' ' order by o.id) into v
  from public.patient_follow_up_opportunities o where o.workspace_id='fb000000-0000-4000-8000-0000000000a1';
  if v is distinct from '1:0 2:0 3:1 4:1 5:0 6:1 7:0' then raise exception 'pending_counts_after_payment_wrong: %', v; end if;
  -- El importe cobrado puede diferir del precio, y un turno no se cobra dos veces.
  if (select amount_minor from public.payments where booking_intent_id=(select intent_id from h24_ids where tag='manual_unpaid')) <> 2000000 then raise exception 'edited_amount_lost'; end if;
  begin perform public.record_offline_payment((select appointment_id from h24_ids where tag='manual_unpaid'),'cash'); raise exception 'charged_twice';
  exception when others then if sqlerrm <> 'payment_already_recorded' then raise; end if; end;
  -- Un turno cancelado no se cobra desde acá.
  begin perform public.record_offline_payment((select appointment_id from h24_ids where tag='manual_cancelled'),'cash'); raise exception 'cancelled_turn_charged';
  exception when others then if sqlerrm <> 'appointment_not_active' then raise; end if; end;
end $$;
reset role;

-- Como owner del otro workspace: ve su paciente con su turno pendiente y nada del primero.
select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.patient_follow_up_opportunities) <> 1 then raise exception 'other_owner_sees_wrong_rows'; end if;
  if (select pending_payment_count from public.patient_follow_up_opportunities where id='fb000000-0000-4000-8000-0000000000d8') <> 1 then raise exception 'other_workspace_pending_wrong'; end if;
  begin perform public.record_offline_payment((select appointment_id from h24_ids where tag='both_public'),'cash'); raise exception 'unknown_appointment_charged';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin perform public.record_offline_payment((select appointment_id from h24_ids where tag='manual_completed'),'cash'); raise exception 'foreign_owner_charged';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
select count(*) as patients_with_pending_payment from public.patient_follow_up_opportunities
where workspace_id in ('fb000000-0000-4000-8000-0000000000a1','fb000000-0000-4000-8000-0000000000a2') and has_pending_payment;
rollback;
