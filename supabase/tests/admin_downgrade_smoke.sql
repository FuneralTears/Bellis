-- H2.8A Volver a Bellis Free: cambia lo que el plan permite y no se borra nada.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f3100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-dg-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f3100000-0000-4000-8000-000000000001','admin',true),('f3100000-0000-4000-8000-000000000002','support',true),('f3100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f3100000-0000-4000-8000-000000000001'::uuid u1,'f3100000-0000-4000-8000-000000000002'::uuid u2,'f3100000-0000-4000-8000-000000000003'::uuid u3,'f3100000-0000-4000-8000-000000000004'::uuid u4,'f3100000-0000-4000-8000-000000000005'::uuid u5,'f3100000-0000-4000-8000-000000000006'::uuid u6,
  'f3100000-0000-4000-8000-0000000000a1'::uuid w1,'f3100000-0000-4000-8000-0000000000a2'::uuid w2,'f3100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f3100000-0000-4000-8000-0000000000b1'::uuid pr1,'f3100000-0000-4000-8000-0000000000b2'::uuid pr2,'f3100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f3100000-0000-4000-8000-0000000000c1'::uuid s1,'f3100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f3100000-0000-4000-8000-0000000000d1'::uuid p1,'f3100000-0000-4000-8000-0000000000d2'::uuid p2,'f3100000-0000-4000-8000-0000000000e1'::uuid i1,'f3100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f3100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-dg-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-dg-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-dg-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-dg-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-dg-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-dg-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-dg-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-dg'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

insert into public.patients(id,workspace_id,first_name,last_name,email,created_by)
select p1,w1,'Zzsecreto','Manual','h28-dg-p1@example.invalid',u3 from fx union all select p2,w1,'Zzsecreto','Publico','h28-dg-p2@example.invalid',null from fx;
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

update public.automation_rules set enabled=true,enabled_at=now() where workspace_id=(select w1 from fx);
create function pg_temp.kept(p_workspace uuid) returns jsonb language sql as $$
  select jsonb_build_object('patients',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.patients t where t.workspace_id=p_workspace),
    'appointments',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.appointments t where t.workspace_id=p_workspace),
    'notes',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.patient_notes t where t.workspace_id=p_workspace),
    'follow_ups',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.patient_follow_ups t where t.workspace_id=p_workspace),
    'rules',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.automation_rules t where t.workspace_id=p_workspace),
    'services',(select md5(string_agg(to_jsonb(t)::text,'|' order by t.id)) from public.services t where t.workspace_id=p_workspace),
    'mp_account',(select md5(to_jsonb(t)::text) from private.mercado_pago_accounts t where t.workspace_id=p_workspace),
    'provider',(select payment_provider from public.workspaces where id=p_workspace),'link',(select external_payment_url from public.workspaces where id=p_workspace)) $$;
insert into memo values('w1',pg_temp.kept((select w1 from fx))),('w3',pg_temp.kept((select w3 from fx)));

do $$ declare f record; r jsonb; a jsonb; v_old timestamptz; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);

  -- W3: Pro con Mercado Pago conectado. Vuelve a Free y la conexión queda intacta, igual que el medio de cobro elegido.
  v_old := (pg_temp.ws(f.w3)->>'pro_ends_at')::timestamptz;
  perform pg_temp.fails(format('select private.admin_set_workspace_plan_as_admin(%L,%L,now()+interval %L)',f.w3,'free','30 days'),'invalid_plan_arguments');
  r := private.admin_set_workspace_plan_as_admin(f.w3,'free',null);
  if r->>'action' <> 'downgraded_to_free' or r->>'effective_tier' <> 'free' or r->>'plan_code' <> 'free' then raise exception 'downgrade_wrong %', r; end if;
  -- Queda la historia: cuándo empezó, y que terminó ahora.
  if (r->>'pro_started_at')::timestamptz <> now()-interval '5 days' or (r->>'pro_ends_at')::timestamptz <> now() then raise exception 'pro_history_lost %', r; end if;
  a := pg_temp.last_audit(f.w3);
  if a->>'action' <> 'downgraded_to_free' or a->>'previous_effective_tier' <> 'pro' or a->>'new_effective_tier' <> 'free' or a->>'previous_plan_code' <> 'pro' or a->>'new_plan_code' <> 'free'
    or (a->>'previous_pro_ends_at')::timestamptz <> v_old or (a->>'new_pro_ends_at')::timestamptz <> now() or (a->>'actor_admin_user_id')::uuid <> f.u1 then raise exception 'downgrade_audit_wrong %', a; end if;
  if pg_temp.kept(f.w3) <> (select value from memo where tag='w3') then raise exception 'downgrade_touched_data_or_mp_connection'; end if;
  if not exists(select 1 from private.mercado_pago_accounts m where m.workspace_id=f.w3 and m.status='connected' and m.active) then raise exception 'mp_connection_lost'; end if;
  -- Lo que cambia es lo que el plan permite.
  if private.workspace_has_capability(f.w3,'mercado_pago') or private.workspace_has_capability(f.w3,'followups') or not private.workspace_has_capability(f.w3,'manual_patients') then raise exception 'capabilities_after_downgrade_wrong'; end if;
  -- Otra vez: nada.
  r := private.admin_set_workspace_plan_as_admin(f.w3,'free',null);
  if r->>'action' <> 'unchanged' or pg_temp.audits(f.w3) <> 1 then raise exception 'second_downgrade_not_idempotent %', r; end if;

  -- W1: con pacientes, turnos, una nota, un seguimiento y automatizaciones activas, y con la prueba todavía vigente.
  -- Pasa por Pro y vuelve: queda en Free en el acto, no en lo que le quedaba de prueba.
  update public.workspaces set trial_started_at=now()-interval '10 days',trial_ends_at=now()+interval '20 days' where id=f.w1;
  perform private.admin_set_workspace_plan_as_admin(f.w1,'pro',now()+interval '30 days');
  r := private.admin_set_workspace_plan_as_admin(f.w1,'free',null);
  a := pg_temp.last_audit(f.w1);
  if r->>'action' <> 'downgraded_to_free' or r->>'effective_tier' <> 'free' or a->>'new_effective_tier' <> 'free' or a->>'new_plan_code' <> 'free' then raise exception 'downgrade_with_trial_wrong % %', r, a; end if;
  -- Y se puede volver a activar y volver a quitar.
  perform private.admin_set_workspace_plan_as_admin(f.w1,'pro',now()+interval '30 days');
  r := private.admin_set_workspace_plan_as_admin(f.w1,'free',null);
  if r->>'effective_tier' <> 'free' or pg_temp.last_audit(f.w1)->>'new_effective_tier' <> 'free' then raise exception 'downgrade_to_free_wrong %', r; end if;
  -- Todo sigue ahí, fila por fila: pacientes, turnos, la nota, el seguimiento, las reglas (encendidas), el servicio y el link de pago.
  if pg_temp.kept(f.w1) <> (select value from memo where tag='w1') then raise exception 'downgrade_deleted_or_changed_data'; end if;
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1) <> 1 or (select count(*) from public.automation_rules where workspace_id=f.w1 and enabled) = 0 then raise exception 'history_not_preserved'; end if;
end $$;

-- La dueña sigue viendo su seguimiento, y no puede crear otro hasta volver a tener Pro. Las notas siguen siendo de Free.
set local role authenticated;
do $$ declare f record; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u3);
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1) <> 1 then raise exception 'owner_lost_sight_of_follow_up'; end if;
  perform pg_temp.fails(format('insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by) values(%L,%L,%L,%L,current_date+7,%L)',f.w1,f.p1,f.pr1,'Otro',f.u3),'pro_access_required');
  insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w1,f.p1,f.u3,'Nota en Free');
end $$;
reset role;
select 'admin_downgrade_ok' result;
rollback;
