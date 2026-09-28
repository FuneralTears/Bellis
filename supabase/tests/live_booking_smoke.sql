-- Synthetic integration test. All rows, including patients and answers, roll back.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','f2000000-0000-4000-8000-000000000001','authenticated','authenticated','booking-smoke@example.invalid','',now(),'{}','{}',now(),now());
insert into public.workspaces(id,name,slug,payment_provider)
values('f2000000-0000-4000-8000-000000000002','Booking smoke','booking-smoke','external_link');
insert into public.workspace_members(workspace_id,user_id,role)
values('f2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000001','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
values('f2000000-0000-4000-8000-000000000003','f2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000001','Smoke','Psicología','booking-smoke');
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes,external_payment_url)
values('f2000000-0000-4000-8000-000000000004','f2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000003','Consulta',2500000,60,'online',0,'https://example.invalid/pay');
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'f2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000003',day,'09:00','18:00',15
from generate_series(0,6) day;
set local role authenticated;
select set_config('request.jwt.claim.sub','f2000000-0000-4000-8000-000000000001',true);
select public.save_questionnaire('f2000000-0000-4000-8000-000000000004',
'{"title":"Preconsulta","sections":[{"key":"situation","label":"Situación"},{"key":"problem","label":"Problema"},{"key":"implication","label":"Implicación"},{"key":"need","label":"Necesidad"}],"questions":[{"client_id":"one","section":"situation","title":"¿Qué necesitás?","type":"text","options":[],"required":true,"active":true}]}'::jsonb);
set local role service_role;
do $$
declare q uuid; first_intent uuid; second_intent uuid; target_slot timestamptz; appointment_id uuid;
begin
  select id into q from public.questionnaire_questions where workspace_id='f2000000-0000-4000-8000-000000000002' limit 1;
  first_intent := public.create_checkout_intent('f2000000-0000-4000-8000-000000000004','Prueba','Uno','first@example.invalid','+5491112345678',
    jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta de prueba')),repeat('a',64));
  begin
    perform public.schedule_paid_intent(first_intent,(current_date+1+'09:00'::time) at time zone 'America/Argentina/Buenos_Aires');
    raise exception 'unpaid_booking_was_allowed';
  exception when others then if sqlerrm <> 'payment_not_confirmed' then raise; end if; end;
  second_intent := public.create_checkout_intent('f2000000-0000-4000-8000-000000000004','Prueba','Dos','second@example.invalid','+5491112345678',
    jsonb_build_array(jsonb_build_object('question_id',q,'answer','Otra consulta')),repeat('b',64));
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','f2000000-0000-4000-8000-000000000001',true);
select public.confirm_external_payment(id,'operacion-verificada-123')
from public.booking_intents where workspace_id='f2000000-0000-4000-8000-000000000002';
set local role service_role;
do $$
declare first_intent uuid; second_intent uuid; target_slot timestamptz; v_appointment_id uuid;
begin
  select id into first_intent from public.booking_intents where access_token_hash=repeat('a',64);
  select id into second_intent from public.booking_intents where access_token_hash=repeat('b',64);
  insert into public.availability_blocks(workspace_id,professional_id,starts_at,ends_at,reason)
  values('f2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000003',
    (current_date+2)::timestamp at time zone 'America/Argentina/Buenos_Aires',
    (current_date+3)::timestamp at time zone 'America/Argentina/Buenos_Aires','Día bloqueado');
  if exists(select 1 from public.available_slots_for_intent(first_intent,current_date+2))
    then raise exception 'blocked_day_has_slots'; end if;
  select starts_at into target_slot from public.available_slots_for_intent(first_intent,current_date+1) order by starts_at limit 1;
  if target_slot is null then raise exception 'available_slot_missing'; end if;
  v_appointment_id := public.schedule_paid_intent(first_intent,target_slot);
  if v_appointment_id is null then raise exception 'appointment_missing'; end if;
  begin
    perform public.schedule_paid_intent(second_intent,target_slot);
    raise exception 'double_booking_was_allowed';
  exception when others then if sqlerrm <> 'slot_unavailable' then raise; end if; end;
  if (select count(*) from public.notification_outbox n where n.appointment_id=v_appointment_id) <> 4
    then raise exception 'notification_outbox_missing'; end if;
end $$;
select count(*) as scheduled_turns from public.appointments where workspace_id='f2000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','f2000000-0000-4000-8000-000000000099',true);
do $$ begin
  if exists(select 1 from public.appointments where workspace_id='f2000000-0000-4000-8000-000000000002')
    or exists(select 1 from public.patients where workspace_id='f2000000-0000-4000-8000-000000000002')
    or exists(select 1 from public.payments where workspace_id='f2000000-0000-4000-8000-000000000002')
    then raise exception 'cross_tenant_data_visible'; end if;
end $$;
rollback;
