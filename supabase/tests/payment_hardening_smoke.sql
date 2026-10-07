-- Run only on the development project or a local database. Synthetic records are rolled back.
-- G7A: expired requests, late payments, refunds, two tabs and disconnecting with a payment in flight.
begin;
insert into public.workspaces(id,name,slug) values('f7000000-0000-4000-8000-000000000001','Hardening smoke','hardening-smoke');
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','f7000000-0000-4000-8000-000000000002',
  'authenticated','authenticated','hardening-smoke@example.invalid','',now(),'{}','{}',now(),now());
-- The sign-up trigger may already have created a workspace for this user: keep only the one under test.
delete from public.workspace_members where user_id='f7000000-0000-4000-8000-000000000002';
insert into public.workspace_members(workspace_id,user_id,role)
values('f7000000-0000-4000-8000-000000000001','f7000000-0000-4000-8000-000000000002','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
values('f7000000-0000-4000-8000-000000000003','f7000000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000002','Prueba hardening','Psicología','hardening-smoke');
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
values('f7000000-0000-4000-8000-000000000004','f7000000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000003','Consulta',2500000,60,'online',0);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'f7000000-0000-4000-8000-000000000001','f7000000-0000-4000-8000-000000000003',
  day,'09:00','18:00',0 from generate_series(0,6) day;
set local role authenticated;
select set_config('request.jwt.claim.sub','f7000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"f7000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select public.save_questionnaire('f7000000-0000-4000-8000-000000000004',
'{"title":"Preconsulta","sections":[{"key":"situation","label":"Situación"},{"key":"problem","label":"Problema"},{"key":"implication","label":"Implicación"},{"key":"need","label":"Necesidad"}],"questions":[{"client_id":"one","section":"situation","title":"¿Qué necesitás?","type":"text","options":[],"required":true,"active":true}]}'::jsonb);
do $$ declare v_name text; begin
  -- Neither new function is reachable with a session.
  foreach v_name in array array[
    $q$select public.expire_stale_booking_intents(10)$q$,
    $q$select public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001')$q$] loop
    begin execute v_name; raise exception 'reachable_with_session: %', v_name;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;

-- Connection: ready only while there is a usable account. A missing account and a failed one both answer false.
set local role service_role;
do $$
begin
  if public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001') then raise exception 'ready_without_account'; end if;
  perform public.store_mercado_pago_connection('f7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000002','12345','access-token-h1','refresh-token-h1',now()+interval '180 days','test');
  if not public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001') then raise exception 'connected_not_ready'; end if;
  -- A passing failure of the renewal changes nothing; a definitive one stops the checkout until reconnecting.
  perform public.fail_mercado_pago_refresh('f7000000-0000-4000-8000-000000000001',false);
  if not public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001') then raise exception 'temporary_failure_closed_checkout'; end if;
  perform public.fail_mercado_pago_refresh('f7000000-0000-4000-8000-000000000001',true);
  if public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001') then raise exception 'error_state_still_ready'; end if;
  if (select count(*) from public.audit_events where workspace_id='f7000000-0000-4000-8000-000000000001'
    and action='mercado_pago_connection_error') <> 1 then raise exception 'connection_error_not_audited'; end if;
  -- Failing again while already in error records nothing more.
  perform public.fail_mercado_pago_refresh('f7000000-0000-4000-8000-000000000001',true);
  if (select count(*) from public.audit_events where workspace_id='f7000000-0000-4000-8000-000000000001'
    and action='mercado_pago_connection_error') <> 1 then raise exception 'connection_error_audited_twice'; end if;
  -- Reconnecting restores it.
  perform public.store_mercado_pago_connection('f7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000002','12345','access-token-h2','refresh-token-h2',now()+interval '180 days','test');
  if not public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001') then raise exception 'reconnect_not_ready'; end if;
end $$;
reset role;
-- Expired with nothing to renew it (an old manual load): not ready, same as the status the panel shows.
update private.mercado_pago_accounts set token_expires_at=now()-interval '1 hour',refresh_token_secret_id=null
  where workspace_id='f7000000-0000-4000-8000-000000000001';
do $$ begin
  if public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001') then raise exception 'expired_account_ready'; end if;
end $$;
update private.mercado_pago_accounts set token_expires_at=now()+interval '90 days' where workspace_id='f7000000-0000-4000-8000-000000000001';
update public.workspaces set payment_provider='mercado_pago_ar' where id='f7000000-0000-4000-8000-000000000001';

set local role service_role;
do $$
declare q uuid; v_answers jsonb; v_stale uuid; v_fresh uuid; v_late uuid; v_closed uuid; v_refund uuid;
  v_slot timestamptz; v_first uuid; v_count integer; v_expiry timestamptz;
  v_url text := 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-h';
begin
  select qq.id into q from public.questionnaire_questions qq
    join public.questionnaires form on form.id=qq.questionnaire_id
    where form.service_id='f7000000-0000-4000-8000-000000000004' limit 1;
  v_answers := jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta de prueba'));
  v_stale := public.create_checkout_intent('f7000000-0000-4000-8000-000000000004','Prueba','Vencida','hard-a@example.invalid','+5491112345678',v_answers,repeat('a',64));
  v_fresh := public.create_checkout_intent('f7000000-0000-4000-8000-000000000004','Prueba','Vigente','hard-b@example.invalid','+5491112345678',v_answers,repeat('b',64));
  v_late := public.create_checkout_intent('f7000000-0000-4000-8000-000000000004','Prueba','Tardía','hard-c@example.invalid','+5491112345678',v_answers,repeat('c',64));
  v_closed := public.create_checkout_intent('f7000000-0000-4000-8000-000000000004','Prueba','Cerrada','hard-d@example.invalid','+5491112345678',v_answers,repeat('d',64));
  v_refund := public.create_checkout_intent('f7000000-0000-4000-8000-000000000004','Prueba','Reembolso','hard-e@example.invalid','+5491112345678',v_answers,repeat('e',64));
  perform public.attach_mercado_pago_checkout(v_stale,'pref-stale',v_url,repeat('1',64));
  perform public.attach_mercado_pago_checkout(v_fresh,'pref-fresh',v_url,repeat('2',64));
  perform public.attach_mercado_pago_checkout(v_late,'pref-late',v_url,repeat('3',64));
  perform public.attach_mercado_pago_checkout(v_closed,'pref-closed',v_url,repeat('4',64));
  perform public.attach_mercado_pago_checkout(v_refund,'pref-refund',v_url,repeat('5',64));

  -- Refund: a paid and booked request is refunded once; the appointment is released and nothing reopens.
  perform public.record_mercado_pago_payment(v_refund,'pref-refund','7001','ev-approved','approved',2500000,'ARS');
  select s.starts_at into v_slot from public.available_slots_for_intent(v_refund,current_date+2) s order by 1 limit 1;
  if v_slot is null then raise exception 'no_slot_for_paid_request'; end if;
  v_first := public.schedule_paid_intent(v_refund,v_slot);

  -- Two tabs: the second confirmation of the same request is refused and exactly one appointment exists.
  begin
    perform public.schedule_paid_intent(v_refund,v_slot + interval '2 hours');
    raise exception 'second_tab_created_another_appointment';
  exception when others then if sqlerrm <> 'payment_not_confirmed' then raise; end if; end;
  -- The constraint is the source of truth, whatever the function checks first.
  begin
    insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
    select workspace_id,booking_intent_id,professional_id,patient_id,starts_at + interval '3 hours',ends_at + interval '3 hours'
    from public.appointments where id=v_first;
    raise exception 'two_appointments_for_one_request';
  exception when unique_violation then null; end;
  if (select count(*) from public.appointments where booking_intent_id=v_refund) <> 1
    or (select id from public.appointments where booking_intent_id=v_refund) <> v_first
    then raise exception 'second_tab_does_not_see_the_first_appointment'; end if;

  -- A refund for a different payment than the approved one is refused.
  begin
    perform public.record_mercado_pago_payment(v_refund,'pref-refund','7999','ev-refund-x','refunded',2500000,'ARS');
    raise exception 'refund_of_another_payment_accepted';
  exception when others then if sqlerrm <> 'refund_mismatch' then raise; end if; end;
  if not public.record_mercado_pago_payment(v_refund,'pref-refund','7001','ev-refund','refunded',2500000,'ARS')
    then raise exception 'refund_not_recorded'; end if;
  if (select status from public.booking_intents where id=v_refund) <> 'refunded'
    or (select status from public.payments where booking_intent_id=v_refund) <> 'refunded'
    or (select status from public.appointments where id=v_first) <> 'cancelled'
    or (select count(*) from public.audit_events a join public.payments p on p.id=a.object_id
      where p.booking_intent_id=v_refund and a.action='mercado_pago_refunded') <> 1
    then raise exception 'refund_not_applied'; end if;
  -- Repeated, or followed by a stale "approved" or a dispute: nothing changes and nothing is reactivated.
  if public.record_mercado_pago_payment(v_refund,'pref-refund','7001','ev-refund-again','refunded',2500000,'ARS')
    or public.record_mercado_pago_payment(v_refund,'pref-refund','7001','ev-approved-late','approved',2500000,'ARS')
    or public.record_mercado_pago_payment(v_refund,'pref-refund','7001','ev-dispute','pending',2500000,'ARS')
    then raise exception 'refunded_payment_changed'; end if;
  if (select status from public.booking_intents where id=v_refund) <> 'refunded'
    or (select status from public.appointments where id=v_first) <> 'cancelled'
    or exists(select 1 from public.available_slots_for_intent(v_refund,current_date+2))
    then raise exception 'refund_reactivated_booking'; end if;
  begin
    perform public.schedule_paid_intent(v_refund,v_slot);
    raise exception 'refunded_request_booked_again';
  exception when others then if sqlerrm <> 'payment_not_confirmed' then raise; end if; end;
  -- A dispute opened on an approved payment (recorded as pending) does not undo it either.
  perform public.record_mercado_pago_payment(v_fresh,'pref-fresh','7100','ev-fresh','approved',2500000,'ARS');
  if public.record_mercado_pago_payment(v_fresh,'pref-fresh','7100','ev-fresh-dispute','pending',2500000,'ARS')
    or (select status from public.booking_intents where id=v_fresh) <> 'awaiting_schedule' then raise exception 'dispute_undid_approved_payment'; end if;

  -- Expired requests: the cleanup closes only what ran out of time without a payment, once.
  update public.booking_intents set expires_at=now()-interval '1 hour' where id in (v_stale,v_late);
  -- Paid and waiting for a time, even past its date, is never closed by the cleanup.
  update public.booking_intents set expires_at=now()-interval '1 hour' where id=v_fresh;
  perform public.record_mercado_pago_payment(v_stale,'pref-stale','7200','ev-stale-rejected','rejected',2500000,'ARS');
  v_count := public.expire_stale_booking_intents(1);
  if v_count <> 1 then raise exception 'batch_limit_ignored: %', v_count; end if;
  v_count := public.expire_stale_booking_intents();
  if v_count <> 1 then raise exception 'cleanup_closed_unexpected: %', v_count; end if;
  if public.expire_stale_booking_intents() <> 0 then raise exception 'cleanup_not_idempotent'; end if;
  if (select count(*) from public.booking_intents where id in (v_stale,v_late) and status='cancelled') <> 2
    or (select count(*) from public.payments where booking_intent_id in (v_stale,v_late) and status='expired') <> 2
    or (select count(*) from public.audit_events where object_id in (v_stale,v_late) and action='booking_intent_expired') <> 2
    then raise exception 'expired_requests_not_closed'; end if;
  if (select status from public.booking_intents where id=v_fresh) <> 'awaiting_schedule'
    or (select status from public.payments where booking_intent_id=v_fresh) <> 'approved'
    or (select status from public.booking_intents where id=v_closed) <> 'pending_payment'
    or (select status from public.booking_intents where id=v_refund) <> 'refunded'
    then raise exception 'cleanup_touched_other_requests'; end if;
  -- Nothing was deleted, and a closed request offers no time.
  if (select count(*) from public.questionnaire_answers where booking_intent_id=v_stale) = 0
    or exists(select 1 from public.available_slots_for_intent(v_stale,current_date+2))
    then raise exception 'expired_request_lost_data_or_offers_slots'; end if;
  begin
    perform public.schedule_paid_intent(v_stale,v_slot);
    raise exception 'expired_request_booked';
  exception when others then if sqlerrm <> 'payment_not_confirmed' then raise; end if; end;

  -- Late approved payment.
  -- A. In time: an approved payment on an open request unlocks choosing a time (v_fresh above, v_flight below).
  if (select count(*) from public.audit_events where object_id=v_fresh and action='mercado_pago_late_payment_approved') <> 0
    then raise exception 'payment_in_time_marked_late'; end if;

  -- Anything but an approval leaves a request closed for expiry exactly as it is.
  if public.record_mercado_pago_payment(v_late,'pref-late','7300','ev-late-pending','pending',2500000,'ARS')
    or public.record_mercado_pago_payment(v_late,'pref-late','7300','ev-late-rejected','rejected',2500000,'ARS')
    or (select status from public.booking_intents where id=v_late) <> 'cancelled'
    or (select status from public.payments where booking_intent_id=v_late) <> 'expired'
    then raise exception 'late_non_approval_changed_closed_request'; end if;
  -- A late payment for another amount or another preference is refused like any other.
  begin
    perform public.record_mercado_pago_payment(v_late,'pref-late','7300','ev-late-amount','approved',100,'ARS');
    raise exception 'late_payment_with_wrong_amount_accepted';
  exception when others then if sqlerrm <> 'payment_mismatch' then raise; end if; end;
  begin
    perform public.record_mercado_pago_payment(v_late,'pref-stale','7300','ev-late-pref','approved',2500000,'ARS');
    raise exception 'late_payment_attached_to_wrong_request';
  exception when others then if sqlerrm <> 'payment_mismatch' then raise; end if; end;

  -- B. Expired (closed by the cleanup), then approved: the payment is recorded with its id and its evidence,
  -- and the request is not reactivated.
  select expires_at into v_expiry from public.booking_intents where id=v_late;
  if not public.record_mercado_pago_payment(v_late,'pref-late','7300','ev-late-approved','approved',2500000,'ARS')
    then raise exception 'late_payment_not_recorded'; end if;
  if (select status || ' ' || provider_payment_id || ' ' || provider_event_id || ' ' || (approved_at is not null)::text
      from public.payments where booking_intent_id=v_late) <> 'approved 7300 ev-late-approved true'
    then raise exception 'late_payment_evidence_missing'; end if;
  if (select status from public.booking_intents where id=v_late) <> 'cancelled'
    or (select expires_at from public.booking_intents where id=v_late) <> v_expiry
    or (select count(*) from public.audit_events where object_id=v_late and action='mercado_pago_late_payment_approved') <> 1
    or (select count(*) from public.audit_events a join public.payments p on p.id=a.object_id
      where p.booking_intent_id=v_late and a.action='mercado_pago_approved') <> 1
    then raise exception 'late_payment_reactivated_request'; end if;

  -- D. The same approval again (a duplicated webhook, or the same payment seen by a status check): nothing changes.
  if public.record_mercado_pago_payment(v_late,'pref-late','7300','ev-late-approved','approved',2500000,'ARS')
    or public.record_mercado_pago_payment(v_late,'pref-late','7300','ev-late-approved-again','approved',2500000,'ARS')
    or (select count(*) from public.audit_events where object_id=v_late and action='mercado_pago_late_payment_approved') <> 1
    or (select count(*) from public.audit_events a join public.payments p on p.id=a.object_id
      where p.booking_intent_id=v_late and a.action='mercado_pago_approved') <> 1
    or (select status || ' ' || provider_event_id from public.payments where booking_intent_id=v_late) <> 'approved ev-late-approved'
    or (select status from public.booking_intents where id=v_late) <> 'cancelled'
    then raise exception 'late_payment_not_idempotent'; end if;

  -- E. A late approval creates no appointment, offers no time and cannot be booked. The cleanup leaves it alone.
  if exists(select 1 from public.appointments where booking_intent_id=v_late)
    or exists(select 1 from public.available_slots_for_intent(v_late,current_date+2))
    then raise exception 'late_payment_created_appointment_or_offers_slots'; end if;
  begin
    perform public.schedule_paid_intent(v_late,v_slot);
    raise exception 'late_payment_booked';
  exception when others then if sqlerrm <> 'payment_not_confirmed' then raise; end if; end;
  if public.expire_stale_booking_intents() <> 0
    or (select status from public.payments where booking_intent_id=v_late) <> 'approved'
    then raise exception 'cleanup_touched_late_payment'; end if;

  -- B again, when the cleanup has not run yet: past its date but still marked pending. Closed on the spot, not unlocked.
  update public.booking_intents set status='pending_payment',expires_at=now()-interval '1 hour' where id=v_stale;
  update public.payments set status='pending' where booking_intent_id=v_stale;
  if not public.record_mercado_pago_payment(v_stale,'pref-stale','7201','ev-stale-approved','approved',2500000,'ARS')
    then raise exception 'late_payment_before_cleanup_not_recorded'; end if;
  if (select status from public.booking_intents where id=v_stale) <> 'cancelled'
    or (select expires_at from public.booking_intents where id=v_stale) > now()
    or (select status || ' ' || provider_payment_id from public.payments where booking_intent_id=v_stale) <> 'approved 7201'
    or (select count(*) from public.audit_events where object_id=v_stale and action='mercado_pago_late_payment_approved') <> 1
    or exists(select 1 from public.appointments where booking_intent_id=v_stale)
    or exists(select 1 from public.available_slots_for_intent(v_stale,current_date+2))
    then raise exception 'late_payment_before_cleanup_reactivated_request'; end if;
  if public.record_mercado_pago_payment(v_stale,'pref-stale','7201','ev-stale-approved-again','approved',2500000,'ARS')
    or public.expire_stale_booking_intents() <> 0
    or (select count(*) from public.audit_events where object_id=v_stale and action='mercado_pago_late_payment_approved') <> 1
    then raise exception 'late_payment_before_cleanup_not_idempotent'; end if;

  -- C. Cancelled for another reason, then approved late: stays cancelled, with the payment and the fact on record.
  update public.booking_intents set status='cancelled' where id=v_closed;
  update public.payments set status='cancelled' where booking_intent_id=v_closed;
  if not public.record_mercado_pago_payment(v_closed,'pref-closed','7400','ev-closed-approved','approved',2500000,'ARS')
    then raise exception 'payment_on_cancelled_request_not_recorded'; end if;
  if (select status from public.booking_intents where id=v_closed) <> 'cancelled'
    or (select status || ' ' || provider_payment_id from public.payments where booking_intent_id=v_closed) <> 'approved 7400'
    or (select count(*) from public.audit_events where object_id=v_closed and action='mercado_pago_late_payment_approved') <> 1
    or exists(select 1 from public.appointments where booking_intent_id=v_closed)
    or exists(select 1 from public.available_slots_for_intent(v_closed,current_date+2))
    then raise exception 'cancelled_request_reopened_by_payment'; end if;
  begin
    perform public.schedule_paid_intent(v_closed,v_slot);
    raise exception 'cancelled_request_booked';
  exception when others then if sqlerrm <> 'payment_not_confirmed' then raise; end if; end;
  if public.record_mercado_pago_payment(v_closed,'pref-closed','7400','ev-closed-approved-again','approved',2500000,'ARS')
    or (select count(*) from public.audit_events where object_id=v_closed and action='mercado_pago_late_payment_approved') <> 1
    then raise exception 'payment_on_cancelled_request_not_idempotent'; end if;
  -- What a person does next happens in Mercado Pago. A refund made there is recorded here and the request stays closed.
  if not public.record_mercado_pago_payment(v_closed,'pref-closed','7400','ev-closed-refunded','refunded',2500000,'ARS')
    then raise exception 'refund_of_late_payment_not_recorded'; end if;
  if (select status from public.booking_intents where id=v_closed) <> 'refunded'
    or exists(select 1 from public.available_slots_for_intent(v_closed,current_date+2))
    then raise exception 'refund_of_late_payment_reopened_request'; end if;
end $$;

-- Disconnecting with a payment in flight: allowed, the request and its payment stay as they are,
-- nothing can be verified until the owner reconnects, and then the same payment is recorded.
do $$
declare q uuid; v_flight uuid;
begin
  select qq.id into q from public.questionnaire_questions qq
    join public.questionnaires form on form.id=qq.questionnaire_id
    where form.service_id='f7000000-0000-4000-8000-000000000004' limit 1;
  v_flight := public.create_checkout_intent('f7000000-0000-4000-8000-000000000004','Prueba','En curso','hard-f@example.invalid','+5491112345678',
    jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta de prueba')),repeat('f',64));
  perform public.attach_mercado_pago_checkout(v_flight,'pref-flight','https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-f',repeat('6',64));
  perform set_config('bellis.smoke_flight',v_flight::text,true);
end $$;
set local role authenticated;
do $$ begin perform public.disconnect_mercado_pago('f7000000-0000-4000-8000-000000000001'); end $$;
set local role service_role;
do $$
declare v_flight uuid := current_setting('bellis.smoke_flight')::uuid;
begin
  if public.mercado_pago_checkout_ready('f7000000-0000-4000-8000-000000000001')
    or exists(select 1 from public.mercado_pago_credentials('f7000000-0000-4000-8000-000000000001'))
    then raise exception 'disconnected_account_still_usable'; end if;
  if (select payment_provider from public.workspaces where id='f7000000-0000-4000-8000-000000000001') <> 'external_link'
    then raise exception 'disconnect_left_mercado_pago_as_method'; end if;
  if (select status from public.booking_intents where id=v_flight) <> 'pending_payment'
    or (select status || ' ' || provider || ' ' || provider_order_id from public.payments where booking_intent_id=v_flight) <> 'pending mercado_pago_ar pref-flight'
    then raise exception 'disconnect_changed_payment_in_flight'; end if;
  perform public.store_mercado_pago_connection('f7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000002','12345','access-token-h3','refresh-token-h3',now()+interval '180 days','test');
  if not public.record_mercado_pago_payment(v_flight,'pref-flight','7500','ev-flight','approved',2500000,'ARS')
    then raise exception 'payment_in_flight_not_recorded_after_reconnect'; end if;
  if (select status from public.booking_intents where id=v_flight) <> 'awaiting_schedule'
    then raise exception 'payment_in_flight_lost_after_reconnect'; end if;
end $$;
rollback;
