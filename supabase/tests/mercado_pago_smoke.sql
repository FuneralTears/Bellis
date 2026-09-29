-- Run only on the development project. Synthetic records are rolled back.
begin;
insert into public.workspaces(id,name,slug,payment_provider)
values('f3000000-0000-4000-8000-000000000001','MP smoke','mp-smoke','mercado_pago_ar');
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','f3000000-0000-4000-8000-000000000002',
  'authenticated','authenticated','mp-smoke@example.invalid','',now(),'{}','{}',now(),now());
insert into public.workspace_members(workspace_id,user_id,role)
values('f3000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000002','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
values('f3000000-0000-4000-8000-000000000003','f3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000002','Prueba MP','Psicología','mp-smoke');
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
values('f3000000-0000-4000-8000-000000000004','f3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000003','Consulta',2500000,60,'online',0);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'f3000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000003',
  day,'09:00','18:00',0 from generate_series(0,6) day;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment)
values('f3000000-0000-4000-8000-000000000001','12345',vault.create_secret('fake-test-token'),'test');
set local role authenticated;
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000002',true);
select public.save_questionnaire('f3000000-0000-4000-8000-000000000004',
'{"title":"Preconsulta","sections":[{"key":"situation","label":"Situación"},{"key":"problem","label":"Problema"},{"key":"implication","label":"Implicación"},{"key":"need","label":"Necesidad"}],"questions":[{"client_id":"one","section":"situation","title":"¿Qué necesitás?","type":"text","options":[],"required":true,"active":true}]}'::jsonb);
set local role service_role;
do $$
declare q uuid; v_intent uuid; v_rejected uuid; v_wrong uuid; v_count integer;
begin
  if (select access_token from public.mercado_pago_account('f3000000-0000-4000-8000-000000000001'))
    <> 'fake-test-token' then raise exception 'vault_account_unavailable'; end if;
  select qq.id into q from public.questionnaire_questions qq
    join public.questionnaires form on form.id=qq.questionnaire_id
    where form.service_id='f3000000-0000-4000-8000-000000000004' limit 1;
  v_intent := public.create_checkout_intent('f3000000-0000-4000-8000-000000000004',
    'Prueba','Pago','mp-patient@example.invalid','+5491112345678',
    jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta de prueba')),repeat('e',64));
  if (select status from public.payments where booking_intent_id=v_intent) <> 'pending' then
    raise exception 'payment_not_pending'; end if;
  if exists(select 1 from public.available_slots_for_intent(v_intent,current_date+1)) then
    raise exception 'unpaid_slots_visible'; end if;
  perform public.set_mercado_pago_preference(v_intent,'pref-smoke');
  begin
    perform public.record_mercado_pago_payment(v_intent,'pref-smoke','1001','wrong-amount',
      'approved',1,'ARS');
    raise exception 'tampered_price_was_accepted';
  exception when others then if sqlerrm <> 'payment_mismatch' then raise; end if; end;
  v_wrong := gen_random_uuid();
  begin
    perform public.record_mercado_pago_payment(v_wrong,'pref-smoke','1001','wrong-org',
      'approved',2500000,'ARS');
    raise exception 'wrong_intent_was_accepted';
  exception when others then if sqlerrm <> 'payment_mismatch' then raise; end if; end;
  perform public.record_mercado_pago_payment(v_intent,'pref-smoke','1001','approved-once',
    'approved',2500000,'ARS');
  if (select status from public.booking_intents where id=v_intent) <> 'awaiting_schedule' then
    raise exception 'approved_payment_not_unlocked'; end if;
  if public.record_mercado_pago_payment(v_intent,'pref-smoke','1001','approved-duplicate',
    'approved',2500000,'ARS') then raise exception 'duplicate_changed_payment'; end if;
  select count(*) into v_count from public.audit_events where object_type='payment'
    and object_id=(select id from public.payments where booking_intent_id=v_intent);
  if v_count <> 1 then raise exception 'duplicate_audit_event'; end if;
  if (select count(*) from public.payments where booking_intent_id=v_intent) <> 1 then
    raise exception 'duplicate_payment'; end if;
  v_rejected := public.create_checkout_intent('f3000000-0000-4000-8000-000000000004',
    'Prueba','Rechazo','mp-rejected@example.invalid','+5491112345678',
    jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta rechazada')),repeat('f',64));
  perform public.set_mercado_pago_preference(v_rejected,'pref-rejected');
  perform public.record_mercado_pago_payment(v_rejected,'pref-rejected','1002','rejected-once',
    'rejected',2500000,'ARS');
  if exists(select 1 from public.available_slots_for_intent(v_rejected,current_date+1)) then
    raise exception 'rejected_slots_visible'; end if;
end $$;
rollback;
