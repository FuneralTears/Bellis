-- H2.8A Un cambio hecho a mano no es un vencimiento: volver a Free no se anota después como 'venció'.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f0100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ne-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f0100000-0000-4000-8000-000000000001','admin',true),('f0100000-0000-4000-8000-000000000002','support',true),('f0100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f0100000-0000-4000-8000-000000000001'::uuid u1,'f0100000-0000-4000-8000-000000000002'::uuid u2,'f0100000-0000-4000-8000-000000000003'::uuid u3,'f0100000-0000-4000-8000-000000000004'::uuid u4,'f0100000-0000-4000-8000-000000000005'::uuid u5,'f0100000-0000-4000-8000-000000000006'::uuid u6,
  'f0100000-0000-4000-8000-0000000000a1'::uuid w1,'f0100000-0000-4000-8000-0000000000a2'::uuid w2,'f0100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f0100000-0000-4000-8000-0000000000b1'::uuid pr1,'f0100000-0000-4000-8000-0000000000b2'::uuid pr2,'f0100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f0100000-0000-4000-8000-0000000000c1'::uuid s1,'f0100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f0100000-0000-4000-8000-0000000000d1'::uuid p1,'f0100000-0000-4000-8000-0000000000d2'::uuid p2,'f0100000-0000-4000-8000-0000000000e1'::uuid i1,'f0100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f0100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ne-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-ne-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-ne-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-ne-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-ne-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-ne-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-ne-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-ne'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

create function pg_temp.ws(p_workspace uuid) returns jsonb language sql security definer as $$
  select to_jsonb(w) || jsonb_build_object('tier',private.workspace_tier(w.id)) from public.workspaces w where w.id=p_workspace $$;
create function pg_temp.audits(p_workspace uuid) returns integer language sql security definer as $$
  select count(*)::integer from public.plan_change_audit where workspace_id=p_workspace $$;
create function pg_temp.last_audit(p_workspace uuid) returns jsonb language sql security definer as $$
  select to_jsonb(a) from public.plan_change_audit a where a.workspace_id=p_workspace order by a.id desc limit 1 $$;
create function pg_temp.audit_text() returns text language sql security definer as $$
  select coalesce(string_agg(to_jsonb(a)::text,' '),'') from public.plan_change_audit a $$;

create function pg_temp.n(p_event text,p_workspace uuid) returns integer language sql as $$
  select count(*)::integer from public.product_events where event_name=p_event and workspace_id=p_workspace $$;
update public.workspaces set trial_started_at=now()-interval '10 days',trial_ends_at=now()+interval '20 days' where id=(select w1 from fx);

do $$ declare f record; r jsonb; v_new integer; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);

  -- ===== Volver a Free a mano: auditado, Free en el acto, y sin "venció" después =====
  -- W3: Pro vigente.
  r := public.admin_set_workspace_plan(f.w3,'free');
  if r->>'action' <> 'downgraded_to_free' or pg_temp.ws(f.w3)->>'tier' <> 'free' or pg_temp.last_audit(f.w3)->>'action' <> 'downgraded_to_free'
    or (pg_temp.ws(f.w3)->>'pro_ends_at')::timestamptz <> now() then raise exception 'downgrade_wrong %', r; end if;
  -- W1: prueba vigente y Pro activo.
  perform public.admin_set_workspace_plan(f.w1,'pro',now()+interval '30 days');
  perform public.admin_set_workspace_plan(f.w1,'free');
  if pg_temp.ws(f.w1)->>'tier' <> 'free' or (pg_temp.ws(f.w1)->>'trial_ends_at')::timestamptz <> now() then raise exception 'downgrade_with_trial_wrong'; end if;
  -- El registro de vencimientos corre, las veces que sea.
  perform private.record_plan_expirations(); perform private.record_plan_expirations();
  if pg_temp.n('pro_expired',f.w3) <> 0 then raise exception 'manual_downgrade_recorded_as_pro_expired'; end if;
  if pg_temp.n('pro_expired',f.w1) <> 0 or pg_temp.n('trial_expired',f.w1) <> 0 then raise exception 'manual_trial_end_recorded_as_expired % %', pg_temp.n('pro_expired',f.w1), pg_temp.n('trial_expired',f.w1); end if;
  -- Lo que sí quedó: el cambio, a nombre de quien lo hizo.
  if (select count(*) from public.plan_change_audit where workspace_id in (f.w1,f.w3) and action='downgraded_to_free' and actor_admin_user_id=f.u1) <> 2 then raise exception 'downgrade_not_audited'; end if;

  -- ===== Un vencimiento natural se sigue anotando, una sola vez =====
  -- W2: una prueba que terminó sola hace nueve días.
  update public.workspaces set trial_started_at=now()-interval '40 days',trial_ends_at=now()-interval '9 days' where id=f.w2;
  v_new := private.record_plan_expirations();
  if pg_temp.n('trial_expired',f.w2) <> 1 or v_new < 1 then raise exception 'natural_trial_expiry_missing'; end if;
  if (select created_at from public.product_events where event_name='trial_expired' and workspace_id=f.w2) <> now()-interval '9 days' then raise exception 'expiry_not_dated_when_it_happened'; end if;
  perform private.record_plan_expirations();
  if pg_temp.n('trial_expired',f.w2) <> 1 then raise exception 'natural_expiry_repeated'; end if;

  -- W3 vuelve a ser Pro y esta vez vence solo, hace dos días. Eso sí es un vencimiento.
  perform public.admin_set_workspace_plan(f.w3,'pro',now()+interval '30 days');
  update public.workspaces set pro_started_at=now()-interval '40 days',pro_ends_at=now()-interval '2 days' where id=f.w3;
  perform private.record_plan_expirations();
  if pg_temp.n('pro_expired',f.w3) <> 1 or (select created_at from public.product_events where event_name='pro_expired' and workspace_id=f.w3) <> now()-interval '2 days' then raise exception 'natural_pro_expiry_missing'; end if;
  -- Pasarlo a Free después de vencido no mueve su fecha de fin: el vencimiento sigue siendo el que fue, ni se borra ni se duplica.
  r := public.admin_set_workspace_plan(f.w3,'free');
  if r->>'action' <> 'downgraded_to_free' or (pg_temp.ws(f.w3)->>'pro_ends_at')::timestamptz <> now()-interval '2 days' then raise exception 'downgrade_after_expiry_moved_the_end %', r; end if;
  perform private.record_plan_expirations();
  if pg_temp.n('pro_expired',f.w3) <> 1 then raise exception 'natural_expiry_lost_or_repeated %', pg_temp.n('pro_expired',f.w3); end if;

  -- W1, después de un cambio a mano, vuelve a tener Pro y esta vez vence solo: se anota ese, y solo ese.
  perform public.admin_set_workspace_plan(f.w1,'pro',now()+interval '30 days');
  update public.workspaces set pro_started_at=now()-interval '10 days',pro_ends_at=now()-interval '1 day' where id=f.w1;
  perform private.record_plan_expirations(); perform private.record_plan_expirations();
  if pg_temp.n('pro_expired',f.w1) <> 1 or pg_temp.n('trial_expired',f.w1) <> 0 then raise exception 'later_natural_expiry_wrong % %', pg_temp.n('pro_expired',f.w1), pg_temp.n('trial_expired',f.w1); end if;
  -- Nada más que anotar.
  if private.record_plan_expirations() <> 0 then raise exception 'expirations_not_idempotent'; end if;
end $$;

-- El job sigue siendo el mismo, y la función sigue fuera del alcance de la API.
do $$ begin
  if has_function_privilege('authenticated','private.record_plan_expirations()','execute') or has_function_privilege('anon','private.record_plan_expirations()','execute') then raise exception 'expirations_function_exposed'; end if;
  if (select count(*) from cron.job where jobname='bellis-plan-expirations' and command='select private.record_plan_expirations()' and active) <> 1 then raise exception 'cron_job_changed'; end if;
end $$;
select 'manual_downgrade_no_expiration_ok' result;
rollback;
