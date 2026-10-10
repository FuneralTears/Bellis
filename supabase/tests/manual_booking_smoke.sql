-- H2.2 turnos manuales y cobros fuera de Bellis: permisos, disponibilidad real, datos, pagos y efectos.
-- Datos sintéticos; todo se revierte.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f9000000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h22-booking-' || n || '@example.invalid','',now(),'{}','{}',now(),now()
from generate_series(1,6) n;
insert into public.workspaces(id,name,slug,payment_provider) values
  ('f9000000-0000-4000-8000-0000000000a1','Manual booking smoke','manual-booking-smoke','external_link'),
  ('f9000000-0000-4000-8000-0000000000a2','Manual booking smoke B','manual-booking-smoke-b','external_link');
-- 1 owner, 2 admin, 3 recepción, 4 profesional A, 5 profesional B, 6 owner y profesional del otro workspace.
insert into public.workspace_members(workspace_id,user_id,role) values
  ('f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-000000000001','owner'),
  ('f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-000000000002','admin'),
  ('f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-000000000003','reception'),
  ('f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-000000000004','professional'),
  ('f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-000000000005','professional'),
  ('f9000000-0000-4000-8000-0000000000a2','f9000000-0000-4000-8000-000000000006','owner');
-- A: cada 30 (default), descanso de 15. B: cada 60, sin descanso, máximo 2 por día. C: el del otro workspace.
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug) values
  ('f9000000-0000-4000-8000-0000000000b1','f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-000000000004','Smoke A','Psicología','manual-booking-a'),
  ('f9000000-0000-4000-8000-0000000000b2','f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-000000000005','Smoke B','Psicología','manual-booking-b'),
  ('f9000000-0000-4000-8000-0000000000b3','f9000000-0000-4000-8000-0000000000a2','f9000000-0000-4000-8000-000000000006','Smoke C','Psicología','manual-booking-c');
update public.professionals set slot_interval_minutes=60,max_appointments_per_day=2 where id='f9000000-0000-4000-8000-0000000000b2';
-- El servicio de A pide 30 días de anticipación: un paciente no podría reservar a 7 días; el consultorio sí.
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes,active) values
  ('f9000000-0000-4000-8000-0000000000c1','f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-0000000000b1','Consulta A',2500000,60,'online',43200,true),
  ('f9000000-0000-4000-8000-0000000000c2','f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-0000000000b2','Consulta B',3000000,60,'online',0,true),
  ('f9000000-0000-4000-8000-0000000000c3','f9000000-0000-4000-8000-0000000000a2','f9000000-0000-4000-8000-0000000000b3','Consulta C',2500000,60,'online',0,true),
  ('f9000000-0000-4000-8000-0000000000c4','f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-0000000000b1','Consulta A inactiva',2500000,60,'online',0,false);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select workspace,professional,day,'09:00','13:00',buffer
from (values('f9000000-0000-4000-8000-0000000000a1'::uuid,'f9000000-0000-4000-8000-0000000000b1'::uuid,15),
  ('f9000000-0000-4000-8000-0000000000a1','f9000000-0000-4000-8000-0000000000b2',0),
  ('f9000000-0000-4000-8000-0000000000a2','f9000000-0000-4000-8000-0000000000b3',0)) as t(workspace,professional,buffer), generate_series(0,6) day;
-- p1 a p3 del workspace de prueba, p4 eliminado, p5 del otro workspace.
insert into public.patients(id,workspace_id,first_name,last_name,email,phone,deleted_at) values
  ('f9000000-0000-4000-8000-0000000000d1','f9000000-0000-4000-8000-0000000000a1','Prueba','Uno','h22-p1@example.invalid','+5491155552201',null),
  ('f9000000-0000-4000-8000-0000000000d2','f9000000-0000-4000-8000-0000000000a1','Prueba','Dos',null,'+5491155552202',null),
  ('f9000000-0000-4000-8000-0000000000d3','f9000000-0000-4000-8000-0000000000a1','Prueba','Tres','h22-p3@example.invalid','+5491155552203',null),
  ('f9000000-0000-4000-8000-0000000000d4','f9000000-0000-4000-8000-0000000000a1','Prueba','Eliminado','h22-p4@example.invalid','+5491155552204',now()),
  ('f9000000-0000-4000-8000-0000000000d5','f9000000-0000-4000-8000-0000000000a2','Prueba','Ajeno','h22-p5@example.invalid','+5491155552205',null);

-- d es un día local a 7 días. d+2 está bloqueado entero para A.
create temp table mb as
select 'America/Argentina/Buenos_Aires'::text tz,(now() at time zone 'America/Argentina/Buenos_Aires')::date + 7 as d,
  'f9000000-0000-4000-8000-0000000000a1'::uuid w1,'f9000000-0000-4000-8000-0000000000a2'::uuid w2,
  'f9000000-0000-4000-8000-000000000001'::uuid owner_id,'f9000000-0000-4000-8000-000000000002'::uuid admin_id,
  'f9000000-0000-4000-8000-000000000003'::uuid reception_id,'f9000000-0000-4000-8000-000000000004'::uuid pro_a_user,
  'f9000000-0000-4000-8000-000000000005'::uuid pro_b_user,'f9000000-0000-4000-8000-000000000006'::uuid other_id,
  'f9000000-0000-4000-8000-0000000000b1'::uuid pro_a,'f9000000-0000-4000-8000-0000000000b2'::uuid pro_b,'f9000000-0000-4000-8000-0000000000b3'::uuid pro_c,
  'f9000000-0000-4000-8000-0000000000c1'::uuid svc_a,'f9000000-0000-4000-8000-0000000000c2'::uuid svc_b,'f9000000-0000-4000-8000-0000000000c3'::uuid svc_c,
  'f9000000-0000-4000-8000-0000000000c4'::uuid svc_inactive,
  'f9000000-0000-4000-8000-0000000000d1'::uuid p1,'f9000000-0000-4000-8000-0000000000d2'::uuid p2,'f9000000-0000-4000-8000-0000000000d3'::uuid p3,
  'f9000000-0000-4000-8000-0000000000d4'::uuid p_deleted,'f9000000-0000-4000-8000-0000000000d5'::uuid p_other;
grant select on mb to authenticated,anon;
create temp table mb_ids(tag text primary key,id uuid not null);
grant select,insert on mb_ids to authenticated;
insert into public.availability_blocks(workspace_id,professional_id,starts_at,ends_at,reason)
select w1,pro_a,(d + 2)::timestamp at time zone tz,(d + 3)::timestamp at time zone tz,'Smoke' from mb;
-- Un turno del booking público, pago por link externo, en la agenda de A (d+4, 09:00): para comparar con los manuales.
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes)
select 'f9000000-0000-4000-8000-0000000000e1',w1,pro_a,svc_a,p3,'scheduled',2500000,'ARS',60 from mb;
insert into public.payments(workspace_id,booking_intent_id,provider,provider_order_id,amount_minor,currency_code,status,approved_at)
select w1,'f9000000-0000-4000-8000-0000000000e1','external_link','f9000000-0000-4000-8000-0000000000e1',2500000,'ARS','approved',now() from mb;
insert into public.appointments(id,workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
select 'f9000000-0000-4000-8000-0000000000e2',w1,'f9000000-0000-4000-8000-0000000000e1',pro_a,p3,
  (d + 4 + time '09:00') at time zone tz,(d + 4 + time '10:00') at time zone tz from mb;

do $$ declare f record; v text; begin
  select * into f from mb;
  -- Esquema: lo nuevo existe y lo anterior quedó como estaba.
  if (select column_default||'/'||is_nullable from information_schema.columns where table_schema='public' and table_name='booking_intents' and column_name='source') <> '''public''::text/NO'
    then raise exception 'source_column_wrong'; end if;
  if (select source from public.booking_intents where id='f9000000-0000-4000-8000-0000000000e1') <> 'public' then raise exception 'public_intent_not_public'; end if;
  if (select is_nullable from information_schema.columns where table_schema='public' and table_name='appointments' and column_name='booking_intent_id') <> 'NO'
    then raise exception 'appointment_without_intent_allowed'; end if;
  -- Nada de esto se puede llamar sin sesión, y los helpers internos no son llamables desde la API.
  foreach v in array array['public.create_manual_appointment(uuid,uuid,uuid,timestamptz,text,integer)','public.record_offline_payment(uuid,text,integer)',
    'public.manual_available_slots(uuid,uuid,date)','private.create_manual_appointment(uuid,uuid,uuid,timestamptz,text,integer)',
    'private.record_offline_payment(uuid,text,integer)','private.manual_available_slots(uuid,uuid,date)',
    'private.professional_free_slots(uuid,uuid,date,integer,integer)','private.insert_offline_payment(uuid,uuid,text,integer,character,uuid)',
    'private.manual_booking_workspace(uuid)'] loop
    if has_function_privilege('anon',v,'execute') then raise exception 'anon_can_execute: %', v; end if;
  end loop;
  foreach v in array array['private.professional_free_slots(uuid,uuid,date,integer,integer)','private.insert_offline_payment(uuid,uuid,text,integer,character,uuid)',
    'private.manual_booking_workspace(uuid)'] loop
    if has_function_privilege('authenticated',v,'execute') then raise exception 'authenticated_can_execute_helper: %', v; end if;
  end loop;
  if has_table_privilege('authenticated','public.appointments','insert') or has_table_privilege('authenticated','public.payments','insert')
    or has_table_privilege('authenticated','public.booking_intents','insert') then raise exception 'direct_insert_allowed'; end if;
  -- La anticipación mínima es una regla para pacientes: con los 30 días del servicio no hay horarios; sin ella, sí.
  if exists(select 1 from private.professional_free_slots(f.w1,f.pro_a,f.d,60,43200)) then raise exception 'notice_ignored_by_helper'; end if;
  if (select string_agg(to_char(s.starts_at at time zone f.tz,'HH24:MI'),',' order by s.starts_at) from private.professional_free_slots(f.w1,f.pro_a,f.d,60,0) s)
    is distinct from '09:00,09:30,10:00,10:30,11:00,11:30,12:00' then raise exception 'helper_slots_wrong'; end if;
end $$;

-- Sin usuario no hay turno ni cobro.
select set_config('request.jwt.claim.sub','',true);
set local role authenticated;
do $$ declare f record; begin
  select * into f from mb;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + time '09:00') at time zone f.tz); raise exception 'created_without_user';
  exception when others then if sqlerrm <> 'authentication_required' then raise; end if; end;
  begin perform public.record_offline_payment('f9000000-0000-4000-8000-0000000000e2','cash'); raise exception 'paid_without_user';
  exception when others then if sqlerrm <> 'authentication_required' then raise; end if; end;
  begin perform 1 from public.manual_available_slots(f.pro_a,f.svc_a,f.d); raise exception 'slots_without_user';
  exception when others then if sqlerrm <> 'authentication_required' then raise; end if; end;
end $$;
reset role;

-- Owner: horarios, rechazos y un turno con pago pendiente (A, d 09:00, p1).
select set_config('request.jwt.claim.sub',owner_id::text,true) from mb;
set local role authenticated;
do $$ declare f record; v_slots text; v_id uuid; begin
  select * into f from mb;
  -- Frecuencia de A (cada 30) y sin la anticipación de 30 días del servicio.
  select string_agg(to_char(s.starts_at at time zone f.tz,'HH24:MI'),',' order by s.starts_at) into v_slots from public.manual_available_slots(f.pro_a,f.svc_a,f.d) s;
  if v_slots is distinct from '09:00,09:30,10:00,10:30,11:00,11:30,12:00' then raise exception 'manual_slots_a: %', v_slots; end if;
  -- Frecuencia de B (cada 60).
  select string_agg(to_char(s.starts_at at time zone f.tz,'HH24:MI'),',' order by s.starts_at) into v_slots from public.manual_available_slots(f.pro_b,f.svc_b,f.d) s;
  if v_slots is distinct from '09:00,10:00,11:00,12:00' then raise exception 'manual_slots_b: %', v_slots; end if;
  -- Día bloqueado: nada.
  if exists(select 1 from public.manual_available_slots(f.pro_a,f.svc_a,f.d + 2)) then raise exception 'blocked_day_offered'; end if;
  begin perform 1 from public.manual_available_slots(f.pro_a,f.svc_b,f.d); raise exception 'service_of_other_professional_accepted';
  exception when others then if sqlerrm <> 'invalid_service' then raise; end if; end;

  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,now() - interval '1 hour'); raise exception 'past_slot_booked';
  exception when others then if sqlerrm <> 'slot_in_past' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + time '14:00') at time zone f.tz); raise exception 'outside_hours_booked';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + time '09:15') at time zone f.tz); raise exception 'off_grid_booked';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + 2 + time '09:00') at time zone f.tz); raise exception 'blocked_day_booked';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p_deleted,f.svc_a,(f.d + time '09:00') at time zone f.tz); raise exception 'deleted_patient_booked';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p_other,f.svc_a,(f.d + time '09:00') at time zone f.tz); raise exception 'foreign_patient_booked';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_inactive,(f.d + time '09:00') at time zone f.tz); raise exception 'inactive_service_booked';
  exception when others then if sqlerrm <> 'invalid_service' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_b,(f.d + time '09:00') at time zone f.tz); raise exception 'service_of_other_professional_booked';
  exception when others then if sqlerrm <> 'invalid_service' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + time '09:00') at time zone f.tz,'mercado_pago'); raise exception 'unknown_method_accepted';
  exception when others then if sqlerrm <> 'invalid_payment' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + time '09:00') at time zone f.tz,'cash',0); raise exception 'zero_amount_accepted';
  exception when others then if sqlerrm <> 'invalid_payment' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + time '09:00') at time zone f.tz,null,2500000); raise exception 'amount_without_method_accepted';
  exception when others then if sqlerrm <> 'invalid_payment' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_c,f.p1,f.svc_a,(f.d + time '09:00') at time zone f.tz); raise exception 'booked_in_foreign_workspace';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;

  v_id := public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + time '09:00') at time zone f.tz);
  insert into mb_ids values('owner_pending',v_id);
  -- El mismo horario, y los que tocan el turno o su descanso de 15 minutos, ya no se pueden usar.
  begin perform public.create_manual_appointment(f.pro_a,f.p2,f.svc_a,(f.d + time '09:00') at time zone f.tz); raise exception 'double_booked';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p2,f.svc_a,(f.d + time '09:30') at time zone f.tz); raise exception 'overlap_booked';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_a,f.p2,f.svc_a,(f.d + time '10:00') at time zone f.tz); raise exception 'buffer_ignored';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  select string_agg(to_char(s.starts_at at time zone f.tz,'HH24:MI'),',' order by s.starts_at) into v_slots from public.manual_available_slots(f.pro_a,f.svc_a,f.d) s;
  if v_slots is distinct from '10:30,11:00,11:30,12:00' then raise exception 'slots_after_first: %', v_slots; end if;
end $$;
reset role;
-- La reserva tomó el candado de ese profesional y ese día local, el mismo que usa la reserva pública,
-- y la restricción que impide dos turnos superpuestos sigue en la tabla.
do $$ declare f record; v_key bigint; begin
  select * into f from mb;
  v_key := pg_catalog.hashtextextended('bellis:schedule:' || f.pro_a::text || ':' || to_char(f.d,'YYYY-MM-DD'),0);
  if not exists(select 1 from pg_catalog.pg_locks l where l.locktype='advisory' and l.pid=pg_catalog.pg_backend_pid()
    and l.granted and l.objsubid=1 and ((l.classid::bigint << 32) | l.objid::bigint) = v_key) then raise exception 'schedule_lock_not_held'; end if;
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.appointments'::regclass and conname='appointments_no_overlap' and contype='x')
    then raise exception 'overlap_constraint_missing'; end if;
end $$;

-- Admin: efectivo, importe del servicio (A, d 10:30, p2).
select set_config('request.jwt.claim.sub',admin_id::text,true) from mb;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from mb;
  v_id := public.create_manual_appointment(f.pro_a,f.p2,f.svc_a,(f.d + time '10:30') at time zone f.tz,'cash');
  insert into mb_ids values('admin_cash',v_id);
end $$;
reset role;

-- Recepción: transferencia con otro importe, en la agenda de B (d 09:00, p3).
select set_config('request.jwt.claim.sub',reception_id::text,true) from mb;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from mb;
  v_id := public.create_manual_appointment(f.pro_b,f.p3,f.svc_b,(f.d + time '09:00') at time zone f.tz,'transfer',2000000);
  insert into mb_ids values('reception_transfer',v_id);
end $$;
reset role;

-- Profesional A: su agenda y sus pacientes, nada más.
select set_config('request.jwt.claim.sub',pro_a_user::text,true) from mb;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from mb;
  -- p1 ya tiene un turno con A; p3 también (el del booking público).
  v_id := public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + 1 + time '09:00') at time zone f.tz,'other',1000000);
  insert into mb_ids values('professional_other',v_id);
  begin perform public.create_manual_appointment(f.pro_b,f.p1,f.svc_b,(f.d + 1 + time '09:00') at time zone f.tz); raise exception 'professional_booked_other_agenda';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin perform 1 from public.manual_available_slots(f.pro_b,f.svc_b,f.d); raise exception 'professional_read_other_agenda';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  -- No puede cobrar un turno de la agenda de B.
  begin perform public.record_offline_payment((select id from mb_ids where tag='reception_transfer'),'cash'); raise exception 'professional_paid_other_agenda';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
end $$;
reset role;
-- Un paciente del workspace que A no cargó y con el que no tiene ninguna solicitud.
insert into public.patients(id,workspace_id,first_name,last_name,email,phone)
select 'f9000000-0000-4000-8000-0000000000d6',w1,'Prueba','Sin relación','h22-p6@example.invalid','+5491155552206' from mb;
select set_config('request.jwt.claim.sub',pro_a_user::text,true) from mb;
set local role authenticated;
do $$ declare f record; begin
  select * into f from mb;
  begin perform public.create_manual_appointment(f.pro_a,'f9000000-0000-4000-8000-0000000000d6',f.svc_a,(f.d + 1 + time '11:00') at time zone f.tz); raise exception 'professional_used_unrelated_patient';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
end $$;
reset role;

-- Máximo diario de B (2): recepción cargó uno; owner carga el segundo y el tercero ya no entra. El día siguiente sigue abierto.
select set_config('request.jwt.claim.sub',owner_id::text,true) from mb;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from mb;
  v_id := public.create_manual_appointment(f.pro_b,f.p1,f.svc_b,(f.d + time '10:00') at time zone f.tz);
  insert into mb_ids values('owner_second_b',v_id);
  begin perform public.create_manual_appointment(f.pro_b,f.p2,f.svc_b,(f.d + time '11:00') at time zone f.tz); raise exception 'booked_over_daily_maximum';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  if exists(select 1 from public.manual_available_slots(f.pro_b,f.svc_b,f.d)) then raise exception 'full_day_still_offered'; end if;
  if (select count(*) from public.manual_available_slots(f.pro_b,f.svc_b,f.d + 1)) <> 4 then raise exception 'next_day_closed'; end if;
  -- El turno del booking público ocupa su lugar igual que uno manual: A, d+4, 09:00.
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + 4 + time '09:00') at time zone f.tz); raise exception 'booked_over_public_appointment';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;

  -- Cobro posterior del turno pendiente del owner: efectivo, con otro importe. Una sola vez.
  v_id := public.record_offline_payment((select id from mb_ids where tag='owner_pending'),'cash',1500000);
  insert into mb_ids values('owner_late_payment',v_id);
  begin perform public.record_offline_payment((select id from mb_ids where tag='owner_pending'),'transfer'); raise exception 'paid_twice';
  exception when others then if sqlerrm <> 'payment_already_recorded' then raise; end if; end;
  begin perform public.record_offline_payment((select id from mb_ids where tag='owner_second_b'),'bitcoin'); raise exception 'unknown_method_recorded';
  exception when others then if sqlerrm <> 'invalid_payment' then raise; end if; end;
  begin perform public.record_offline_payment((select id from mb_ids where tag='owner_second_b'),'cash',-5); raise exception 'negative_amount_recorded';
  exception when others then if sqlerrm <> 'invalid_payment' then raise; end if; end;
  -- Un turno del booking público no se cobra desde acá.
  begin perform public.record_offline_payment('f9000000-0000-4000-8000-0000000000e2','cash'); raise exception 'public_appointment_paid_offline';
  exception when others then if sqlerrm <> 'not_manual_appointment' then raise; end if; end;
  -- Mercado Pago y el link externo no reconocen una solicitud manual.
  begin perform public.confirm_external_payment((select booking_intent_id from public.appointments where id=(select id from mb_ids where tag='owner_second_b')),'REF-1234'); raise exception 'manual_intent_confirmed_as_external';
  exception when others then if sqlerrm <> 'intent_not_pending' then raise; end if; end;
end $$;
reset role;

-- Otro workspace: ni agenda, ni horarios, ni cobros del primero. En el suyo sí puede.
select set_config('request.jwt.claim.sub',other_id::text,true) from mb;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from mb;
  begin perform public.create_manual_appointment(f.pro_a,f.p1,f.svc_a,(f.d + 3 + time '09:00') at time zone f.tz); raise exception 'foreign_owner_booked';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin perform 1 from public.manual_available_slots(f.pro_a,f.svc_a,f.d); raise exception 'foreign_owner_read_slots';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin perform public.record_offline_payment((select id from mb_ids where tag='owner_second_b'),'cash'); raise exception 'foreign_owner_paid';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_c,f.p1,f.svc_c,(f.d + time '09:00') at time zone f.tz); raise exception 'foreign_patient_used';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
  begin perform public.create_manual_appointment(f.pro_c,f.p_other,f.svc_a,(f.d + time '09:00') at time zone f.tz); raise exception 'foreign_service_used';
  exception when others then if sqlerrm <> 'invalid_service' then raise; end if; end;
  if exists(select 1 from public.appointments where workspace_id=f.w1) or exists(select 1 from public.payments where workspace_id=f.w1)
    or exists(select 1 from public.booking_intents where workspace_id=f.w1) then raise exception 'foreign_owner_reads_first_workspace'; end if;
  v_id := public.create_manual_appointment(f.pro_c,f.p_other,f.svc_c,(f.d + time '09:00') at time zone f.tz,'cash');
  if (select workspace_id from public.appointments where id=v_id) <> f.w2 then raise exception 'appointment_in_wrong_workspace'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);

-- Datos, pagos y efectos, vistos desde el servidor.
do $$ declare f record; a public.appointments%rowtype; i public.booking_intents%rowtype; p public.payments%rowtype; begin
  select * into f from mb;
  -- Turno pendiente del owner: solicitud manual, sin token, con los datos del servicio.
  select * into a from public.appointments where id=(select id from mb_ids where tag='owner_pending');
  select * into i from public.booking_intents where id=a.booking_intent_id;
  if i.source <> 'manual' or i.created_by <> f.owner_id or i.status <> 'scheduled' or i.workspace_id <> f.w1 or i.professional_id <> f.pro_a
    or i.service_id <> f.svc_a or i.patient_id <> f.p1 or i.price_minor <> 2500000 or i.currency_code <> 'ARS' or i.duration_minutes <> 60
    or i.access_token_hash is not null or i.resume_token_hash is not null then raise exception 'manual_intent_wrong: %', row_to_json(i); end if;
  if a.workspace_id <> f.w1 or a.professional_id <> f.pro_a or a.patient_id <> f.p1 or a.status <> 'scheduled'
    or a.starts_at <> (f.d + time '09:00') at time zone f.tz or a.ends_at - a.starts_at <> interval '60 minutes' then raise exception 'manual_appointment_wrong: %', row_to_json(a); end if;
  -- Una solicitud manual no puede recibir un token público.
  begin update public.booking_intents set access_token_hash=repeat('a',64) where id=i.id; raise exception 'manual_intent_got_token';
  exception when check_violation then null; end;
  begin update public.booking_intents set resume_token_hash=repeat('b',64) where id=i.id; raise exception 'manual_intent_got_resume_token';
  exception when check_violation then null; end;
  begin update public.booking_intents set source='otro' where id=i.id; raise exception 'unknown_source_accepted';
  exception when check_violation then null; end;

  -- Se cobró después: efectivo, importe distinto al del servicio, registrado por el owner.
  select * into p from public.payments where booking_intent_id=i.id;
  if p.id <> (select id from mb_ids where tag='owner_late_payment') or p.provider <> 'offline' or p.method <> 'cash' or p.status <> 'approved'
    or p.amount_minor <> 1500000 or p.currency_code <> 'ARS' or p.approved_at is null or p.recorded_by <> f.owner_id or p.workspace_id <> f.w1
    or p.provider_order_id is not null or p.provider_payment_id is not null or p.provider_event_id is not null or p.checkout_url is not null or p.manual_reference is not null
    then raise exception 'late_offline_payment_wrong: %', row_to_json(p); end if;
  -- Admin, efectivo: el importe del servicio.
  select pm.* into p from public.payments pm join public.appointments ap on ap.booking_intent_id=pm.booking_intent_id where ap.id=(select id from mb_ids where tag='admin_cash');
  if p.provider <> 'offline' or p.method <> 'cash' or p.amount_minor <> 2500000 or p.status <> 'approved' or p.recorded_by <> f.admin_id then raise exception 'cash_payment_wrong: %', row_to_json(p); end if;
  -- Recepción, transferencia: importe editado, distinto del precio del servicio (30.000).
  select pm.* into p from public.payments pm join public.appointments ap on ap.booking_intent_id=pm.booking_intent_id where ap.id=(select id from mb_ids where tag='reception_transfer');
  if p.provider <> 'offline' or p.method <> 'transfer' or p.amount_minor <> 2000000 or p.recorded_by <> f.reception_id then raise exception 'transfer_payment_wrong: %', row_to_json(p); end if;
  if (select price_minor from public.booking_intents where id=p.booking_intent_id) <> 3000000 then raise exception 'intent_price_overwritten'; end if;
  -- Profesional, otro medio.
  select pm.* into p from public.payments pm join public.appointments ap on ap.booking_intent_id=pm.booking_intent_id where ap.id=(select id from mb_ids where tag='professional_other');
  if p.provider <> 'offline' or p.method <> 'other' or p.amount_minor <> 1000000 or p.recorded_by <> f.pro_a_user then raise exception 'other_payment_wrong: %', row_to_json(p); end if;
  if (select created_by from public.booking_intents where id=p.booking_intent_id) <> f.pro_a_user then raise exception 'professional_creator_wrong'; end if;
  -- Pendiente = sin fila de pago: no se inventa un proveedor para un cobro que no ocurrió.
  if exists(select 1 from public.payments pm join public.appointments ap on ap.booking_intent_id=pm.booking_intent_id where ap.id=(select id from mb_ids where tag='owner_second_b'))
    then raise exception 'pending_has_payment_row'; end if;
  if exists(select 1 from public.payments where workspace_id in (f.w1,f.w2) and status='pending') then raise exception 'pending_payment_row_created'; end if;

  -- Un cobro offline no puede parecerse a uno de Mercado Pago, ni al revés.
  begin update public.payments set provider_payment_id='123456' where id=p.id; raise exception 'offline_got_provider_payment_id';
  exception when check_violation then null; end;
  begin update public.payments set provider='mercado_pago_ar' where id=p.id; raise exception 'offline_became_mercado_pago';
  exception when check_violation then null; end;
  begin update public.payments set method=null where id=p.id; raise exception 'offline_without_method';
  exception when check_violation then null; end;
  begin update public.payments set method='cash' where booking_intent_id='f9000000-0000-4000-8000-0000000000e1'; raise exception 'external_link_got_method';
  exception when check_violation then null; end;
  begin update public.payments set method='bitcoin' where id=p.id; raise exception 'unknown_method_stored';
  exception when check_violation then null; end;
  -- La función de Mercado Pago no reconoce un cobro offline ni una solicitud manual sin pago.
  begin perform public.record_mercado_pago_payment(p.booking_intent_id,'pref-h22','990001','ev-h22-1','approved',1000000,'ARS'); raise exception 'mercado_pago_touched_offline';
  exception when others then if sqlerrm <> 'payment_mismatch' then raise; end if; end;
  begin perform public.record_mercado_pago_payment((select booking_intent_id from public.appointments where id=(select id from mb_ids where tag='owner_second_b')),
    'pref-h22','990002','ev-h22-2','approved',3000000,'ARS'); raise exception 'mercado_pago_touched_manual_pending';
  exception when others then if sqlerrm <> 'payment_mismatch' then raise; end if; end;
  if public.cancel_unpaid_intent(p.booking_intent_id) then raise exception 'manual_intent_cancelled_as_unpaid'; end if;

  -- Efectos: 5 turnos manuales en el primer workspace y 1 en el otro; ninguno es público.
  if (select count(*) from public.appointments ap join public.booking_intents bi on bi.id=ap.booking_intent_id where bi.source='manual' and ap.workspace_id=f.w1) <> 5
    or (select count(*) from public.appointments ap join public.booking_intents bi on bi.id=ap.booking_intent_id where bi.source='manual' and ap.workspace_id=f.w2) <> 1
    or (select count(*) from public.booking_intents where workspace_id in (f.w1,f.w2) and source='manual') <> 6
    or (select count(*) from public.booking_intents where workspace_id in (f.w1,f.w2) and source='public') <> 1 then raise exception 'manual_counts_wrong'; end if;
  -- Los rechazos no dejaron solicitudes sueltas: cada solicitud manual tiene su turno.
  if exists(select 1 from public.booking_intents bi where bi.workspace_id in (f.w1,f.w2) and bi.source='manual'
    and not exists(select 1 from public.appointments ap where ap.booking_intent_id=bi.id)) then raise exception 'manual_intent_without_appointment'; end if;
  -- Auditoría: un alta por turno y un cobro por pago, siempre con actor.
  if (select count(*) from public.audit_events where action='manual_appointment_created' and object_type='appointment' and workspace_id=f.w1) <> 5
    or (select count(*) from public.audit_events where action='offline_payment_recorded' and object_type='payment' and workspace_id=f.w1) <> 4
    or exists(select 1 from public.audit_events where workspace_id in (f.w1,f.w2) and action in ('manual_appointment_created','offline_payment_recorded') and actor_user_id is null)
    then raise exception 'audit_wrong'; end if;
  if not exists(select 1 from public.audit_events where action='manual_appointment_created' and actor_user_id=f.reception_id
      and object_id=(select id from mb_ids where tag='reception_transfer'))
    or not exists(select 1 from public.audit_events where action='offline_payment_recorded' and actor_user_id=f.owner_id
      and object_id=(select id from mb_ids where tag='owner_late_payment')) then raise exception 'audit_actor_wrong'; end if;
  -- El turno manual no usa el evento del booking público.
  if exists(select 1 from public.audit_events where action='appointment_scheduled' and workspace_id in (f.w1,f.w2)) then raise exception 'public_audit_event_used'; end if;
  -- Sin emails y sin automatizaciones de pago pendiente.
  if exists(select 1 from public.notification_outbox where workspace_id in (f.w1,f.w2)) then raise exception 'notification_enqueued'; end if;
  if exists(select 1 from public.automation_runs where workspace_id in (f.w1,f.w2)) then raise exception 'automation_enqueued'; end if;
end $$;

-- La tarea de vencimiento no toca solicitudes manuales, aunque su fecha ya haya pasado.
update public.booking_intents set expires_at=now() - interval '1 hour' where source='manual' and workspace_id in (select w1 from mb union all select w2 from mb);
select public.expire_stale_booking_intents();
do $$ declare f record; begin
  select * into f from mb;
  if exists(select 1 from public.booking_intents where workspace_id in (f.w1,f.w2) and source='manual' and status <> 'scheduled') then raise exception 'manual_intent_expired'; end if;
  if exists(select 1 from public.payments where workspace_id in (f.w1,f.w2) and provider='offline' and status <> 'approved') then raise exception 'offline_payment_expired'; end if;
  if exists(select 1 from public.appointments where workspace_id in (f.w1,f.w2) and status <> 'scheduled') then raise exception 'manual_appointment_changed'; end if;
  if exists(select 1 from public.audit_events where action='booking_intent_expired' and workspace_id in (f.w1,f.w2)) then raise exception 'manual_intent_logged_as_expired'; end if;
end $$;
select count(*) as manual_appointments from public.appointments a join public.booking_intents i on i.id=a.booking_intent_id
where i.source='manual' and a.workspace_id in (select w1 from mb union all select w2 from mb);
rollback;
