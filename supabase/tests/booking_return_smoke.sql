-- Run only on the development project or a local database. Synthetic records are rolled back.
begin;
insert into public.workspaces(id,name,slug,payment_provider)
values('f5000000-0000-4000-8000-000000000001','Return smoke','return-smoke','mercado_pago_ar');
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','f5000000-0000-4000-8000-000000000002',
  'authenticated','authenticated','return-smoke@example.invalid','',now(),'{}','{}',now(),now());
insert into public.workspace_members(workspace_id,user_id,role)
values('f5000000-0000-4000-8000-000000000001','f5000000-0000-4000-8000-000000000002','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
values('f5000000-0000-4000-8000-000000000003','f5000000-0000-4000-8000-000000000001',
  'f5000000-0000-4000-8000-000000000002','Prueba retorno','Psicología','return-smoke');
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
values('f5000000-0000-4000-8000-000000000004','f5000000-0000-4000-8000-000000000001',
  'f5000000-0000-4000-8000-000000000003','Consulta',2500000,60,'online',0);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'f5000000-0000-4000-8000-000000000001','f5000000-0000-4000-8000-000000000003',
  day,'09:00','18:00',0 from generate_series(0,6) day;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment)
values('f5000000-0000-4000-8000-000000000001','12345',vault.create_secret('fake-return-token'),'test');
set local role authenticated;
select set_config('request.jwt.claim.sub','f5000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select public.save_questionnaire('f5000000-0000-4000-8000-000000000004',
'{"title":"Preconsulta","sections":[{"key":"situation","label":"Situación"},{"key":"problem","label":"Problema"},{"key":"implication","label":"Implicación"},{"key":"need","label":"Necesidad"}],"questions":[{"client_id":"one","section":"situation","title":"¿Qué necesitás?","type":"text","options":[],"required":true,"active":true}]}'::jsonb);
do $$ declare v_name text; begin
  -- Neither function is reachable with a session.
  foreach v_name in array array[
    $q$select public.attach_mercado_pago_checkout(gen_random_uuid(),'pref-x','https://www.mercadopago.com.ar/x',repeat('a',64))$q$,
    $q$select public.cancel_unpaid_intent(gen_random_uuid())$q$] loop
    begin execute v_name; raise exception 'reachable_with_session: %', v_name;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
set local role service_role;
do $$
declare q uuid; v_paid uuid; v_orphan uuid; v_other uuid; v_answers jsonb;
  v_url text := 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-return';
begin
  select qq.id into q from public.questionnaire_questions qq
    join public.questionnaires form on form.id=qq.questionnaire_id
    where form.service_id='f5000000-0000-4000-8000-000000000004' limit 1;
  v_answers := jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta de prueba'));
  v_paid := public.create_checkout_intent('f5000000-0000-4000-8000-000000000004',
    'Prueba','Retorno','return-a@example.invalid','+5491112345678',v_answers,repeat('a',64));

  -- The checkout address must be Mercado Pago's, and the return token a hash.
  begin
    perform public.attach_mercado_pago_checkout(v_paid,'pref-return','https://pagos.intruso.example/pay',repeat('1',64));
    raise exception 'foreign_checkout_address_accepted';
  exception when check_violation then null; end;
  begin
    perform public.attach_mercado_pago_checkout(v_paid,'pref-return',v_url,'not-a-hash');
    raise exception 'malformed_return_token_accepted';
  exception when others then if sqlerrm <> 'invalid_checkout' then raise; end if; end;
  perform public.attach_mercado_pago_checkout(v_paid,'pref-return',v_url,repeat('1',64));
  if (select provider_order_id || ' ' || checkout_url from public.payments where booking_intent_id=v_paid) <> 'pref-return ' || v_url
    or (select id from public.booking_intents where resume_token_hash=repeat('1',64)) <> v_paid
    then raise exception 'checkout_not_recorded'; end if;
  -- One checkout per request: it cannot be replaced by another preference.
  begin
    perform public.attach_mercado_pago_checkout(v_paid,'pref-second',v_url,repeat('2',64));
    raise exception 'second_checkout_attached';
  exception when others then if sqlerrm <> 'invalid_payment_state' then raise; end if; end;
  -- A request with a checkout is never closed as "without checkout".
  if public.cancel_unpaid_intent(v_paid) then raise exception 'request_with_checkout_was_closed'; end if;

  -- Paying again on the same checkout: a rejected attempt keeps the schedule closed, a later approved one opens it.
  perform public.record_mercado_pago_payment(v_paid,'pref-return','2001','first-try','rejected',2500000,'ARS');
  if (select status from public.booking_intents where id=v_paid) <> 'pending_payment'
    or exists(select 1 from public.available_slots_for_intent(v_paid,current_date+1))
    then raise exception 'rejected_payment_unlocked_schedule'; end if;
  perform public.record_mercado_pago_payment(v_paid,'pref-return','2002','second-try','approved',2500000,'ARS');
  if (select status from public.booking_intents where id=v_paid) <> 'awaiting_schedule'
    or (select status from public.payments where booking_intent_id=v_paid) <> 'approved'
    or not exists(select 1 from public.available_slots_for_intent(v_paid,current_date+1))
    then raise exception 'retry_did_not_unlock_schedule'; end if;
  -- A late rejection for the first attempt does not undo the approved payment.
  perform public.record_mercado_pago_payment(v_paid,'pref-return','2001','first-try-late','rejected',2500000,'ARS');
  if (select status from public.payments where booking_intent_id=v_paid) <> 'approved' then raise exception 'approved_payment_was_undone'; end if;

  -- A request whose checkout could not be created is closed and kept.
  v_orphan := public.create_checkout_intent('f5000000-0000-4000-8000-000000000004',
    'Prueba','Sin checkout','return-b@example.invalid','+5491112345678',v_answers,repeat('b',64));
  if not public.cancel_unpaid_intent(v_orphan) then raise exception 'request_without_checkout_not_closed'; end if;
  if (select status from public.booking_intents where id=v_orphan) <> 'cancelled'
    or (select status from public.payments where booking_intent_id=v_orphan) <> 'cancelled'
    or (select count(*) from public.audit_events where object_id=v_orphan and action='checkout_not_created') <> 1
    then raise exception 'closed_request_not_recorded'; end if;
  if public.cancel_unpaid_intent(v_orphan) then raise exception 'request_closed_twice'; end if;
  begin
    perform public.attach_mercado_pago_checkout(v_orphan,'pref-late',v_url,repeat('3',64));
    raise exception 'checkout_attached_to_closed_request';
  exception when others then if sqlerrm <> 'invalid_payment_state' then raise; end if; end;

  -- A return token belongs to one request only, and an expired request takes no checkout.
  v_other := public.create_checkout_intent('f5000000-0000-4000-8000-000000000004',
    'Prueba','Otra','return-c@example.invalid','+5491112345678',v_answers,repeat('c',64));
  begin
    perform public.attach_mercado_pago_checkout(v_other,'pref-other',v_url,repeat('1',64));
    raise exception 'return_token_shared_by_two_requests';
  exception when unique_violation then null; end;
  update public.booking_intents set expires_at=now()-interval '1 minute' where id=v_other;
  begin
    perform public.attach_mercado_pago_checkout(v_other,'pref-other',v_url,repeat('4',64));
    raise exception 'checkout_attached_to_expired_request';
  exception when others then if sqlerrm <> 'invalid_payment_state' then raise; end if; end;
end $$;
rollback;
