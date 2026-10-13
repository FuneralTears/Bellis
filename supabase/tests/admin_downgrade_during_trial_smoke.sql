-- H2.8A Volver a Bellis Free con la prueba todavía vigente: Free en el acto.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f1100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-dt-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f1100000-0000-4000-8000-000000000001','admin',true),('f1100000-0000-4000-8000-000000000002','support',true),('f1100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f1100000-0000-4000-8000-000000000001'::uuid u1,'f1100000-0000-4000-8000-000000000002'::uuid u2,'f1100000-0000-4000-8000-000000000003'::uuid u3,'f1100000-0000-4000-8000-000000000004'::uuid u4,'f1100000-0000-4000-8000-000000000005'::uuid u5,'f1100000-0000-4000-8000-000000000006'::uuid u6,
  'f1100000-0000-4000-8000-0000000000a1'::uuid w1,'f1100000-0000-4000-8000-0000000000a2'::uuid w2,'f1100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f1100000-0000-4000-8000-0000000000b1'::uuid pr1,'f1100000-0000-4000-8000-0000000000b2'::uuid pr2,'f1100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f1100000-0000-4000-8000-0000000000c1'::uuid s1,'f1100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f1100000-0000-4000-8000-0000000000d1'::uuid p1,'f1100000-0000-4000-8000-0000000000d2'::uuid p2,'f1100000-0000-4000-8000-0000000000e1'::uuid i1,'f1100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f1100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-dt-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-dt-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-dt-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-dt-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-dt-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-dt-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-dt-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-dt'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

insert into public.patients(id,workspace_id,first_name,last_name,email,created_by)
select p1,w1,'Zzsecreto','Manual','h28-dt-p1@example.invalid',u3 from fx union all select p2,w1,'Zzsecreto','Publico','h28-dt-p2@example.invalid',null from fx;
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes,expires_at,source,created_by)
select i1,w1,pr1,s1,p1,'scheduled'::public.booking_status,1000000,60,now()+interval '1 day','manual',u3 from fx
union all select i2,w1,pr1,s1,p2,'scheduled',1000000,60,now()+interval '1 day','public',null from fx;
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i1,pr1,p1,now()+interval '2 days',now()+interval '2 days 1 hour','scheduled'::public.booking_status from fx
union all select w1,i2,pr1,p2,now()+interval '3 days',now()+interval '3 days 1 hour','scheduled' from fx;
insert into public.patient_notes(workspace_id,patient_id,author_id,content) select w1,p1,u3,'Zzsecreto nota clínica' from fx;
insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,description,due_date,created_by)
select w1,p1,pr1,'Zzsecreto seguimiento','Zzsecreto detalle',current_date+1,u3 from fx;

create function pg_temp.ws(p_workspace uuid) returns jsonb language sql security definer as $$
  select to_jsonb(w) || jsonb_build_object('tier',private.workspace_tier(w.id)) from public.workspaces w where w.id=p_workspace $$;
create function pg_temp.audits(p_workspace uuid) returns integer language sql security definer as $$
  select count(*)::integer from public.plan_change_audit where workspace_id=p_workspace $$;
create function pg_temp.last_audit(p_workspace uuid) returns jsonb language sql security definer as $$
  select to_jsonb(a) from public.plan_change_audit a where a.workspace_id=p_workspace order by a.id desc limit 1 $$;
create function pg_temp.audit_text() returns text language sql security definer as $$
  select coalesce(string_agg(to_jsonb(a)::text,' '),'') from public.plan_change_audit a $$;

create function pg_temp.kept(p_workspace uuid) returns jsonb language sql as $$
  select jsonb_build_object('patients',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.patients t where t.workspace_id=p_workspace),
    'appointments',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.appointments t where t.workspace_id=p_workspace),
    'notes',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.patient_notes t where t.workspace_id=p_workspace),
    'follow_ups',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.patient_follow_ups t where t.workspace_id=p_workspace),
    'rules',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.automation_rules t where t.workspace_id=p_workspace),
    'events',(select count(*) from public.product_events t where t.workspace_id=p_workspace)) $$;
-- W1 lleva diez días de prueba y le quedan veinte. Tiene pacientes, turnos, una nota, un seguimiento y reglas activas.
update public.workspaces set trial_started_at=now()-interval '10 days',trial_ends_at=now()+interval '20 days' where id=(select w1 from fx);
update public.automation_rules set enabled=true,enabled_at=now() where workspace_id=(select w1 from fx);

do $$ declare f record; r jsonb; a jsonb; w jsonb; v_kept jsonb; v_events integer; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);
  if pg_temp.ws(f.w1)->>'tier' <> 'pro_trial' then raise exception 'fixture_not_in_trial'; end if;

  -- Prueba vigente + Pro activo.
  r := public.admin_set_workspace_plan(f.w1,'pro',now()+interval '30 days');
  if r->>'effective_tier' <> 'pro' then raise exception 'activation_failed %', r; end if;
  v_kept := pg_temp.kept(f.w1);

  -- Volver a Free: Free ya, no "lo que quedaba de la prueba".
  r := public.admin_set_workspace_plan(f.w1,'free');
  w := pg_temp.ws(f.w1);
  if r->>'action' <> 'downgraded_to_free' or r->>'effective_tier' <> 'free' or r->>'plan_code' <> 'free' then raise exception 'not_free_immediately %', r; end if;
  if w->>'tier' <> 'free' or private.workspace_tier(f.w1) <> 'free' then raise exception 'tier_still_not_free %', w->>'tier'; end if;
  -- La prueba terminó ahora; cuándo empezó queda como dato.
  if (w->>'trial_started_at')::timestamptz <> now()-interval '10 days' or (w->>'trial_ends_at')::timestamptz <> now() then raise exception 'trial_dates_wrong % %', w->>'trial_started_at', w->>'trial_ends_at'; end if;
  a := pg_temp.last_audit(f.w1);
  if a->>'action' <> 'downgraded_to_free' or a->>'previous_effective_tier' <> 'pro' or a->>'new_effective_tier' <> 'free' or a->>'previous_plan_code' <> 'pro' or a->>'new_plan_code' <> 'free'
    or (a->>'previous_trial_ends_at')::timestamptz <> now()+interval '20 days' or (a->>'new_trial_ends_at')::timestamptz <> now() or (a->>'actor_admin_user_id')::uuid <> f.u1 then raise exception 'audit_wrong %', a; end if;
  -- Lo que el plan permite cambió; lo que el consultorio tiene, no.
  if private.workspace_has_capability(f.w1,'followups') or private.workspace_has_capability(f.w1,'automations') or private.workspace_has_capability(f.w1,'mercado_pago')
    or not private.workspace_has_capability(f.w1,'manual_patients') or not private.workspace_has_capability(f.w1,'patient_notes') then raise exception 'capabilities_wrong'; end if;
  if pg_temp.kept(f.w1) <> v_kept then raise exception 'downgrade_touched_data % %', v_kept, pg_temp.kept(f.w1); end if;
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1) <> 1 or (select count(*) from public.automation_rules where workspace_id=f.w1 and enabled) = 0
    or (select count(*) from public.plan_change_audit where workspace_id=f.w1) <> 2 then raise exception 'history_not_preserved'; end if;

  -- Otra vez: nada que cambiar.
  r := public.admin_set_workspace_plan(f.w1,'free');
  if r->>'action' <> 'unchanged' or pg_temp.audits(f.w1) <> 2 then raise exception 'second_downgrade_not_idempotent %', r; end if;
  -- La prueba ya fue otorgada: no vuelve a empezar sola.
  if private.start_workspace_trial(f.w1) or pg_temp.ws(f.w1)->>'tier' <> 'free' then raise exception 'trial_restarted'; end if;
  -- Y Pro se puede volver a activar cuando haga falta.
  r := public.admin_set_workspace_plan(f.w1,'pro',now()+interval '60 days');
  if r->>'action' <> 'pro_activated' or r->>'effective_tier' <> 'pro' then raise exception 'cannot_reactivate %', r; end if;
  perform public.admin_set_workspace_plan(f.w1,'free');
  if pg_temp.ws(f.w1)->>'tier' <> 'free' then raise exception 'second_cycle_not_free'; end if;

  -- Solo prueba, sin haber tenido Pro: la misma acción la termina.
  update public.workspaces set trial_started_at=now()-interval '5 days',trial_ends_at=now()+interval '25 days' where id=f.w2;
  if pg_temp.ws(f.w2)->>'tier' <> 'pro_trial' then raise exception 'fixture_trial_only'; end if;
  r := public.admin_set_workspace_plan(f.w2,'free');
  a := pg_temp.last_audit(f.w2);
  if r->>'action' <> 'downgraded_to_free' or r->>'effective_tier' <> 'free' or a->>'previous_effective_tier' <> 'pro_trial' or a->>'new_effective_tier' <> 'free'
    or a->>'previous_plan_code' <> 'free' or a->>'new_plan_code' <> 'free' or a->>'new_pro_ends_at' is not null or (a->>'new_trial_ends_at')::timestamptz <> now() then raise exception 'trial_only_downgrade_wrong % %', r, a; end if;

  -- Una prueba que ya había vencido sola no se toca: su fecha de fin sigue siendo la real.
  update public.workspaces set plan_code='free',pro_started_at=null,pro_ends_at=null,trial_started_at=now()-interval '40 days',trial_ends_at=now()-interval '9 days' where id=f.w3;
  r := public.admin_set_workspace_plan(f.w3,'free');
  if r->>'action' <> 'unchanged' or (pg_temp.ws(f.w3)->>'trial_ends_at')::timestamptz <> now()-interval '9 days' or pg_temp.audits(f.w3) <> 0 then raise exception 'expired_trial_touched %', r; end if;
end $$;

-- La dueña lo ve en el acto: Free, sin días de prueba, con su seguimiento a la vista y sin poder crear otro.
set local role authenticated;
do $$ declare f record; a jsonb; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u3);
  a := public.workspace_access(f.w1);
  if a->>'tier' <> 'free' or (a->>'has_pro_access')::boolean or a->>'trial_days_remaining' is not null or (a->'capabilities') ? 'followups' then raise exception 'owner_still_sees_pro %', a; end if;
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1) <> 1 then raise exception 'owner_lost_sight_of_follow_up'; end if;
  perform pg_temp.fails(format('insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by) values(%L,%L,%L,%L,current_date+7,%L)',f.w1,f.p1,f.pr1,'Otro',f.u3),'pro_access_required');
end $$;
reset role;
select 'admin_downgrade_during_trial_ok' result;
rollback;
