-- H2.7 planes y capacidades: prueba de Bellis Pro, Free, Pro manual, y los controles del servidor sobre
-- Mercado Pago y automatizaciones. Datos sintéticos; todo se revierte.
-- Dentro de una transacción now() no avanza: el paso del tiempo se simula moviendo las fechas del workspace.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('fd000000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h27-plan-' || n || '@example.invalid','',now(),'{}','{}',now(),now()
from generate_series(1,2) n;
-- W1: el consultorio de las pruebas, con link de pago externo. W2: otro workspace, para el aislamiento.
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url) values
  ('fd000000-0000-4000-8000-0000000000a1','Plan smoke','plan-smoke','external_link','https://pagos.example/h27'),
  ('fd000000-0000-4000-8000-0000000000a2','Plan smoke B','plan-smoke-b','external_link','https://pagos.example/h27b');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('fd000000-0000-4000-8000-0000000000a1','fd000000-0000-4000-8000-000000000001','owner'),
  ('fd000000-0000-4000-8000-0000000000a2','fd000000-0000-4000-8000-000000000002','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug) values
  ('fd000000-0000-4000-8000-0000000000b1','fd000000-0000-4000-8000-0000000000a1','fd000000-0000-4000-8000-000000000001','Smoke Plan','Psicología','plan-smoke-a');
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes) values
  ('fd000000-0000-4000-8000-0000000000c1','fd000000-0000-4000-8000-0000000000a1','fd000000-0000-4000-8000-0000000000b1','Consulta',2500000,60,'online',0);
insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
select 'fd000000-0000-4000-8000-0000000000a1','fd000000-0000-4000-8000-0000000000b1',day,'09:00','18:00',0 from generate_series(0,6) day;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
values('fd000000-0000-4000-8000-0000000000a1','12345',vault.create_secret('fake-h27-token'),'test',now()+interval '1 day');
update public.automation_rules set enabled=true where workspace_id='fd000000-0000-4000-8000-0000000000a1';

create temp table pl as select
  'fd000000-0000-4000-8000-0000000000a1'::uuid w1,'fd000000-0000-4000-8000-0000000000a2'::uuid w2,null::uuid w3,
  'fd000000-0000-4000-8000-000000000001'::uuid u1,'fd000000-0000-4000-8000-000000000002'::uuid u2,'fd000000-0000-4000-8000-000000000003'::uuid u3,
  'fd000000-0000-4000-8000-0000000000b1'::uuid pro,'fd000000-0000-4000-8000-0000000000c1'::uuid svc,
  (now() at time zone 'America/Argentina/Buenos_Aires')::date today;
grant select on pl to authenticated,anon,service_role;
create temp table pl_ids(tag text primary key,id uuid);
grant select,insert on pl_ids to authenticated,service_role;
create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub',coalesce(p_user::text,''),true) $$;
-- Espera que una llamada falle con ese error exacto.
create function pg_temp.fails(p_sql text,p_error text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm <> p_error and sqlstate <> p_error then raise exception 'expected % but got % (%): %', p_error, sqlerrm, sqlstate, p_sql; end if; return; end;
  raise exception 'expected % but it succeeded: %', p_error, p_sql;
end $$;
create function pg_temp.caps(p_workspace uuid) returns text language sql as $$
  select string_agg(c, ',' order by c) from jsonb_array_elements_text(public.workspace_access(p_workspace)->'capabilities') c $$;

-- ===== Modelo: sin restos del esquema anterior, y permisos =====
do $$ begin
  if exists(select 1 from public.workspaces where status not in ('active','suspended') or plan_code not in ('free','pro'))
    then raise exception 'old_commercial_values_left'; end if;
  -- Un workspace cargado directo, sin onboarding, no tiene prueba.
  if (select trial_started_at is not null or trial_ends_at is not null or plan_code <> 'free' or status <> 'active' from public.workspaces where id=(select w1 from pl))
    then raise exception 'new_workspace_defaults_wrong'; end if;
  if private.workspace_tier((select w1 from pl)) <> 'free' then raise exception 'workspace_without_trial_is_not_free'; end if;
  -- Nadie de la API puede cambiar planes: ni la función administrativa ni las columnas.
  if has_function_privilege('anon','private.admin_set_workspace_plan(uuid,text,timestamptz,timestamptz)','execute')
    or has_function_privilege('authenticated','private.admin_set_workspace_plan(uuid,text,timestamptz,timestamptz)','execute')
    or has_function_privilege('service_role','private.admin_set_workspace_plan(uuid,text,timestamptz,timestamptz)','execute')
    or has_function_privilege('authenticated','private.start_workspace_trial(uuid)','execute')
    or has_function_privilege('anon','public.workspace_access(uuid)','execute')
    or has_function_privilege('anon','public.request_pro_upgrade(uuid)','execute')
    or has_function_privilege('authenticated','public.workspace_capability(uuid,text)','execute')
    then raise exception 'plan_function_privileges_wrong'; end if;
  if exists(select 1 from unnest(array['plan_code','status','trial_started_at','trial_ends_at','pro_started_at','pro_ends_at','plan_updated_at']) c
    where has_column_privilege('authenticated','public.workspaces',c,'update') or has_column_privilege('anon','public.workspaces',c,'update'))
    then raise exception 'plan_columns_writable'; end if;
  if has_table_privilege('authenticated','public.plan_upgrade_requests','select') or has_table_privilege('authenticated','public.plan_upgrade_requests','insert')
    or has_table_privilege('anon','public.plan_upgrade_requests','select') then raise exception 'upgrade_requests_exposed'; end if;
  -- La prueba termina al final del día 30 de Argentina. Empezar a las 23:30 del 13/10 o a las 00:30 del 14/10
  -- son días distintos: uno termina el 12/11 y el otro el 13/11, los dos a las 00:00 del día siguiente (03:00 UTC).
  if private.trial_end_for('2026-10-14 02:30+00') <> '2026-11-13 03:00+00' or private.trial_end_for('2026-10-14 03:30+00') <> '2026-11-14 03:00+00'
    then raise exception 'trial_end_wrong'; end if;
end $$;

-- ===== 1 y 2. La prueba empieza al completar el onboarding, una sola vez =====
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000',(select u3 from pl),'authenticated','authenticated','h27-plan-3@example.invalid','',now(),'{}',
  '{"bellis_signup":"1","name":"Prueba Plan","business":"Consultorio Plan","specialty":"Psicología","province":"Córdoba","city":"Córdoba","timezone":"America/Argentina/Buenos_Aires"}',now(),now());
update pl set w3=(select workspace_id from public.workspace_members where user_id=(select u3 from pl));
do $$ declare w public.workspaces%rowtype; begin
  select * into w from public.workspaces where id=(select w3 from pl);
  if w.onboarding_completed_at is not null or w.trial_started_at is not null or w.trial_ends_at is not null or w.plan_code <> 'free' or w.status <> 'active'
    then raise exception 'signup_started_trial'; end if;
  if private.workspace_tier(w.id) <> 'free' then raise exception 'incomplete_onboarding_has_pro'; end if;
end $$;
set local role authenticated;
select pg_temp.as_user((select u3 from pl));
do $$ declare v_doc jsonb := '{"service":"Consulta","description":"Inicial","price":"25000","duration":"60","mode":"Online","start":"09:00","end":"18:00","breakStart":"13:00","breakEnd":"14:00","notice":"24","buffer":"15","days":[true,true,true,true,true,false,false]}';
  a jsonb;
begin
  if (public.workspace_access((select w3 from pl))->>'tier') <> 'free' then raise exception 'access_before_onboarding_wrong'; end if;
  perform public.complete_bellis_onboarding(v_doc);
  perform public.complete_bellis_onboarding(v_doc);
  a := public.workspace_access((select w3 from pl));
  -- 3. Durante la prueba: Pro completo, y todo lo de Free.
  if a->>'tier' <> 'pro_trial' or (a->>'has_pro_access')::boolean is not true or a->>'plan_code' <> 'free' then raise exception 'trial_access_wrong: %', a; end if;
  if (a->>'trial_days_remaining')::integer <> 30 or (a->>'trial_last_day')::date <> (select today from pl) + 30 then raise exception 'trial_dates_wrong: %', a; end if;
  if pg_temp.caps((select w3 from pl)) <> 'advanced_insights,advanced_tags,automations,crm,external_payment_link,followups,google_calendar_sync,insurance_management,manual_appointments,manual_patients,manual_payments,marketing_tools,mercado_pago,patient_notes,patient_origin,public_booking,reports,smart_followups,weekly_metrics'
    then raise exception 'trial_capabilities_wrong: %', pg_temp.caps((select w3 from pl)); end if;
  -- Un miembro no ve el plan de otro workspace.
  perform pg_temp.fails(format('select public.workspace_access(%L)',(select w1 from pl)),'not_authorized');
  perform pg_temp.fails(format('update public.workspaces set plan_code=%L where id=%L','pro',(select w3 from pl)),'42501');
  perform pg_temp.fails(format('update public.workspaces set trial_ends_at=now()+interval %L where id=%L','90 days',(select w3 from pl)),'42501');
  perform pg_temp.fails(format('select private.admin_set_workspace_plan(%L,%L,now()+interval %L)',(select w3 from pl),'pro','30 days'),'42501');
end $$;
reset role;
do $$ declare w public.workspaces%rowtype; begin
  select * into w from public.workspaces where id=(select w3 from pl);
  if w.trial_started_at <> now() or w.trial_ends_at <> private.trial_end_for(now()) or w.onboarding_completed_at is null then raise exception 'trial_not_started_at_onboarding'; end if;
  if (w.trial_ends_at at time zone 'America/Argentina/Buenos_Aires') <> ((select today from pl) + 31)::timestamp then raise exception 'trial_does_not_end_at_local_midnight'; end if;
  if (select count(*) from public.audit_events where workspace_id=w.id and action='trial_started') <> 1 then raise exception 'trial_started_audit_wrong'; end if;
  if private.start_workspace_trial(w.id) then raise exception 'trial_restarted'; end if;
end $$;

-- ===== 4 y 5. Prueba vencida: Free, con todos los datos donde estaban =====
create temp table pl_before as select
  (select count(*) from public.services where workspace_id=(select w3 from pl)) services,
  (select count(*) from public.availability_rules where workspace_id=(select w3 from pl)) rules,
  (select count(*) from public.automation_rules where workspace_id=(select w3 from pl)) automation_rules,
  (select count(*) from public.professionals where workspace_id=(select w3 from pl)) professionals;
-- En el instante exacto de trial_ends_at ya es Free.
update public.workspaces set trial_started_at=now()-interval '31 days',trial_ends_at=now() where id=(select w3 from pl);
set local role authenticated;
do $$ declare a jsonb := public.workspace_access((select w3 from pl)); begin
  if a->>'tier' <> 'free' or (a->>'has_pro_access')::boolean or a->'trial_days_remaining' <> 'null'::jsonb or a->>'trial_started_at' is null then raise exception 'expired_trial_access_wrong: %', a; end if;
  -- 6. Free conserva la operación básica (agenda, pacientes, cobros manuales, notas, reserva) y nada de Pro:
  -- ni seguimientos, ni CRM, ni automatizaciones, ni Mercado Pago.
  if pg_temp.caps((select w3 from pl)) <> 'external_payment_link,manual_appointments,manual_patients,manual_payments,patient_notes,public_booking'
    then raise exception 'free_capabilities_wrong: %', pg_temp.caps((select w3 from pl)); end if;
  -- Terminar el onboarding de nuevo no vuelve a dar la prueba.
  perform public.complete_bellis_onboarding('{"service":"Consulta","description":"","price":"25000","duration":"60","mode":"Online","start":"09:00","end":"18:00","notice":"24","buffer":"15","days":[true,true,true,true,true,false,false]}'::jsonb);
end $$;
reset role;
do $$ begin
  if private.start_workspace_trial((select w3 from pl)) or private.workspace_tier((select w3 from pl)) <> 'free' then raise exception 'expired_trial_restarted'; end if;
  if (select (services,rules,automation_rules,professionals) from pl_before) is distinct from (select (
    (select count(*) from public.services where workspace_id=(select w3 from pl)),(select count(*) from public.availability_rules where workspace_id=(select w3 from pl)),
    (select count(*) from public.automation_rules where workspace_id=(select w3 from pl)),(select count(*) from public.professionals where workspace_id=(select w3 from pl))))
    then raise exception 'data_changed_when_trial_ended'; end if;
  -- El vencimiento no deja eventos: se resuelve por fecha.
  if (select count(*) from public.audit_events where workspace_id=(select w3 from pl) and action in ('trial_started','plan_changed','pro_activated')) <> 1 then raise exception 'expiry_wrote_events'; end if;
end $$;

-- ===== 6. En Free se trabaja a mano: paciente, turno, cobro, cancelación y nota. Los seguimientos son de Pro =====
-- W1 con la prueba vencida.
update public.workspaces set trial_started_at=now()-interval '40 days',trial_ends_at=now()-interval '9 days' where id=(select w1 from pl);
set local role authenticated;
select pg_temp.as_user((select u1 from pl));
select public.save_questionnaire((select svc from pl),
'{"title":"Preconsulta","sections":[{"key":"situation","label":"Situación"},{"key":"problem","label":"Problema"},{"key":"implication","label":"Implicación"},{"key":"need","label":"Necesidad"}],"questions":[{"client_id":"one","section":"situation","title":"¿Qué necesitás?","type":"text","options":[],"required":true,"active":true}]}'::jsonb);
do $$ declare f record; v_patient uuid; v_slot timestamptz; v_paid uuid; v_pending uuid; begin
  select * into f from pl;
  if (public.workspace_access(f.w1)->>'tier') <> 'free' then raise exception 'w1_should_be_free'; end if;
  v_patient := public.create_manual_patient(f.w1,'Prueba','Plan','+5491155552701','h27-patient@example.invalid','Nota de alta');
  select s.starts_at into v_slot from public.manual_available_slots(f.pro,f.svc,f.today + 7) s order by 1 limit 1;
  v_pending := public.create_manual_appointment(f.pro,v_patient,f.svc,v_slot);
  perform public.record_offline_payment(v_pending,'transfer',2400000);
  select s.starts_at into v_slot from public.manual_available_slots(f.pro,f.svc,f.today + 8) s order by 1 limit 1;
  v_paid := public.create_manual_appointment(f.pro,v_patient,f.svc,v_slot,'cash',2500000);
  perform public.cancel_manual_appointment(v_paid,'no_payment');
  insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w1,v_patient,f.u1,'Nota en Free');
  insert into pl_ids values('patient',v_patient);
  -- Crear un seguimiento en Free se rechaza en la tabla misma, por cualquier camino.
  perform pg_temp.fails(format('insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by) values(%L,%L,%L,%L,%L,%L)',
    f.w1,v_patient,f.pro,'Llamar',f.today + 1,f.u1),'pro_access_required');
  if exists(select 1 from public.patient_follow_ups where workspace_id=f.w1) then raise exception 'free_created_follow_up'; end if;
  if (select count(*) from public.payments p join public.booking_intents i on i.id=p.booking_intent_id where i.patient_id=v_patient and p.provider='offline' and p.status='approved') <> 2
    or (select status from public.appointments where id=v_paid) <> 'cancelled' then raise exception 'manual_work_failed_in_free'; end if;

  -- ===== 7. Free no puede usar Mercado Pago =====
  -- Elegirlo como medio de cobro se rechaza; el link externo sigue disponible.
  perform pg_temp.fails(format('update public.workspaces set payment_provider=%L where id=%L','mercado_pago_ar',f.w1),'pro_access_required');
  update public.workspaces set external_payment_url='https://pagos.example/h27-nuevo' where id=f.w1;
  update public.workspaces set payment_provider='external_link' where id=f.w1;
end $$;
set local role service_role;
do $$ declare f record; q uuid; v_intent uuid; v_patients integer; begin
  select * into f from pl;
  select qq.id into q from public.questionnaire_questions qq join public.questionnaires form on form.id=qq.questionnaire_id where form.service_id=f.svc limit 1;
  insert into pl_ids values('question',q);
  if public.workspace_capability(f.w1,'mercado_pago') or not public.workspace_capability(f.w1,'external_payment_link') then raise exception 'server_capability_wrong'; end if;
  -- Conectar una cuenta: rechazado al empezar y al guardar.
  perform pg_temp.fails(format('select public.start_mercado_pago_oauth(%L,%L)',f.u1,repeat('a',64)),'pro_access_required');
  perform pg_temp.fails(format('select public.store_mercado_pago_connection(%L,%L,%L,%L,%L,now()+interval %L,%L)',f.w1,f.u1,'12345','access-token-h27','refresh-token-h27','6 hours','test'),'pro_access_required');
  -- 18. Con la prueba vencida la reserva pública con link de pago sigue funcionando.
  v_intent := public.create_checkout_intent(f.svc,'Prueba','Publica','h27-public@example.invalid','+5491155552702',
    jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta')),repeat('1',64));
  if (select provider from public.payments where booking_intent_id=v_intent) <> 'external_link' then raise exception 'free_public_booking_failed'; end if;
end $$;
reset role;
-- Un workspace Free que había quedado con Mercado Pago como medio: no se crea ningún checkout nuevo, y no queda
-- ni paciente ni solicitud del intento.
alter table public.workspaces disable trigger workspace_mercado_pago_guard;
update public.workspaces set payment_provider='mercado_pago_ar' where id=(select w1 from pl);
alter table public.workspaces enable trigger workspace_mercado_pago_guard;
set local role service_role;
do $$ declare f record; q uuid := (select id from pl_ids where tag='question'); v_patients integer; v_intents integer; begin
  select * into f from pl;
  select count(*) into v_patients from public.patients where workspace_id=f.w1;
  select count(*) into v_intents from public.booking_intents where workspace_id=f.w1;
  perform pg_temp.fails(format('select public.create_checkout_intent(%L,%L,%L,%L,%L,%L::jsonb,%L)',f.svc,'Prueba','Bloqueada','h27-blocked@example.invalid','+5491155552703',
    jsonb_build_array(jsonb_build_object('question_id',q,'answer','Consulta'))::text,repeat('2',64)),'pro_access_required');
  if (select count(*) from public.patients where workspace_id=f.w1) <> v_patients or (select count(*) from public.booking_intents where workspace_id=f.w1) <> v_intents
    then raise exception 'blocked_checkout_left_rows'; end if;
end $$;
reset role;

-- ===== 17. 'suspended' sigue siendo lo único que deja al workspace sin atender =====
update public.workspaces set status='suspended',payment_provider='external_link' where id=(select w1 from pl);
set local role service_role;
do $$ declare f record; begin
  select * into f from pl;
  perform pg_temp.fails(format('select public.create_checkout_intent(%L,%L,%L,%L,%L,%L::jsonb,%L)',f.svc,'Prueba','Suspendida','h27-suspended@example.invalid','+5491155552704',
    jsonb_build_array(jsonb_build_object('question_id',(select id from pl_ids where tag='question'),'answer','Consulta'))::text,repeat('3',64)),'workspace_unavailable');
end $$;
reset role;
update public.workspaces set status='active' where id=(select w1 from pl);

-- ===== 13 a 15. Activación manual de Bellis Pro =====
do $$ declare f record; begin
  select * into f from pl;
  perform pg_temp.fails(format('select private.admin_set_workspace_plan(%L,%L)',f.w1,'pro'),'pro_ends_at_required');
  perform pg_temp.fails(format('select private.admin_set_workspace_plan(%L,%L,now()-interval %L)',f.w1,'pro','1 day'),'pro_ends_at_required');
  perform pg_temp.fails(format('select private.admin_set_workspace_plan(%L,%L,now()+interval %L)',f.w1,'gold','30 days'),'invalid_plan');
  perform pg_temp.fails(format('select private.admin_set_workspace_plan(%L,%L,now()+interval %L)',gen_random_uuid(),'pro','30 days'),'workspace_not_found');
  if private.admin_set_workspace_plan(f.w1,'pro',now()+interval '30 days') <> 'pro_activated' then raise exception 'pro_not_activated'; end if;
  -- La misma llamada otra vez no cambia nada; con otra fecha, extiende y conserva el inicio.
  if private.admin_set_workspace_plan(f.w1,'pro',now()+interval '30 days') <> 'unchanged' then raise exception 'activation_not_idempotent'; end if;
  if private.admin_set_workspace_plan(f.w1,'pro',now()+interval '60 days') <> 'plan_changed' then raise exception 'pro_not_extended'; end if;
  if (select pro_started_at <> now() or pro_ends_at <> now()+interval '60 days' or plan_code <> 'pro' from public.workspaces where id=f.w1) then raise exception 'pro_window_wrong'; end if;
  if private.workspace_tier(f.w1) <> 'pro' or not private.workspace_has_capability(f.w1,'mercado_pago') or not private.workspace_has_capability(f.w1,'automations')
    or not private.workspace_has_capability(f.w1,'manual_patients') or private.workspace_has_capability(f.w1,'does_not_exist') then raise exception 'pro_capabilities_wrong'; end if;
  if (select count(*) from public.audit_events where workspace_id=f.w1 and action='pro_activated') <> 1
    or (select count(*) from public.audit_events where workspace_id=f.w1 and action='plan_changed') <> 1 then raise exception 'plan_audit_wrong'; end if;
  -- La prueba que ya había tenido no se toca al pasar a Pro.
  if (select trial_started_at from public.workspaces where id=f.w1) <> now()-interval '40 days' then raise exception 'trial_dates_changed_by_pro'; end if;
end $$;

-- ===== 8. Un pago de Mercado Pago iniciado con Pro se termina aunque Pro venza en el medio =====
set local role authenticated;
select pg_temp.as_user((select u1 from pl));
-- Con Pro, los seguimientos vuelven a funcionar: se crea uno que después tiene que sobrevivir al vencimiento.
do $$ declare f record; v_id uuid; begin
  select * into f from pl;
  insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by)
  values(f.w1,(select id from pl_ids where tag='patient'),f.pro,'Llamar para reprogramar',f.today + 1,f.u1) returning id into v_id;
  insert into pl_ids values('follow_up',v_id);
end $$;
-- Con Pro, elegir Mercado Pago vuelve a estar permitido.
update public.workspaces set payment_provider='mercado_pago_ar' where id=(select w1 from pl);
set local role service_role;
do $$ declare f record; v_intent uuid; begin
  select * into f from pl;
  v_intent := public.create_checkout_intent(f.svc,'Prueba','Paga','h27-mp@example.invalid','+5491155552705',
    jsonb_build_array(jsonb_build_object('question_id',(select id from pl_ids where tag='question'),'answer','Consulta')),repeat('4',64));
  perform public.set_mercado_pago_preference(v_intent,'pref-h27');
  insert into pl_ids values('mp_intent',v_intent);
  if public.start_mercado_pago_oauth(f.u1,repeat('b',64)) <> f.w1 then raise exception 'pro_cannot_connect_mercado_pago'; end if;
end $$;
reset role;
-- Pro vence: sin escribir nada más que la fecha.
update public.workspaces set pro_started_at=now()-interval '31 days',pro_ends_at=now() where id=(select w1 from pl);
set local role service_role;
do $$ declare f record; v_intent uuid := (select id from pl_ids where tag='mp_intent'); v_slot timestamptz; begin
  select * into f from pl;
  if public.workspace_capability(f.w1,'mercado_pago') then raise exception 'expired_pro_still_has_mercado_pago'; end if;
  -- El webhook llega después del vencimiento: el pago se registra igual y el paciente elige su horario.
  if not public.record_mercado_pago_payment(v_intent,'pref-h27','2701','h27-approved','approved',2500000,'ARS') then raise exception 'late_webhook_ignored'; end if;
  if (select status from public.payments where booking_intent_id=v_intent) <> 'approved' or (select provider from public.payments where booking_intent_id=v_intent) <> 'mercado_pago_ar'
    or (select status from public.booking_intents where id=v_intent) <> 'awaiting_schedule' then raise exception 'started_payment_not_finished'; end if;
  select s.starts_at into v_slot from public.available_slots_for_intent(v_intent,f.today + 9) s order by 1 limit 1;
  if v_slot is null or public.schedule_paid_intent(v_intent,v_slot) is null then raise exception 'paid_patient_cannot_schedule'; end if;
  -- Pero no se abre otro checkout, y la conexión guardada sigue ahí.
  perform pg_temp.fails(format('select public.create_checkout_intent(%L,%L,%L,%L,%L,%L::jsonb,%L)',f.svc,'Prueba','Tarde','h27-late@example.invalid','+5491155552706',
    jsonb_build_array(jsonb_build_object('question_id',(select id from pl_ids where tag='question'),'answer','Consulta'))::text,repeat('5',64)),'pro_access_required');
end $$;
reset role;
-- Sin Pro, el seguimiento que ya existía sigue ahí y se puede leer, pero no se puede completar ni editar.
set local role authenticated;
select pg_temp.as_user((select u1 from pl));
do $$ declare v_id uuid := (select id from pl_ids where tag='follow_up'); begin
  perform pg_temp.fails(format('update public.patient_follow_ups set status=%L where id=%L','completed',v_id),'pro_access_required');
  perform pg_temp.fails(format('update public.patient_follow_ups set title=%L where id=%L','Otro título',v_id),'pro_access_required');
  if (select status || ':' || title from public.patient_follow_ups where id=v_id) is distinct from 'pending:Llamar para reprogramar' then raise exception 'follow_up_lost_or_changed_on_downgrade'; end if;
  -- Las notas no dependen del plan.
  insert into public.patient_notes(workspace_id,patient_id,author_id,content) values((select w1 from pl),(select id from pl_ids where tag='patient'),(select u1 from pl),'Nota después de bajar a Free');
end $$;
reset role;
do $$ begin
  if not exists(select 1 from private.mercado_pago_accounts where workspace_id=(select w1 from pl) and active) then raise exception 'connection_deleted_on_downgrade'; end if;
  if private.workspace_tier((select w1 from pl)) <> 'free' or (select plan_code from public.workspaces where id=(select w1 from pl)) <> 'pro' then raise exception 'expired_pro_should_resolve_free_without_writes'; end if;
end $$;

-- ===== 9 a 12. Automatizaciones =====
-- Turnos ya atendidos de dos pacientes, con su solicitud. `tag` distingue cada uno.
create function pg_temp.completed_turn(p_tag text,p_hours_ago integer) returns uuid language plpgsql as $$
declare f record; v_patient uuid := gen_random_uuid(); v_intent uuid := gen_random_uuid(); v_id uuid; begin
  select * into f from pl;
  insert into public.patients(id,workspace_id,first_name,last_name,email) values(v_patient,f.w1,'Prueba',p_tag,'h27-' || p_tag || '@example.invalid');
  insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes,expires_at)
  values(v_intent,f.w1,f.pro,f.svc,v_patient,'scheduled',2500000,60,now()+interval '3 days');
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
  values(f.w1,v_intent,f.pro,v_patient,now()-make_interval(hours=>p_hours_ago),now()-make_interval(hours=>p_hours_ago)+interval '1 hour','scheduled') returning id into v_id;
  update public.appointments set status='completed' where id=v_id;
  insert into pl_ids values(p_tag,v_id);
  return v_id;
end $$;
-- 9. En Free un turno atendido no encola nada, ni por el trigger ni por el repaso de cada hora.
select pg_temp.completed_turn('free-turn',30);
-- Quedó atendido dos horas antes de que el workspace vuelva a tener Pro.
update public.appointments set status_changed_at=now()-interval '2 hours' where id=(select id from pl_ids where tag='free-turn');
select private.enqueue_automation_candidates();
do $$ begin
  if exists(select 1 from public.automation_runs where reference_id=(select id from pl_ids where tag='free-turn')) then raise exception 'free_enqueued_automations'; end if;
end $$;
-- Con Pro, sí. Dos turnos: uno cuya ejecución va a llegar a su hora y otro que queda para más adelante.
select private.admin_set_workspace_plan((select w1 from pl),'pro',now()+interval '30 days');
-- Y el seguimiento que había quedado en pausa se puede completar: el historial volvió intacto.
set local role authenticated;
select pg_temp.as_user((select u1 from pl));
update public.patient_follow_ups set status='completed' where id=(select id from pl_ids where tag='follow_up');
reset role;
do $$ begin
  if (select status from public.patient_follow_ups where id=(select id from pl_ids where tag='follow_up')) <> 'completed' then raise exception 'follow_up_not_usable_after_upgrade'; end if;
end $$;
select pg_temp.completed_turn('due-turn',3);
select pg_temp.completed_turn('future-turn',6);
do $$ declare f record; begin
  select * into f from pl;
  if (select count(*) from public.automation_runs where workspace_id=f.w1 and reference_id in (select id from pl_ids where tag in ('due-turn','future-turn'))) < 2
    then raise exception 'pro_did_not_enqueue'; end if;
  -- Lo que pasó mientras estaba en Free no se dispara al volver a Pro.
  perform private.enqueue_automation_candidates();
  if exists(select 1 from public.automation_runs where workspace_id=f.w1 and reference_id=(select id from pl_ids where tag='free-turn')) then raise exception 'free_period_event_enqueued_later'; end if;
end $$;
update public.automation_runs set scheduled_for=now()-interval '1 second' where reference_id=(select id from pl_ids where tag='due-turn');
update public.automation_runs set scheduled_for=now()+interval '10 days' where reference_id=(select id from pl_ids where tag='future-turn');
create temp table pl_runs as select
  (select count(*) from public.automation_runs where workspace_id=(select w1 from pl)) total,
  (select count(*) from public.patient_follow_ups where workspace_id=(select w1 from pl)) follow_ups,
  (select count(*) from public.automation_rules where workspace_id=(select w1 from pl) and enabled) rules;
-- Pro vence antes de que llegue la hora.
update public.workspaces set pro_started_at=now()-interval '31 days',pro_ends_at=now() where id=(select w1 from pl);
select private.run_automation_cycle();
do $$ declare f record; begin
  select * into f from pl;
  -- 10. Las que llegaron a su hora quedan 'skipped' con la razón estable, sin crear seguimientos.
  if exists(select 1 from public.automation_runs where reference_id=(select id from pl_ids where tag='due-turn')
    and (status <> 'skipped' or result->>'reason' <> 'pro_access_required' or executed_at is null or follow_up_id is not null)) then raise exception 'due_run_not_skipped'; end if;
  -- 11. Las que todavía no llegaron a su hora se conservan tal cual.
  if exists(select 1 from public.automation_runs where reference_id=(select id from pl_ids where tag='future-turn') and (status <> 'scheduled' or executed_at is not null))
    then raise exception 'future_run_discarded_early'; end if;
  -- Nada se borra: mismas ejecuciones, mismas reglas activas, ningún seguimiento nuevo.
  if (select (total,follow_ups,rules) from pl_runs) is distinct from (select ((select count(*) from public.automation_runs where workspace_id=f.w1),
    (select count(*) from public.patient_follow_ups where workspace_id=f.w1),(select count(*) from public.automation_rules where workspace_id=f.w1 and enabled)))
    then raise exception 'automation_history_changed'; end if;
  if not exists(select 1 from public.audit_events where workspace_id=f.w1 and action='automation_run_skipped') then raise exception 'skip_not_audited'; end if;
end $$;
-- Reintentar a mano en Free: rechazado.
update public.automation_runs set status='failed',executed_at=now(),error_message='smoke' where id=(select id from public.automation_runs
  where reference_id=(select id from pl_ids where tag='due-turn') order by id limit 1);
insert into pl_ids select 'failed-run',id from public.automation_runs where reference_id=(select id from pl_ids where tag='due-turn') and status='failed';
set local role authenticated;
select pg_temp.as_user((select u1 from pl));
select pg_temp.fails(format('select public.retry_failed_automation_run(%L)',(select id from pl_ids where tag='failed-run')),'pro_access_required');
reset role;
-- 12. Vuelve a Pro: lo descartado no revive ni se vuelve a encolar; la que seguía en cola se ejecuta a su hora;
-- un evento nuevo genera una ejecución nueva.
select private.admin_set_workspace_plan((select w1 from pl),'pro',now()+interval '30 days');
select private.run_automation_cycle();
do $$ declare f record; begin
  select * into f from pl;
  if (select count(*) from public.automation_runs where workspace_id=f.w1) <> (select total from pl_runs) then raise exception 'skipped_runs_enqueued_again'; end if;
  if exists(select 1 from public.automation_runs where reference_id=(select id from pl_ids where tag='due-turn') and status not in ('skipped','failed')) then raise exception 'skipped_run_revived'; end if;
  if exists(select 1 from public.automation_runs where reference_id=(select id from pl_ids where tag='future-turn') and status <> 'scheduled') then raise exception 'future_run_lost'; end if;
end $$;
select pg_temp.completed_turn('new-turn',9);
update public.automation_runs set scheduled_for=now()-interval '1 second' where reference_id in (select id from pl_ids where tag in ('new-turn','future-turn'));
select private.run_automation_cycle();
do $$ begin
  if not exists(select 1 from public.automation_runs where reference_id=(select id from pl_ids where tag='new-turn')) then raise exception 'new_event_not_enqueued'; end if;
  if exists(select 1 from public.automation_runs where reference_id in (select id from pl_ids where tag in ('new-turn','future-turn')) and (status = 'scheduled' or result->>'reason' = 'pro_access_required'))
    then raise exception 'pro_did_not_execute_runs'; end if;
end $$;
-- Volver a Free a mano: queda la historia de cuándo fue Pro.
update public.workspaces set pro_started_at=now()-interval '1 day' where id=(select w1 from pl);
do $$ declare f record; begin
  select * into f from pl;
  if private.admin_set_workspace_plan(f.w1,'free') <> 'plan_changed' or private.admin_set_workspace_plan(f.w1,'free') <> 'unchanged' then raise exception 'downgrade_wrong'; end if;
  if private.workspace_tier(f.w1) <> 'free' or (select pro_started_at is null or pro_ends_at <> now() from public.workspaces where id=f.w1) then raise exception 'downgrade_lost_history'; end if;
end $$;

-- ===== 16. "Quiero Bellis Pro" =====
set local role authenticated;
select pg_temp.as_user((select u1 from pl));
do $$ declare f record; a jsonb; b jsonb; begin
  select * into f from pl;
  if (public.workspace_access(f.w1)->>'upgrade_requested')::boolean then raise exception 'request_before_asking'; end if;
  a := public.request_pro_upgrade(f.w1); b := public.request_pro_upgrade(f.w1);
  if not (a->>'created')::boolean or (b->>'created')::boolean or a->>'requested_at' <> b->>'requested_at' or b->>'status' <> 'open' then raise exception 'upgrade_request_duplicated: % %', a, b; end if;
  if not (public.workspace_access(f.w1)->>'upgrade_requested')::boolean then raise exception 'request_not_visible_to_owner'; end if;
  -- Pedirlo no activa nada.
  if (public.workspace_access(f.w1)->>'tier') <> 'free' then raise exception 'request_activated_pro'; end if;
  perform pg_temp.fails(format('select public.request_pro_upgrade(%L)',f.w2),'not_authorized');
  perform pg_temp.fails('select count(*) from public.plan_upgrade_requests','42501');
end $$;
select pg_temp.as_user(null);
select pg_temp.fails(format('select public.workspace_access(%L)',(select w1 from pl)),'authentication_required');
reset role;
do $$ declare f record; begin
  select * into f from pl;
  if (select count(*) from public.plan_upgrade_requests where workspace_id=f.w1) <> 1
    or (select contact_email <> 'h27-plan-1@example.invalid' or requested_by <> f.u1 or status <> 'open' or resolved_at is not null from public.plan_upgrade_requests where workspace_id=f.w1)
    then raise exception 'upgrade_request_wrong'; end if;
  -- Cerrado el pedido, se puede volver a pedir.
  update public.plan_upgrade_requests set status='resolved',resolved_at=now() where workspace_id=f.w1;
end $$;
set local role authenticated;
select pg_temp.as_user((select u1 from pl));
do $$ begin
  if not (public.request_pro_upgrade((select w1 from pl))->>'created')::boolean then raise exception 'cannot_ask_again_after_resolution'; end if;
end $$;
reset role;
select pg_temp.as_user(null);
-- Los datos cargados a mano siguen todos, después de haber pasado por prueba vencida, Pro, vencimiento y Free.
do $$ begin
  if (select count(*) from public.appointments a join public.booking_intents i on i.id=a.booking_intent_id where i.patient_id=(select id from pl_ids where tag='patient')) <> 2
    or (select count(*) from public.patient_notes where patient_id=(select id from pl_ids where tag='patient')) < 1
    or (select count(*) from public.payments where workspace_id=(select w1 from pl) and provider='mercado_pago_ar' and status='approved') <> 1
    then raise exception 'data_lost_across_plan_changes'; end if;
end $$;
select string_agg(private.workspace_tier(id), ',' order by slug) as tiers from public.workspaces
where id in ((select w1 from pl),(select w2 from pl),(select w3 from pl));
rollback;
