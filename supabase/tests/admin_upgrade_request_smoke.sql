-- H2.8A Pedidos de Bellis Pro en el backoffice: activar, resolver sin activar y descartar.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f2100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ur-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f2100000-0000-4000-8000-000000000001','admin',true),('f2100000-0000-4000-8000-000000000002','support',true),('f2100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f2100000-0000-4000-8000-000000000001'::uuid u1,'f2100000-0000-4000-8000-000000000002'::uuid u2,'f2100000-0000-4000-8000-000000000003'::uuid u3,'f2100000-0000-4000-8000-000000000004'::uuid u4,'f2100000-0000-4000-8000-000000000005'::uuid u5,'f2100000-0000-4000-8000-000000000006'::uuid u6,
  'f2100000-0000-4000-8000-0000000000a1'::uuid w1,'f2100000-0000-4000-8000-0000000000a2'::uuid w2,'f2100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f2100000-0000-4000-8000-0000000000b1'::uuid pr1,'f2100000-0000-4000-8000-0000000000b2'::uuid pr2,'f2100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f2100000-0000-4000-8000-0000000000c1'::uuid s1,'f2100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f2100000-0000-4000-8000-0000000000d1'::uuid p1,'f2100000-0000-4000-8000-0000000000d2'::uuid p2,'f2100000-0000-4000-8000-0000000000e1'::uuid i1,'f2100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f2100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ur-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-ur-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-ur-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-ur-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-ur-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-ur-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-ur-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-ur'),'test',now()+interval '1 day' from fx;
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

-- Tres pedidos: W1 (en prueba) hace tres días, W2 (Free) hace dos, W3 (ya Pro) ayer.
set local role authenticated;
do $$ declare f record; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u3); perform public.request_pro_upgrade(f.w1); perform public.request_pro_upgrade(f.w1);
  perform pg_temp.as_user(f.u5); perform public.request_pro_upgrade(f.w2);
  perform pg_temp.as_user(f.u6); perform public.request_pro_upgrade(f.w3);
end $$;
reset role;
update public.plan_upgrade_requests r set created_at=now()-make_interval(days => case r.workspace_id when (select w1 from fx) then 3 when (select w2 from fx) then 2 else 1 end)
where r.workspace_id in ((select w1 from fx),(select w2 from fx),(select w3 from fx));
create function pg_temp.req(p_workspace uuid) returns uuid language sql as $$
  select id from public.plan_upgrade_requests where workspace_id=p_workspace order by created_at desc limit 1 $$;
create function pg_temp.mine(p jsonb) returns text language sql as $$
  select coalesce(string_agg(r->>'workspace_name',',' order by ord),'') from jsonb_array_elements(p->'rows') with ordinality t(r,ord) where r->>'workspace_name' like 'H28smoke%' $$;

do $$ declare f record; begin
  select * into f from fx;
  -- Pedir dos veces no crea dos pedidos, y la base tampoco deja cargar un segundo abierto.
  if (select count(*) from public.plan_upgrade_requests where workspace_id=f.w1) <> 1 then raise exception 'double_request_created'; end if;
  perform pg_temp.fails(format('insert into public.plan_upgrade_requests(workspace_id,requested_by,contact_email) values(%L,%L,%L)',f.w1,f.u3,'x@example.invalid'),'23505');
end $$;

-- ===== La lista =====
set local role authenticated;
do $$ declare f record; v jsonb; r jsonb; k text; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u2);
  v := public.admin_upgrade_requests();
  -- Abiertas por defecto, primero la que más espera.
  if pg_temp.mine(v) <> 'H28smoke Uno,H28smoke Dos,H28smoke Tres' then raise exception 'open_order_wrong %', pg_temp.mine(v); end if;
  if (v->>'open')::int < 3 or (v->>'total')::int < 3 then raise exception 'open_count_wrong %', v - 'rows'; end if;
  r := (select x from jsonb_array_elements(v->'rows') x where x->>'workspace_name'='H28smoke Uno');
  foreach k in array array['request_id','workspace_id','workspace_name','owner_email','requested_at','effective_tier','requested_plan','status','resolved_at','resolution','plan_code','trial_ends_at','pro_ends_at','last_sign_in_at','last_activity_at'] loop
    if not r ? k then raise exception 'request_row_missing %', k; end if;
  end loop;
  if r->>'owner_email' <> 'h28-ur-3@example.invalid' or r->>'effective_tier' <> 'pro_trial' or r->>'requested_plan' <> 'pro' or r->>'status' <> 'open' or r->>'resolution' is not null
    or (r->>'requested_at')::timestamptz <> now()-interval '3 days' then raise exception 'request_row_wrong %', r; end if;
  if r ? 'contact_email' then raise exception 'contact_email_exposed'; end if;
  perform pg_temp.fails($q$select public.admin_upgrade_requests('pending')$q$,'invalid_filter');
  if (public.admin_upgrade_requests(p_limit => 100000)->>'limit')::int <> 100 then raise exception 'limit_not_clamped'; end if;
end $$;
reset role;

-- ===== Activar Pro desde el pedido: plan y pedido, todo o nada =====
do $$ declare f record; r jsonb; v_end timestamptz := now()+interval '30 days'; v_request uuid; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);

  -- Si la activación falla, el pedido sigue abierto y el plan como estaba.
  v_request := pg_temp.req(f.w2);
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L)',v_request,'activate'),'pro_ends_at_required');
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L,now()-interval %L)',v_request,'activate','1 day'),'pro_ends_at_required');
  if (select status from public.plan_upgrade_requests where id=v_request) <> 'open' or pg_temp.ws(f.w2)->>'tier' <> 'free' or pg_temp.audits(f.w2) <> 0 then raise exception 'failed_activation_left_something'; end if;

  v_request := pg_temp.req(f.w1);
  r := public.admin_resolve_upgrade_request(v_request,'activate',v_end);
  if r->>'status' <> 'resolved' or (r->>'resolved_at')::timestamptz <> now() or r->>'effective_tier' <> 'pro' or r->'plan'->>'action' <> 'pro_activated' then raise exception 'activate_from_request_wrong %', r; end if;
  if pg_temp.ws(f.w1)->>'tier' <> 'pro' or (pg_temp.ws(f.w1)->>'pro_ends_at')::timestamptz <> v_end then raise exception 'plan_not_activated'; end if;
  -- Dos filas de auditoría atadas al pedido: el plan y el pedido.
  if (select string_agg(action,',' order by id) from public.plan_change_audit where workspace_id=f.w1) <> 'pro_activated,upgrade_request_resolved' then raise exception 'activation_audit_wrong'; end if;
  if (select count(*) from public.plan_change_audit where workspace_id=f.w1 and request_id=v_request and actor_admin_user_id=f.u1 and previous_effective_tier='pro_trial' and new_effective_tier='pro') <> 2 then raise exception 'activation_audit_details_wrong'; end if;
  -- Un pedido cerrado no se vuelve a tocar.
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L,now()+interval %L)',v_request,'activate','60 days'),'request_not_open');
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L)',v_request,'dismiss'),'request_not_open');
  if (pg_temp.ws(f.w1)->>'pro_ends_at')::timestamptz <> v_end then raise exception 'closed_request_changed_the_plan'; end if;

  -- ===== Resolver sin activar =====
  v_request := pg_temp.req(f.w2);
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L,now()+interval %L)',v_request,'resolve','30 days'),'invalid_plan_arguments');
  r := public.admin_resolve_upgrade_request(v_request,'resolve');
  if r->>'status' <> 'resolved' or r->>'effective_tier' <> 'free' or r->>'plan' is not null then raise exception 'resolve_wrong %', r; end if;
  if pg_temp.ws(f.w2)->>'plan_code' <> 'free' or pg_temp.last_audit(f.w2)->>'action' <> 'upgrade_request_resolved' or pg_temp.audits(f.w2) <> 1
    or pg_temp.last_audit(f.w2)->>'previous_effective_tier' <> 'free' or pg_temp.last_audit(f.w2)->>'new_effective_tier' <> 'free' then raise exception 'resolve_audit_wrong %', pg_temp.last_audit(f.w2); end if;

  -- ===== Descartar =====
  v_request := pg_temp.req(f.w3);
  r := public.admin_resolve_upgrade_request(v_request,'dismiss');
  if r->>'status' <> 'dismissed' or (r->>'resolved_at')::timestamptz <> now() or r->>'effective_tier' <> 'pro' then raise exception 'dismiss_wrong %', r; end if;
  if pg_temp.last_audit(f.w3)->>'action' <> 'upgrade_request_dismissed' or pg_temp.audits(f.w3) <> 1 or (pg_temp.ws(f.w3)->>'pro_ends_at')::timestamptz <> now()+interval '25 days' then raise exception 'dismiss_touched_the_plan'; end if;

  -- Acción desconocida y pedido que no existe.
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L)',v_request,'delete'),'invalid_action');
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L)','00000000-0000-4000-8000-00000000dead','dismiss'),'not_found');
end $$;

-- ===== Los filtros de la pantalla =====
set local role authenticated;
do $$ declare f record; v jsonb; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u2);
  if pg_temp.mine(public.admin_upgrade_requests('open')) <> '' then raise exception 'closed_requests_still_open'; end if;
  if pg_temp.mine(public.admin_upgrade_requests('dismissed')) <> 'H28smoke Tres' then raise exception 'dismissed_filter_wrong'; end if;
  v := public.admin_upgrade_requests('resolved');
  if (select count(*) from jsonb_array_elements(v->'rows') x where x->>'workspace_name' in ('H28smoke Uno','H28smoke Dos')) <> 2 or v::text ~ 'H28smoke Tres' then raise exception 'resolved_filter_wrong'; end if;
  -- Cómo se cerró cada uno.
  if (select string_agg((x->>'workspace_name') || '=' || (x->>'resolution'),',' order by x->>'workspace_name') from jsonb_array_elements(public.admin_upgrade_requests('all')->'rows') x where x->>'workspace_name' like 'H28smoke%')
    <> 'H28smoke Dos=upgrade_request_resolved,H28smoke Tres=upgrade_request_dismissed,H28smoke Uno=pro_activated' then raise exception 'resolution_wrong'; end if;
  -- El historial comercial del consultorio, con quién hizo cada cambio: para quien lo hizo, "Vos"; para el resto del equipo, su email.
  v := public.admin_plan_changes(f.w1);
  if jsonb_array_length(v) <> 2 or (v->0)->>'action' <> 'upgrade_request_resolved' or (v->1)->>'action' <> 'pro_activated' or ((v->0)->>'by_me')::boolean
    or (v->0)->>'actor_label' <> 'h28-ur-1@example.invalid' or (v->1)->>'actor_label' <> 'h28-ur-1@example.invalid' then raise exception 'plan_changes_wrong %', v; end if;
  perform pg_temp.as_user(f.u1);
  if not ((public.admin_plan_changes(f.w1)->0)->>'by_me')::boolean or (public.admin_plan_changes(f.w1)->0)->>'actor_label' <> 'Vos' then raise exception 'by_me_wrong'; end if;
end $$;
reset role;

-- ===== Después de cerrado, se puede volver a pedir; y activar Pro desde el consultorio cierra el pedido abierto =====
do $$ declare f record; r jsonb; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u5); perform public.request_pro_upgrade(f.w2);
  if (select count(*) from public.plan_upgrade_requests where workspace_id=f.w2 and status='open') <> 1 or (select count(*) from public.plan_upgrade_requests where workspace_id=f.w2) <> 2 then raise exception 'cannot_ask_again'; end if;
  perform pg_temp.as_user(f.u1);
  r := public.admin_set_workspace_plan(f.w2,'pro',now()+interval '30 days');
  if r->>'action' <> 'pro_activated' or not (r->>'request_resolved')::boolean then raise exception 'open_request_not_closed_on_activation %', r; end if;
  if exists(select 1 from public.plan_upgrade_requests where workspace_id=f.w2 and status='open') then raise exception 'request_left_open'; end if;
  if (select string_agg(action,',' order by id) from public.plan_change_audit where workspace_id=f.w2) <> 'upgrade_request_resolved,pro_activated,upgrade_request_resolved' then raise exception 'auto_resolve_audit_wrong'; end if;
  -- Volver a Free no reabre ni cierra pedidos.
  perform pg_temp.as_user(f.u6); perform public.request_pro_upgrade(f.w3);
  perform pg_temp.as_user(f.u1); perform public.admin_set_workspace_plan(f.w3,'free');
  if (select count(*) from public.plan_upgrade_requests where workspace_id=f.w3 and status='open') <> 1 then raise exception 'downgrade_touched_requests'; end if;
end $$;
select 'admin_upgrade_request_ok' result;
rollback;
