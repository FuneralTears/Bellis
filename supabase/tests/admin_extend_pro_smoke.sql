-- H2.8A Extender Bellis Pro: se aleja el vencimiento y se conserva la fecha de inicio.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f4100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ex-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f4100000-0000-4000-8000-000000000001','admin',true),('f4100000-0000-4000-8000-000000000002','support',true),('f4100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f4100000-0000-4000-8000-000000000001'::uuid u1,'f4100000-0000-4000-8000-000000000002'::uuid u2,'f4100000-0000-4000-8000-000000000003'::uuid u3,'f4100000-0000-4000-8000-000000000004'::uuid u4,'f4100000-0000-4000-8000-000000000005'::uuid u5,'f4100000-0000-4000-8000-000000000006'::uuid u6,
  'f4100000-0000-4000-8000-0000000000a1'::uuid w1,'f4100000-0000-4000-8000-0000000000a2'::uuid w2,'f4100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f4100000-0000-4000-8000-0000000000b1'::uuid pr1,'f4100000-0000-4000-8000-0000000000b2'::uuid pr2,'f4100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f4100000-0000-4000-8000-0000000000c1'::uuid s1,'f4100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f4100000-0000-4000-8000-0000000000d1'::uuid p1,'f4100000-0000-4000-8000-0000000000d2'::uuid p2,'f4100000-0000-4000-8000-0000000000e1'::uuid i1,'f4100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f4100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ex-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-ex-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-ex-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-ex-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-ex-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-ex-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-ex-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-ex'),'test',now()+interval '1 day' from fx;
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

do $$ declare f record; r jsonb; a jsonb; v_start timestamptz := now()-interval '5 days'; v_old timestamptz := now()+interval '25 days'; v_new timestamptz := now()+interval '25 days'+interval '30 days'; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);
  if pg_temp.ws(f.w3)->>'tier' <> 'pro' or (pg_temp.ws(f.w3)->>'pro_ends_at')::timestamptz <> v_old then raise exception 'fixture_not_pro'; end if;

  -- Treinta días más, contados desde el vencimiento vigente.
  r := public.admin_set_workspace_plan(f.w3,'pro',v_new);
  if r->>'action' <> 'pro_extended' or r->>'effective_tier' <> 'pro' or (r->>'pro_ends_at')::timestamptz <> v_new then raise exception 'extend_wrong %', r; end if;
  if (r->>'pro_started_at')::timestamptz <> v_start then raise exception 'extension_moved_the_start %', r->>'pro_started_at'; end if;
  a := pg_temp.last_audit(f.w3);
  if a->>'action' <> 'pro_extended' or a->>'previous_effective_tier' <> 'pro' or a->>'new_effective_tier' <> 'pro' or a->>'previous_plan_code' <> 'pro' or a->>'new_plan_code' <> 'pro'
    or (a->>'previous_pro_ends_at')::timestamptz <> v_old or (a->>'new_pro_ends_at')::timestamptz <> v_new or (a->>'actor_admin_user_id')::uuid <> f.u1 then raise exception 'extend_audit_wrong %', a; end if;
  -- Extender no es activar: no hay un "Bellis Pro activado" nuevo en los eventos.
  if (select count(*) from public.product_events where workspace_id=f.w3 and event_name='pro_activated') <> 1 then raise exception 'extension_counted_as_activation'; end if;

  -- Extender solo aleja la fecha. Acercarla se rechaza y no cambia nada.
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,%L,now()+interval %L)',f.w3,'pro','10 days'),'pro_end_not_extended');
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,%L,%L::timestamptz - interval %L)',f.w3,'pro',v_new,'1 second'),'pro_end_not_extended');
  if (pg_temp.ws(f.w3)->>'pro_ends_at')::timestamptz <> v_new or pg_temp.audits(f.w3) <> 1 then raise exception 'rejected_extension_changed_something'; end if;
  -- La misma fecha otra vez: nada.
  r := public.admin_set_workspace_plan(f.w3,'pro',v_new);
  if r->>'action' <> 'unchanged' or pg_temp.audits(f.w3) <> 1 then raise exception 'same_date_not_idempotent %', r; end if;

  -- Una segunda extensión parte de la primera.
  r := public.admin_set_workspace_plan(f.w3,'pro',v_new+interval '3 months');
  a := pg_temp.last_audit(f.w3);
  if r->>'action' <> 'pro_extended' or (a->>'previous_pro_ends_at')::timestamptz <> v_new or (r->>'pro_started_at')::timestamptz <> v_start or pg_temp.audits(f.w3) <> 2 then raise exception 'second_extension_wrong % %', r, a; end if;
end $$;
select 'admin_extend_pro_ok' result;
rollback;
