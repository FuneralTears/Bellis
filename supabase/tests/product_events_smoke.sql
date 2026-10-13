-- H2.8A Eventos de producto: qué se registra, qué no, y quién puede tocarlos.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('fa100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-pe-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('fa100000-0000-4000-8000-000000000001','admin',true),('fa100000-0000-4000-8000-000000000002','support',true),('fa100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'fa100000-0000-4000-8000-000000000001'::uuid u1,'fa100000-0000-4000-8000-000000000002'::uuid u2,'fa100000-0000-4000-8000-000000000003'::uuid u3,'fa100000-0000-4000-8000-000000000004'::uuid u4,'fa100000-0000-4000-8000-000000000005'::uuid u5,'fa100000-0000-4000-8000-000000000006'::uuid u6,
  'fa100000-0000-4000-8000-0000000000a1'::uuid w1,'fa100000-0000-4000-8000-0000000000a2'::uuid w2,'fa100000-0000-4000-8000-0000000000a3'::uuid w3,
  'fa100000-0000-4000-8000-0000000000b1'::uuid pr1,'fa100000-0000-4000-8000-0000000000b2'::uuid pr2,'fa100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'fa100000-0000-4000-8000-0000000000c1'::uuid s1,'fa100000-0000-4000-8000-0000000000c3'::uuid s3,
  'fa100000-0000-4000-8000-0000000000d1'::uuid p1,'fa100000-0000-4000-8000-0000000000d2'::uuid p2,'fa100000-0000-4000-8000-0000000000e1'::uuid i1,'fa100000-0000-4000-8000-0000000000e2'::uuid i2;
grant select on fx to authenticated,anon;
create temp table memo(tag text primary key,value jsonb);
grant select,insert,update on memo to authenticated;
create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub',coalesce(p_user::text,''),true) $$;
-- Espera que una llamada falle con ese mensaje o ese código exacto.
create function pg_temp.fails(p_sql text,p_error text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm <> p_error and sqlstate <> p_error then raise exception 'expected % but got % (%): %', p_error, sqlerrm, sqlstate, p_sql; end if; return; end;
  raise exception 'expected % but it succeeded: %', p_error, p_sql;
end $$;

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('fa100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-pe-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-pe-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-pe-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-pe-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-pe-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-pe-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-pe-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-pe'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

create function pg_temp.n(p_event text,p_workspace uuid) returns integer language sql as $$
  select count(*)::integer from public.product_events where event_name=p_event and workspace_id=p_workspace $$;

-- ===== Alta, onboarding, prueba y Pro =====
do $$ declare f record; begin
  select * into f from fx;
  if pg_temp.n('user_registered',f.w1) <> 1 or pg_temp.n('user_registered',f.w2) <> 1 then raise exception 'user_registered_missing'; end if;
  if (select user_id from public.product_events where event_name='user_registered' and workspace_id=f.w1) <> f.u3 then raise exception 'user_registered_wrong_user'; end if;
  if pg_temp.n('onboarding_completed',f.w1) <> 1 or pg_temp.n('onboarding_completed',f.w2) <> 0 then raise exception 'onboarding_completed_wrong'; end if;
  if pg_temp.n('trial_started',f.w1) <> 1 or pg_temp.n('trial_started',f.w2) <> 0 or pg_temp.n('trial_started',f.w3) <> 0 then raise exception 'trial_started_wrong'; end if;
  if pg_temp.n('pro_activated',f.w3) <> 1 or pg_temp.n('pro_activated',f.w1) <> 0 then raise exception 'pro_activated_wrong'; end if;
  -- Extender el mismo período de Pro no es una activación nueva.
  update public.workspaces set pro_ends_at=now()+interval '60 days' where id=f.w3;
  if pg_temp.n('pro_activated',f.w3) <> 1 then raise exception 'extension_counted_as_activation'; end if;
  -- Completar el onboarding después del registro.
  update public.workspaces set onboarding_completed_at=now() where id=f.w2;
  if pg_temp.n('onboarding_completed',f.w2) <> 1 then raise exception 'late_onboarding_missing'; end if;
  update public.workspaces set name='H28smoke Dos bis' where id=f.w2;
  if pg_temp.n('onboarding_completed',f.w2) <> 1 then raise exception 'onboarding_repeated'; end if;
end $$;

insert into public.patients(id,workspace_id,first_name,last_name,email,created_by)
select p1,w1,'Zzsecreto','Manual','h28-pe-p1@example.invalid',u3 from fx union all select p2,w1,'Zzsecreto','Publico','h28-pe-p2@example.invalid',null from fx;
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes,expires_at,source,created_by)
select i1,w1,pr1,s1,p1,'scheduled'::public.booking_status,1000000,60,now()+interval '1 day','manual',u3 from fx
union all select i2,w1,pr1,s1,p2,'scheduled',1000000,60,now()+interval '1 day','public',null from fx;
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i1,pr1,p1,now()+interval '2 days',now()+interval '2 days 1 hour','scheduled'::public.booking_status from fx
union all select w1,i2,pr1,p2,now()+interval '3 days',now()+interval '3 days 1 hour','scheduled' from fx;
insert into public.patient_notes(workspace_id,patient_id,author_id,content) select w1,p1,u3,'Zzsecreto nota clínica' from fx;
insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,description,due_date,created_by)
select w1,p1,pr1,'Zzsecreto seguimiento','Zzsecreto detalle',current_date+1,u3 from fx;

-- ===== Pacientes, turnos, seguimientos =====
do $$ declare f record; begin
  select * into f from fx;
  if pg_temp.n('patient_created',f.w1) <> 2 then raise exception 'patient_created_wrong'; end if;
  if (select string_agg(metadata->>'source',',' order by metadata->>'source') from public.product_events where event_name='patient_created' and workspace_id=f.w1) <> 'manual,public'
    then raise exception 'patient_source_wrong'; end if;
  if pg_temp.n('appointment_created',f.w1) <> 2 or pg_temp.n('public_booking_completed',f.w1) <> 1 then raise exception 'appointment_events_wrong'; end if;
  if (select entity_id from public.product_events where event_name='public_booking_completed' and workspace_id=f.w1)
     <> (select id from public.appointments where booking_intent_id=f.i2) then raise exception 'public_booking_wrong_entity'; end if;
  if pg_temp.n('followup_created',f.w1) <> 1 then raise exception 'followup_created_wrong'; end if;
  -- Una nota: se anota que se escribió, quién y cuándo. Nada de lo que dice.
  if pg_temp.n('patient_note_created',f.w1) <> 1 then raise exception 'patient_note_created_wrong'; end if;
  if (select e.user_id <> f.u3 or e.entity_type <> 'patient_note' or e.metadata <> '{}'::jsonb or e.entity_id <> (select id from public.patient_notes where workspace_id=f.w1)
      from public.product_events e where e.event_name='patient_note_created' and e.workspace_id=f.w1) then raise exception 'patient_note_event_wrong'; end if;
  -- Editar la nota no es otro evento.
  update public.patient_notes set content='Zzsecreto nota corregida' where workspace_id=f.w1;
  if pg_temp.n('patient_note_created',f.w1) <> 1 then raise exception 'note_edit_counted'; end if;
  if exists(select 1 from public.product_events where workspace_id=f.w1 and entity_type not in ('workspace','patient','appointment','follow_up','automation_rule','upgrade_request','payment','patient_note'))
    then raise exception 'unexpected_entity'; end if;
end $$;

-- ===== Cobros, turnos atendidos y cancelados =====
do $$ declare f record; v_payment uuid; begin
  select * into f from fx;
  -- Un pago pendiente todavía no es un cobro.
  insert into public.payments(workspace_id,booking_intent_id,provider,amount_minor,status) values(f.w1,f.i1,'external_link',1234500,'pending') returning id into v_payment;
  if pg_temp.n('payment_recorded',f.w1) <> 0 then raise exception 'pending_payment_counted'; end if;
  update public.payments set status='approved',approved_at=now() where id=v_payment;
  if pg_temp.n('payment_recorded',f.w1) <> 1 then raise exception 'payment_recorded_missing'; end if;
  update public.payments set manual_reference='Zzsecreto referencia' where id=v_payment;
  if pg_temp.n('payment_recorded',f.w1) <> 1 then raise exception 'payment_recorded_repeated'; end if;
  -- Solo el medio: ni el monto ni la referencia.
  if (select e.metadata <> '{"provider":"external_link"}'::jsonb or e.entity_type <> 'payment' or e.entity_id <> v_payment or to_jsonb(e)::text ~ '1234500'
      from public.product_events e where e.event_name='payment_recorded' and e.workspace_id=f.w1) then raise exception 'payment_event_wrong'; end if;
  -- Un pago que entra ya aprobado (Mercado Pago) también cuenta.
  insert into public.payments(workspace_id,booking_intent_id,provider,amount_minor,status,approved_at) values(f.w1,f.i2,'mercado_pago_ar',1000000,'approved',now());
  if pg_temp.n('payment_recorded',f.w1) <> 2 then raise exception 'approved_insert_not_counted'; end if;

  if pg_temp.n('appointment_completed',f.w1) <> 0 or pg_temp.n('appointment_cancelled',f.w1) <> 0 then raise exception 'status_events_too_early'; end if;
  update public.appointments set status='completed' where booking_intent_id=f.i1;
  update public.appointments set notes='Zzsecreto motivo' where booking_intent_id=f.i1;
  if pg_temp.n('appointment_completed',f.w1) <> 1 then raise exception 'appointment_completed_wrong %', pg_temp.n('appointment_completed',f.w1); end if;
  update public.appointments set status='cancelled',notes='Zzsecreto motivo de cancelación' where booking_intent_id=f.i2;
  if pg_temp.n('appointment_cancelled',f.w1) <> 1 then raise exception 'appointment_cancelled_wrong'; end if;
  if exists(select 1 from public.product_events e where e.workspace_id=f.w1 and e.event_name in ('appointment_completed','appointment_cancelled') and (e.metadata <> '{}'::jsonb or e.entity_type <> 'appointment'))
    then raise exception 'status_event_carries_data'; end if;
  -- Los cuatro son actividad; registrarse, la prueba y el pedido de Pro no.
  if not array['payment_recorded','appointment_completed','appointment_cancelled','patient_note_created'] <@ private.product_activity_events()
    or private.product_activity_events() && array['user_registered','trial_started','trial_expired','upgrade_requested','pro_activated','pro_expired','workspace_suspended']
    then raise exception 'activity_definition_wrong'; end if;
end $$;

-- ===== Automatizaciones y pedido de Pro =====
do $$ declare f record; v_rules integer; begin
  select * into f from fx;
  select count(*) into v_rules from public.automation_rules where workspace_id=f.w1;
  if v_rules = 0 then raise exception 'fixture_without_rules'; end if;
  if pg_temp.n('automation_enabled',f.w1) <> 0 then raise exception 'rules_counted_before_enabling'; end if;
  update public.automation_rules set enabled=true,enabled_at=now() where workspace_id=f.w1;
  if pg_temp.n('automation_enabled',f.w1) <> v_rules then raise exception 'automation_enabled_wrong'; end if;
  update public.automation_rules set enabled=true where workspace_id=f.w1;
  if pg_temp.n('automation_enabled',f.w1) <> v_rules then raise exception 'automation_enabled_repeated'; end if;
end $$;
set local role authenticated;
do $$ declare f record; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u3);
  perform public.request_pro_upgrade(f.w1);
  perform public.request_pro_upgrade(f.w1);
end $$;
reset role;
do $$ declare f record; begin
  select * into f from fx;
  if pg_temp.n('upgrade_requested',f.w1) <> 1 then raise exception 'upgrade_requested_wrong %', pg_temp.n('upgrade_requested',f.w1); end if;
  update public.workspaces set status='suspended' where id=f.w2;
  update public.workspaces set name='H28smoke Dos' where id=f.w2;
  if pg_temp.n('workspace_suspended',f.w2) <> 1 then raise exception 'workspace_suspended_wrong'; end if;
end $$;

-- ===== Vencimientos: por fecha, una sola vez =====
do $$ declare f record; v_end timestamptz := now()-interval '9 days'; begin
  select * into f from fx;
  if pg_temp.n('trial_expired',f.w1) <> 0 then raise exception 'trial_expired_too_early'; end if;
  update public.workspaces set trial_started_at=now()-interval '40 days',trial_ends_at=v_end where id=f.w1;
  update public.workspaces set pro_started_at=now()-interval '40 days',pro_ends_at=now()-interval '2 days' where id=f.w3;
  perform private.record_plan_expirations();
  perform private.record_plan_expirations();
  if pg_temp.n('trial_expired',f.w1) <> 1 or pg_temp.n('pro_expired',f.w3) <> 1 then raise exception 'expirations_wrong'; end if;
  if (select created_at from public.product_events where event_name='trial_expired' and workspace_id=f.w1) <> v_end then raise exception 'expiry_not_dated_when_it_happened'; end if;
  if pg_temp.n('trial_expired',f.w2) <> 0 or pg_temp.n('pro_expired',f.w1) <> 0 then raise exception 'expiry_for_wrong_workspace'; end if;
  -- Un Pro nuevo que vuelve a vencer se anota otra vez: es otro período.
  update public.workspaces set pro_started_at=now()-interval '1 day',pro_ends_at=now()-interval '1 hour' where id=f.w3;
  perform private.record_plan_expirations();
  if pg_temp.n('pro_expired',f.w3) <> 2 then raise exception 'second_expiry_missing'; end if;
end $$;

-- ===== Privacidad: hechos, no contenido =====
do $$ declare f record; begin
  select * into f from fx;
  if exists(select 1 from public.product_events e where e.workspace_id in (f.w1,f.w2,f.w3) and to_jsonb(e)::text ~* 'zzsecreto')
    then raise exception 'clinical_text_in_events'; end if;
  if exists(select 1 from public.product_events e, jsonb_object_keys(e.metadata) k
    where e.workspace_id in (f.w1,f.w2,f.w3) and k not in ('source','provider','ends_at','ended_at','rule','plan','backfilled'))
    then raise exception 'unexpected_metadata_key'; end if;
  -- La tabla no acepta nombres de evento inventados ni metadata grande.
  perform pg_temp.fails(format('insert into public.product_events(event_name,workspace_id) values(%L,%L)','note_read',f.w1),'23514');
  perform pg_temp.fails(format('insert into public.product_events(event_name,workspace_id,metadata) values(%L,%L,jsonb_build_object(%L,repeat(%L,2000)))','patient_created',f.w1,'x','y'),'23514');
  -- Un evento que no se puede anotar no rompe la operación que lo originó.
  perform private.record_product_event('no_such_event',f.w1,null,null,null);
  if exists(select 1 from public.product_events where event_name='no_such_event') then raise exception 'invalid_event_recorded'; end if;
end $$;

-- ===== Permisos =====
do $$ declare v text; begin
  if not (select relrowsecurity from pg_class where oid='public.product_events'::regclass) then raise exception 'product_events_without_rls'; end if;
  if exists(select 1 from pg_policies where schemaname='public' and tablename='product_events') then raise exception 'product_events_has_policies'; end if;
  foreach v in array array['select','insert','update','delete'] loop
    if has_table_privilege('authenticated','public.product_events',v) or has_table_privilege('anon','public.product_events',v) then raise exception 'product_events_exposed %',v; end if;
  end loop;
  if has_table_privilege('service_role','public.product_events','insert') then raise exception 'service_role_can_write_events'; end if;
  foreach v in array array['private.record_product_event(text,uuid,uuid,text,uuid,jsonb,timestamptz)','private.record_plan_expirations()','private.product_activity_events()'] loop
    if has_function_privilege('authenticated',v,'execute') or has_function_privilege('anon',v,'execute') then raise exception 'event_function_exposed %',v; end if;
  end loop;
end $$;
set local role authenticated;
do $$ declare f record; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u3);
  perform pg_temp.fails('select * from public.product_events','42501');
  perform pg_temp.fails(format('insert into public.product_events(event_name,workspace_id) values(%L,%L)','patient_created',f.w1),'42501');
  perform pg_temp.fails('delete from public.product_events','42501');
end $$;
reset role;
select 'product_events_ok' result;
rollback;
