-- H2.8A Detalle de un workspace en el backoffice: cuenta, plan, uso, cobros y línea de tiempo.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f7100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-wd-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f7100000-0000-4000-8000-000000000001','admin',true),('f7100000-0000-4000-8000-000000000002','support',true),('f7100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f7100000-0000-4000-8000-000000000001'::uuid u1,'f7100000-0000-4000-8000-000000000002'::uuid u2,'f7100000-0000-4000-8000-000000000003'::uuid u3,'f7100000-0000-4000-8000-000000000004'::uuid u4,'f7100000-0000-4000-8000-000000000005'::uuid u5,'f7100000-0000-4000-8000-000000000006'::uuid u6,
  'f7100000-0000-4000-8000-0000000000a1'::uuid w1,'f7100000-0000-4000-8000-0000000000a2'::uuid w2,'f7100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f7100000-0000-4000-8000-0000000000b1'::uuid pr1,'f7100000-0000-4000-8000-0000000000b2'::uuid pr2,'f7100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f7100000-0000-4000-8000-0000000000c1'::uuid s1,'f7100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f7100000-0000-4000-8000-0000000000d1'::uuid p1,'f7100000-0000-4000-8000-0000000000d2'::uuid p2,'f7100000-0000-4000-8000-0000000000e1'::uuid i1,'f7100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f7100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-wd-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-wd-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-wd-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-wd-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-wd-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-wd-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-wd-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-wd'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

insert into public.patients(id,workspace_id,first_name,last_name,email,created_by)
select p1,w1,'Zzsecreto','Manual','h28-wd-p1@example.invalid',u3 from fx union all select p2,w1,'Zzsecreto','Publico','h28-wd-p2@example.invalid',null from fx;
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes,expires_at,source,created_by)
select i1,w1,pr1,s1,p1,'scheduled'::public.booking_status,1000000,60,now()+interval '1 day','manual',u3 from fx
union all select i2,w1,pr1,s1,p2,'scheduled',1000000,60,now()+interval '1 day','public',null from fx;
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i1,pr1,p1,now()+interval '2 days',now()+interval '2 days 1 hour','scheduled'::public.booking_status from fx
union all select w1,i2,pr1,p2,now()+interval '3 days',now()+interval '3 days 1 hour','scheduled' from fx;
insert into public.patient_notes(workspace_id,patient_id,author_id,content) select w1,p1,u3,'Zzsecreto nota clínica' from fx;
insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,description,due_date,created_by)
select w1,p1,pr1,'Zzsecreto seguimiento','Zzsecreto detalle',current_date+1,u3 from fx;

update public.automation_rules set enabled=true,enabled_at=now() where workspace_id=(select w1 from fx) and rule_key='first_consultation';
update auth.users set last_sign_in_at=now()-interval '5 hours' where id=(select u3 from fx);
set local role authenticated;
do $$ begin perform pg_temp.as_user((select u3 from fx)); perform public.request_pro_upgrade((select w1 from fx)); end $$;
reset role;

set local role authenticated;
do $$ declare f record; d jsonb; k text; v_events text; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u2);
  d := public.admin_workspace_detail(f.w1);
  foreach k in array array['workspace_id','workspace_name','owner_email','profession','registered_at','onboarding_completed','onboarding_completed_at','status','plan_code','effective_tier',
    'trial_started_at','trial_ends_at','pro_started_at','pro_ends_at','days_remaining','capabilities','last_sign_in_at','last_activity_at','active_7d','active_30d','events_7d','events_30d',
    'patient_count','appointment_count','public_booking_count','followup_count','automation_count','payment_provider','external_link_configured','mercado_pago_connected',
    'booking_available','upgrade_request_open','timeline'] loop
    if not d ? k then raise exception 'detail_missing %', k; end if;
  end loop;
  -- Cuenta y plan.
  if d->>'workspace_name' <> 'H28smoke Uno' or d->>'owner_email' <> 'h28-wd-3@example.invalid' or d->>'profession' <> 'Psicología'
    or not (d->>'onboarding_completed')::boolean or d->>'status' <> 'active' then raise exception 'detail_account_wrong'; end if;
  if d->>'plan_code' <> 'free' or d->>'effective_tier' <> 'pro_trial' or (d->>'days_remaining')::int <> 30 then raise exception 'detail_plan_wrong % % %', d->>'plan_code', d->>'effective_tier', d->>'days_remaining'; end if;
  if not d->'capabilities' ? 'followups' or not d->'capabilities' ? 'mercado_pago' or not d->'capabilities' ? 'manual_patients' then raise exception 'detail_capabilities_wrong'; end if;
  -- Uso.
  if (d->>'patient_count')::int <> 2 or (d->>'appointment_count')::int <> 2 or (d->>'public_booking_count')::int <> 1 or (d->>'followup_count')::int <> 1
    or (d->>'automation_count')::int <> 1 or not (d->>'active_7d')::boolean or (d->>'events_7d')::int < 8 or d->>'last_activity_at' is null then raise exception 'detail_usage_wrong %', d - 'timeline'; end if;
  -- Registro, último acceso y última actividad: tres fechas, cada una con lo suyo.
  if (d->>'last_sign_in_at')::timestamptz <> now()-interval '5 hours' or (d->>'last_activity_at')::timestamptz <> now() or (d->>'registered_at') is null
    then raise exception 'detail_dates_wrong % % %', d->>'registered_at', d->>'last_sign_in_at', d->>'last_activity_at'; end if;
  -- Cobros.
  if d->>'payment_provider' <> 'external_link' or not (d->>'external_link_configured')::boolean or (d->>'mercado_pago_connected')::boolean
    or not (d->>'booking_available')::boolean or not (d->>'upgrade_request_open')::boolean then raise exception 'detail_payments_wrong'; end if;
  -- Línea de tiempo: lo último primero, con todos los tipos de evento que ocurrieron.
  select string_agg(distinct e->>'event_name',',' order by e->>'event_name') into v_events from jsonb_array_elements(d->'timeline') e;
  if v_events <> 'appointment_created,automation_enabled,followup_created,onboarding_completed,patient_created,patient_note_created,public_booking_completed,trial_started,upgrade_requested,user_registered'
    then raise exception 'timeline_events_wrong %', v_events; end if;
  if exists(select 1 from jsonb_array_elements(d->'timeline') with ordinality a(e,n) join jsonb_array_elements(d->'timeline') with ordinality b(e,n) on b.n=a.n+1
    where (a.e->>'created_at')::timestamptz < (b.e->>'created_at')::timestamptz) then raise exception 'timeline_not_newest_first'; end if;
  if exists(select 1 from jsonb_array_elements(d->'timeline') e, jsonb_object_keys(e) field where field not in ('id','event_name','entity_type','metadata','created_at'))
    then raise exception 'timeline_unexpected_field'; end if;
  -- Nada clínico: ni el nombre del paciente, ni la nota, ni el título o el detalle del seguimiento.
  if d::text ~* 'zzsecreto' or d::text ~* 'h28-wd-p1' then raise exception 'clinical_text_in_detail'; end if;

  -- Sin onboarding: Free, sin días, sin capacidades Pro, sin página.
  d := public.admin_workspace_detail(f.w2);
  if (d->>'onboarding_completed')::boolean or d->>'effective_tier' <> 'free' or d->>'days_remaining' is not null or d->'capabilities' ? 'followups'
    or (d->>'booking_available')::boolean or (d->>'active_30d')::boolean or d->>'last_activity_at' is not null or d->>'last_sign_in_at' is not null then raise exception 'detail_incomplete_wrong %', d - 'timeline'; end if;
  -- Pro con Mercado Pago conectado.
  d := public.admin_workspace_detail(f.w3);
  if d->>'effective_tier' <> 'pro' or d->>'plan_code' <> 'pro' or (d->>'days_remaining')::int not in (24,25) or not (d->>'mercado_pago_connected')::boolean
    or not (d->>'booking_available')::boolean or (d->>'external_link_configured')::boolean then raise exception 'detail_pro_wrong %', d - 'timeline'; end if;

  -- Un id que no existe responde igual que a quien no tiene acceso.
  perform pg_temp.fails(format('select public.admin_workspace_detail(%L)','00000000-0000-4000-8000-00000000dead'),'not_found');
  perform pg_temp.fails('select public.admin_workspace_detail(null)','not_found');
  perform pg_temp.as_user(f.u3);
  perform pg_temp.fails(format('select public.admin_workspace_detail(%L)',f.w1),'not_found');
end $$;
reset role;

-- La línea de tiempo muestra como mucho los últimos 50 eventos.
insert into public.product_events(event_name,workspace_id,entity_type,entity_id,created_at)
select 'patient_created',(select w1 from fx),'patient',gen_random_uuid(),now()-make_interval(mins => n) from generate_series(1,80) n;
do $$ declare d jsonb; begin
  perform pg_temp.as_user((select u1 from fx));
  d := private.admin_workspace_detail((select w1 from fx));
  if jsonb_array_length(d->'timeline') <> 50 then raise exception 'timeline_not_capped %', jsonb_array_length(d->'timeline'); end if;
  -- La actividad reciente del producto: con nombre de consultorio, sin nada clínico, con tope.
  d := private.admin_recent_activity(10);
  if jsonb_array_length(d) <> 10 or not (d->0) ? 'workspace_name' or d::text ~* 'zzsecreto' then raise exception 'recent_activity_wrong'; end if;
  if jsonb_array_length(private.admin_recent_activity(100000)) > 100 then raise exception 'recent_activity_not_capped'; end if;
end $$;
select 'admin_workspace_detail_ok' result;
rollback;
