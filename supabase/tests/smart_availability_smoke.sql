-- Run only on Staging or a local database. Synthetic records are rolled back.
-- H1.5: offered start times follow professionals.slot_interval_minutes, an optional daily maximum closes the day,
-- and neither changes the real duration, the buffer, the payment gate or the time zone.
-- Case H (professionals that existed before the migration keep 15) cannot be reproduced after the fact: check it
-- right after applying the migration with
--   select slot_interval_minutes,count(*) from public.professionals group by 1;   -- every row must be 15
begin;
insert into public.workspaces(id,name,slug,payment_provider)
values('f8000000-0000-4000-8000-000000000001','Availability smoke','availability-smoke','external_link');
-- No slot_interval_minutes here: these rows take the default, like any professional created from now on.
insert into public.professionals(id,workspace_id,display_name,specialty,public_slug)
select ('f8000000-0000-4000-8000-0000000000a' || n)::uuid,'f8000000-0000-4000-8000-000000000001',
  'Smoke ' || code,'Psicología','availability-smoke-' || lower(code)
from (values(1,'A'),(2,'B'),(3,'C'),(4,'D'),(5,'F'),(6,'M')) as t(n,code);
do $$
begin
  -- I. A new professional gets 30 and no daily maximum.
  if exists(select 1 from public.professionals where workspace_id='f8000000-0000-4000-8000-000000000001'
    and (slot_interval_minutes<>30 or max_appointments_per_day is not null))
    then raise exception 'new_professional_default_wrong'; end if;
  -- H, as far as it can be seen from here: the column is required and its default is 30, not 15.
  if (select column_default||'/'||is_nullable from information_schema.columns where table_schema='public'
    and table_name='professionals' and column_name='slot_interval_minutes') <> '30/NO'
    then raise exception 'slot_interval_column_wrong'; end if;
end $$;
do $$
declare v integer;
begin
  -- J. Only 15, 30 and 60 are frequencies.
  foreach v in array array[0,10,20,45,120,-15] loop
    begin
      update public.professionals set slot_interval_minutes=v where id='f8000000-0000-4000-8000-0000000000a1';
      raise exception 'slot_interval_accepted: %', v;
    exception when check_violation then null; end;
  end loop;
  begin
    update public.professionals set slot_interval_minutes=null where id='f8000000-0000-4000-8000-0000000000a1';
    raise exception 'slot_interval_null_accepted';
  exception when not_null_violation then null; end;
  -- K. The daily maximum is empty or between 1 and 50.
  foreach v in array array[0,-1,51,1000] loop
    begin
      update public.professionals set max_appointments_per_day=v where id='f8000000-0000-4000-8000-0000000000a1';
      raise exception 'max_appointments_accepted: %', v;
    exception when check_violation then null; end;
  end loop;
  update public.professionals set max_appointments_per_day=1 where id='f8000000-0000-4000-8000-0000000000a1';
  update public.professionals set max_appointments_per_day=50 where id='f8000000-0000-4000-8000-0000000000a1';
  update public.professionals set max_appointments_per_day=null where id='f8000000-0000-4000-8000-0000000000a1';
end $$;
-- A: 60/15/30 (default)  B: 45/15/30  C: 60/0/60  D: 30/15/15  F: daily maximum  M: time zone and day boundary.
update public.professionals set slot_interval_minutes=60 where id in ('f8000000-0000-4000-8000-0000000000a3','f8000000-0000-4000-8000-0000000000a6');
update public.professionals set slot_interval_minutes=15 where id='f8000000-0000-4000-8000-0000000000a4';
update public.professionals set max_appointments_per_day=2 where id='f8000000-0000-4000-8000-0000000000a5';
update public.professionals set max_appointments_per_day=1 where id='f8000000-0000-4000-8000-0000000000a6';
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select ('f8000000-0000-4000-8000-0000000000b' || n)::uuid,'f8000000-0000-4000-8000-000000000001',
  ('f8000000-0000-4000-8000-0000000000a' || n)::uuid,'Consulta',2500000,duration,'online',0
from (values(1,60),(2,45),(3,60),(4,30),(5,60),(6,60)) as t(n,duration);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'f8000000-0000-4000-8000-000000000001',('f8000000-0000-4000-8000-0000000000a' || n)::uuid,day,'09:00','13:00',buffer
from (values(1,15),(2,15),(3,0),(4,15),(5,0),(6,0)) as t(n,buffer), generate_series(0,6) day;
-- One paid request per label, waiting for a time. The duration is the one the request was created with.
insert into public.patients(workspace_id,first_name,last_name,email)
select 'f8000000-0000-4000-8000-000000000001','Prueba',label,label || '@h15.invalid'
from unnest(array['a1','a2','ax','b1','b2','c1','c2','d1','f1','f2','f3','m1','m2']) label;
insert into public.booking_intents(workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes)
select p.workspace_id,s.professional_id,s.id,p.id,'awaiting_schedule',s.price_minor,s.currency_code,s.duration_minutes
from public.patients p join public.services s on s.workspace_id=p.workspace_id
  and s.id=('f8000000-0000-4000-8000-0000000000b' ||
    case left(p.last_name,1) when 'a' then 1 when 'b' then 2 when 'c' then 3 when 'd' then 4 when 'f' then 5 else 6 end)::uuid
where p.workspace_id='f8000000-0000-4000-8000-000000000001';
insert into public.payments(workspace_id,booking_intent_id,provider,provider_order_id,amount_minor,currency_code,status,approved_at)
select workspace_id,id,'external_link',id::text,price_minor,currency_code,'approved',now()
from public.booking_intents where workspace_id='f8000000-0000-4000-8000-000000000001';

set local role service_role;
do $$
declare
  tz constant text := 'America/Argentina/Buenos_Aires';
  d date := (now() at time zone 'America/Argentina/Buenos_Aires')::date + 7;
  a1 uuid; a2 uuid; ax uuid; b1 uuid; b2 uuid; c1 uuid; c2 uuid; d1 uuid; f1 uuid; f2 uuid; f3 uuid; m1 uuid; m2 uuid;
  v_slots text; v_count integer; v_first timestamptz; v_id uuid; v_key bigint;
begin
  select max(i.id::text) filter (where p.last_name='a1'),max(i.id::text) filter (where p.last_name='a2'),
    max(i.id::text) filter (where p.last_name='ax'),max(i.id::text) filter (where p.last_name='b1'),
    max(i.id::text) filter (where p.last_name='b2'),max(i.id::text) filter (where p.last_name='c1'),
    max(i.id::text) filter (where p.last_name='c2'),max(i.id::text) filter (where p.last_name='d1'),
    max(i.id::text) filter (where p.last_name='f1'),max(i.id::text) filter (where p.last_name='f2'),
    max(i.id::text) filter (where p.last_name='f3'),max(i.id::text) filter (where p.last_name='m1'),
    max(i.id::text) filter (where p.last_name='m2')
  into a1,a2,ax,b1,b2,c1,c2,d1,f1,f2,f3,m1,m2
  from public.booking_intents i join public.patients p on p.id=i.patient_id
  where i.workspace_id='f8000000-0000-4000-8000-000000000001';

  -- A. 60 minutes, 15 of buffer, every 30: starts every half hour, the last one still fits before 13:00.
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(a1,d) s;
  if v_slots is distinct from '09:00,09:30,10:00,10:30,11:00,11:30,12:00' then raise exception 'case_a: %', v_slots; end if;

  -- M. 09:00 is 09:00 in Buenos Aires, which is 12:00 UTC.
  select min(s.starts_at) into v_first from public.available_slots_for_intent(a1,d) s;
  if v_first is distinct from (d + time '09:00') at time zone tz or v_first <> (d + time '12:00') at time zone 'UTC'
    then raise exception 'case_m_timezone: %', v_first; end if;

  -- E. An existing 10:00–11:00 turn removes every start whose hour would touch it or its 15 minutes on each side,
  -- aligned to the grid or not: 09:00 would end at 10:00, inside the buffer, and 11:00 would start inside it.
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  select i.workspace_id,i.id,i.professional_id,i.patient_id,(d + time '10:00') at time zone tz,(d + time '11:00') at time zone tz
  from public.booking_intents i where i.id=ax;
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(a1,d) s;
  if v_slots is distinct from '11:30,12:00' then raise exception 'case_e: %', v_slots; end if;

  -- N. Booking still accepts only a start the server itself would offer.
  begin perform public.schedule_paid_intent(a1,(d + time '11:00') at time zone tz); raise exception 'case_n_buffer_ignored';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  -- 11:45 is free, but it is not a start this agenda offers.
  begin perform public.schedule_paid_intent(a1,(d + time '11:45') at time zone tz); raise exception 'case_n_off_grid_booked';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  v_id := public.schedule_paid_intent(a1,(d + time '11:30') at time zone tz);
  if (select ends_at-starts_at from public.appointments where id=v_id) <> interval '60 minutes'
    then raise exception 'case_n_duration_wrong'; end if;
  begin perform public.schedule_paid_intent(a2,(d + time '11:30') at time zone tz); raise exception 'case_n_double_booking';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  if exists(select 1 from public.available_slots_for_intent(a2,d)) then raise exception 'case_n_day_should_be_full'; end if;

  -- The booking took the lock of this professional and local day, and holds it until the transaction ends.
  v_key := pg_catalog.hashtextextended('bellis:schedule:f8000000-0000-4000-8000-0000000000a1:' || to_char(d,'YYYY-MM-DD'),0);
  if not exists(select 1 from pg_catalog.pg_locks l where l.locktype='advisory' and l.pid=pg_catalog.pg_backend_pid()
    and l.granted and l.objsubid=1 and ((l.classid::bigint << 32) | l.objid::bigint) = v_key)
    then raise exception 'schedule_lock_not_held'; end if;

  -- B. 45 minutes every 30: the frequency does not set the length of the turn.
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(b1,d) s;
  if v_slots is distinct from '09:00,09:30,10:00,10:30,11:00,11:30,12:00' then raise exception 'case_b: %', v_slots; end if;
  v_id := public.schedule_paid_intent(b1,(d + time '09:30') at time zone tz);
  if (select ends_at-starts_at from public.appointments where id=v_id) <> interval '45 minutes'
    then raise exception 'case_b_duration_wrong'; end if;
  -- 09:30–10:15 plus the buffer reaches 10:30, the first start left after it.
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(b2,d) s;
  if v_slots is distinct from '10:30,11:00,11:30,12:00' then raise exception 'case_b_after_booking: %', v_slots; end if;

  -- C. 60 minutes, no buffer, every 60: back to back, nothing in between.
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(c1,d) s;
  if v_slots is distinct from '09:00,10:00,11:00,12:00' then raise exception 'case_c: %', v_slots; end if;
  perform public.schedule_paid_intent(c1,(d + time '10:00') at time zone tz);
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(c2,d) s;
  if v_slots is distinct from '09:00,11:00,12:00' then raise exception 'case_c_after_booking: %', v_slots; end if;

  -- D. 30 minutes every 15: the grid a professional from before H1.5 keeps.
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at),count(*) into v_slots,v_count
  from public.available_slots_for_intent(d1,d) s;
  if v_count <> 15 or v_slots not like '09:00,09:15,09:30,%' or v_slots not like '%,12:15,12:30'
    then raise exception 'case_d: % (%)', v_slots, v_count; end if;
  perform public.schedule_paid_intent(d1,(d + time '09:15') at time zone tz);

  -- F. Daily maximum of 2: the day stays open with one turn and closes with the second.
  perform public.schedule_paid_intent(f1,(d + time '09:00') at time zone tz);
  if not exists(select 1 from public.available_slots_for_intent(f3,d)) then raise exception 'case_f_closed_too_early'; end if;
  perform public.schedule_paid_intent(f2,(d + time '11:00') at time zone tz);
  if exists(select 1 from public.available_slots_for_intent(f3,d)) then raise exception 'case_f_day_still_open'; end if;
  begin perform public.schedule_paid_intent(f3,(d + time '12:00') at time zone tz); raise exception 'case_f_booked_over_maximum';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  -- The maximum is per day: the next one is untouched.
  if not exists(select 1 from public.available_slots_for_intent(f3,d + 1)) then raise exception 'case_f_next_day_closed'; end if;

  -- L. A cancelled turn gives its place back and stops counting.
  update public.appointments set status='cancelled' where booking_intent_id=f2;
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(f3,d) s;
  if v_slots is distinct from '10:00,10:30,11:00,11:30,12:00' then raise exception 'case_l: %', v_slots; end if;
  -- A completed one still counts.
  update public.appointments set status='completed' where booking_intent_id=f1;
  update public.professionals set max_appointments_per_day=1 where id='f8000000-0000-4000-8000-0000000000a5';
  if exists(select 1 from public.available_slots_for_intent(f3,d)) then raise exception 'case_l_completed_not_counted'; end if;

  -- G. Without a maximum only the usual rules apply.
  update public.professionals set max_appointments_per_day=null where id='f8000000-0000-4000-8000-0000000000a5';
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(f3,d) s;
  if v_slots is distinct from '10:00,10:30,11:00,11:30,12:00' then raise exception 'case_g: %', v_slots; end if;

  -- M. The day that fills up is the local one. 22:00 in Buenos Aires is already tomorrow in UTC: it closes
  -- today's agenda and leaves tomorrow's open.
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  select i.workspace_id,i.id,i.professional_id,i.patient_id,(d + time '22:00') at time zone tz,(d + time '23:00') at time zone tz
  from public.booking_intents i where i.id=m1;
  if ((d + time '22:00') at time zone tz at time zone 'UTC')::date <> d + 1 then raise exception 'case_m_setup_wrong'; end if;
  if exists(select 1 from public.available_slots_for_intent(m2,d)) then raise exception 'case_m_local_day_not_closed'; end if;
  select string_agg(to_char(s.starts_at at time zone tz,'HH24:MI'),',' order by s.starts_at) into v_slots
  from public.available_slots_for_intent(m2,d + 1) s;
  if v_slots is distinct from '09:00,10:00,11:00,12:00' then raise exception 'case_m_next_day: %', v_slots; end if;
end $$;
select count(*) as scheduled_turns from public.appointments
where workspace_id='f8000000-0000-4000-8000-000000000001' and status in ('scheduled','completed');
rollback;
