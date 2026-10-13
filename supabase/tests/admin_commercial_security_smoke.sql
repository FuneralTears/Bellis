-- H2.8A Acciones comerciales del backoffice: quién puede cambiar un plan y quién no.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f6100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-cs-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f6100000-0000-4000-8000-000000000001','admin',true),('f6100000-0000-4000-8000-000000000002','support',true),('f6100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f6100000-0000-4000-8000-000000000001'::uuid u1,'f6100000-0000-4000-8000-000000000002'::uuid u2,'f6100000-0000-4000-8000-000000000003'::uuid u3,'f6100000-0000-4000-8000-000000000004'::uuid u4,'f6100000-0000-4000-8000-000000000005'::uuid u5,'f6100000-0000-4000-8000-000000000006'::uuid u6,
  'f6100000-0000-4000-8000-0000000000a1'::uuid w1,'f6100000-0000-4000-8000-0000000000a2'::uuid w2,'f6100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f6100000-0000-4000-8000-0000000000b1'::uuid pr1,'f6100000-0000-4000-8000-0000000000b2'::uuid pr2,'f6100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f6100000-0000-4000-8000-0000000000c1'::uuid s1,'f6100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f6100000-0000-4000-8000-0000000000d1'::uuid p1,'f6100000-0000-4000-8000-0000000000d2'::uuid p2,'f6100000-0000-4000-8000-0000000000e1'::uuid i1,'f6100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f6100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-cs-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-cs-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-cs-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-cs-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-cs-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-cs-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-cs-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-cs'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

-- ===== Permisos sobre los objetos (antes de cualquier otra cosa) =====
do $$ declare v text; begin
  foreach v in array array['select','insert','update','delete'] loop
    if has_table_privilege('authenticated','public.plan_change_audit',v) or has_table_privilege('anon','public.plan_change_audit',v) then raise exception 'plan_change_audit_exposed %',v; end if;
  end loop;
  if has_table_privilege('service_role','public.plan_change_audit','insert,update,delete') or not has_table_privilege('service_role','public.plan_change_audit','select') then raise exception 'service_role_audit_grants_wrong'; end if;
  if not (select relrowsecurity from pg_class where oid='public.plan_change_audit'::regclass) or exists(select 1 from pg_policies where tablename='plan_change_audit') then raise exception 'plan_change_audit_rls_wrong'; end if;
  -- Lo interno, y la función de H2.7 que cambia las columnas, siguen fuera del alcance de la API.
  foreach v in array array['private.require_bellis_admin_role(text)','private.record_plan_change(uuid,text,uuid,text,text,timestamptz,timestamptz)','private.admin_change_workspace_plan(uuid,text,timestamptz,uuid)',
    'private.admin_set_workspace_plan(uuid,text,timestamptz,timestamptz)'] loop
    if has_function_privilege('authenticated',v,'execute') or has_function_privilege('anon',v,'execute') then raise exception 'internal_function_exposed %',v; end if;
  end loop;
  if has_function_privilege('service_role','private.admin_set_workspace_plan(uuid,text,timestamptz,timestamptz)','execute') then raise exception 'service_role_can_set_plans'; end if;
  foreach v in array array['public.admin_set_workspace_plan(uuid,text,timestamptz)','public.admin_resolve_upgrade_request(uuid,text,timestamptz)','public.admin_upgrade_requests(text,integer,integer)','public.admin_plan_changes(uuid,integer)'] loop
    if has_function_privilege('anon',v,'execute') then raise exception 'anon_can_call %',v; end if;
    if not has_function_privilege('authenticated',v,'execute') then raise exception 'authenticated_cannot_call %',v; end if;
  end loop;
end $$;

create function pg_temp.ws(p_workspace uuid) returns jsonb language sql security definer as $$
  select to_jsonb(w) || jsonb_build_object('tier',private.workspace_tier(w.id)) from public.workspaces w where w.id=p_workspace $$;
create function pg_temp.audits(p_workspace uuid) returns integer language sql security definer as $$
  select count(*)::integer from public.plan_change_audit where workspace_id=p_workspace $$;
create function pg_temp.last_audit(p_workspace uuid) returns jsonb language sql security definer as $$
  select to_jsonb(a) from public.plan_change_audit a where a.workspace_id=p_workspace order by a.id desc limit 1 $$;
create function pg_temp.audit_text() returns text language sql security definer as $$
  select coalesce(string_agg(to_jsonb(a)::text,' '),'') from public.plan_change_audit a $$;

set local role authenticated;
do $$ begin perform pg_temp.as_user((select u3 from fx)); perform public.request_pro_upgrade((select w1 from fx)); end $$;
reset role;
insert into memo select 'request',to_jsonb(r.id) from public.plan_upgrade_requests r where r.workspace_id=(select w1 from fx);
insert into memo values('w1',pg_temp.ws((select w1 from fx)));

-- ===== Quien no es del equipo, y soporte: no cambian nada =====
set local role authenticated;
do $$ declare f record; v_user uuid; q text; v_request uuid := (select (value#>>'{}')::uuid from memo where tag='request'); begin
  select * into f from fx;
  -- La dueña del consultorio (sobre el suyo), la dueña de otro, un admin dado de baja y una sesión sin usuario: no encontrado.
  foreach v_user in array array[f.u3,f.u5,f.u4,null] loop
    perform pg_temp.as_user(v_user);
    foreach q in array array[format('select public.admin_set_workspace_plan(%L,%L,now()+interval %L)',f.w1,'pro','30 days'),format('select public.admin_set_workspace_plan(%L,%L)',f.w3,'free'),
      format('select public.admin_resolve_upgrade_request(%L,%L,now()+interval %L)',v_request,'activate','30 days'),format('select public.admin_resolve_upgrade_request(%L,%L)',v_request,'dismiss'),
      'select public.admin_upgrade_requests()',format('select public.admin_plan_changes(%L)',f.w1)] loop
      perform pg_temp.fails(q,'not_found');
    end loop;
  end loop;
  -- Soporte lee, y no puede cambiar un plan ni tocar un pedido.
  perform pg_temp.as_user(f.u2);
  if (public.admin_upgrade_requests()->>'total')::int < 1 or jsonb_typeof(public.admin_plan_changes(f.w1)) <> 'array' then raise exception 'support_cannot_read'; end if;
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,%L,now()+interval %L)',f.w1,'pro','30 days'),'not_found');
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,%L)',f.w3,'free'),'not_found');
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L,now()+interval %L)',v_request,'activate','30 days'),'not_found');
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L)',v_request,'resolve'),'not_found');
  perform pg_temp.fails(format('select public.admin_resolve_upgrade_request(%L,%L)',v_request,'dismiss'),'not_found');
end $$;
reset role;
set local role anon;
do $$ begin
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,%L)',(select w3 from fx),'free'),'42501');
  perform pg_temp.fails('select public.admin_upgrade_requests()','42501');
end $$;
reset role;
do $$ declare f record; begin
  select * into f from fx;
  -- Después de todos esos intentos, nada cambió.
  if pg_temp.ws(f.w1) <> (select value from memo where tag='w1') or pg_temp.ws(f.w3)->>'plan_code' <> 'pro' then raise exception 'plan_changed_by_non_admin'; end if;
  if (select count(*) from public.plan_change_audit where workspace_id in (f.w1,f.w2,f.w3)) <> 0 then raise exception 'audit_written_by_non_admin'; end if;
  if (select status from public.plan_upgrade_requests where workspace_id=f.w1) <> 'open' then raise exception 'request_changed_by_non_admin'; end if;
end $$;

-- ===== Ni siquiera un admin escribe directo: todo pasa por las funciones =====
set local role authenticated;
do $$ declare f record; v_request uuid := (select (value#>>'{}')::uuid from memo where tag='request'); begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);
  begin update public.workspaces set plan_code='pro',pro_started_at=now(),pro_ends_at=now()+interval '30 days' where id=f.w1; exception when others then null; end;
  begin update public.plan_upgrade_requests set status='resolved',resolved_at=now() where id=v_request; exception when others then null; end;
  perform pg_temp.fails(format('insert into public.plan_change_audit(workspace_id,action,previous_effective_tier,new_effective_tier,previous_plan_code,new_plan_code) values(%L,%L,%L,%L,%L,%L)',
    f.w1,'pro_activated','free','pro','free','pro'),'42501');
  perform pg_temp.fails('delete from public.plan_change_audit','42501');
  perform pg_temp.fails(format('select private.admin_set_workspace_plan(%L,%L,now()+interval %L)',f.w1,'pro','30 days'),'42501');
  perform pg_temp.fails(format('select private.admin_change_workspace_plan(%L,%L,now()+interval %L)',f.w1,'pro','30 days'),'42501');
end $$;
reset role;
do $$ declare f record; begin
  select * into f from fx;
  if pg_temp.ws(f.w1) <> (select value from memo where tag='w1') then raise exception 'direct_update_changed_the_plan'; end if;
  if (select status from public.plan_upgrade_requests where workspace_id=f.w1) <> 'open' then raise exception 'direct_update_changed_the_request'; end if;
end $$;

-- ===== El admin sí, y queda anotado que fue esa persona =====
set local role authenticated;
do $$ declare f record; r jsonb; a jsonb; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);
  r := public.admin_set_workspace_plan(f.w1,'pro',now()+interval '30 days');
  if r->>'action' <> 'pro_activated' or r->>'effective_tier' <> 'pro' then raise exception 'admin_cannot_activate %', r; end if;
  a := pg_temp.last_audit(f.w1);
  -- Dos filas, las dos a nombre de quien lo hizo: la activación y el pedido abierto que quedó resuelto con ella.
  if a->>'action' <> 'upgrade_request_resolved' or (a->>'actor_admin_user_id')::uuid <> f.u1 or pg_temp.audits(f.w1) <> 2 or not (r->>'request_resolved')::boolean then raise exception 'actor_not_recorded %', a; end if;
  -- Un consultorio que no existe y un plan que no existe.
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,%L,now()+interval %L)','00000000-0000-4000-8000-00000000dead','pro','30 days'),'not_found');
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,%L,now()+interval %L)',f.w2,'gold','30 days'),'invalid_plan');
  perform pg_temp.fails(format('select public.admin_set_workspace_plan(%L,null)',f.w2),'invalid_plan');
  -- La auditoría no lleva emails ni nombres.
  if pg_temp.audit_text() ~ '@' or pg_temp.audit_text() ~* 'h28smoke' or pg_temp.audit_text() = '' then raise exception 'pii_in_audit'; end if;
end $$;
reset role;

-- ===== Quién hizo cada cambio =====
-- La auditoría guarda el id; el nombre para el equipo sale solo por la función del backoffice.
update private.bellis_admins set active=true where user_id=(select u4 from fx);
set local role authenticated;
do $$ declare f record; v jsonb; begin
  select * into f from fx;
  -- Quien lo hizo lo ve como "Vos".
  perform pg_temp.as_user(f.u1);
  v := public.admin_plan_changes(f.w1);
  if jsonb_array_length(v) <> 2 or exists(select 1 from jsonb_array_elements(v) x where x->>'actor_label' <> 'Vos' or not (x->>'by_me')::boolean) then raise exception 'own_change_not_labelled_vos %', v; end if;
  -- Otro admin ve quién fue, por su email. Soporte también: lee, no cambia.
  perform pg_temp.as_user(f.u4);
  v := public.admin_plan_changes(f.w1);
  if exists(select 1 from jsonb_array_elements(v) x where x->>'actor_label' <> 'h28-cs-1@example.invalid' or (x->>'by_me')::boolean) then raise exception 'other_admin_not_identified %', v; end if;
  perform pg_temp.as_user(f.u2);
  if (public.admin_plan_changes(f.w1)->0)->>'actor_label' <> 'h28-cs-1@example.invalid' then raise exception 'support_cannot_see_who'; end if;
  -- Lo que sale es una etiqueta: ni el id de la persona ni ningún otro dato de su cuenta.
  if v::text ~ f.u1::text or v::text ~ 'actor_admin_user_id' or exists(select 1 from jsonb_array_elements(v) x, jsonb_object_keys(x) k
    where k not in ('id','action','previous_effective_tier','new_effective_tier','previous_plan_code','new_plan_code','previous_pro_ends_at','new_pro_ends_at','previous_trial_ends_at','new_trial_ends_at','by_me','actor_label','created_at'))
    then raise exception 'actor_identity_leaks %', v; end if;
  -- Nombrar a alguien no abre auth.users: ni para soporte, ni para un admin, ni para la dueña de un consultorio.
  perform pg_temp.fails('select email from auth.users','42501');
  perform pg_temp.as_user(f.u4); perform pg_temp.fails('select email from auth.users','42501');
  perform pg_temp.as_user(f.u3); perform pg_temp.fails('select email from auth.users','42501');
  perform pg_temp.fails(format('select public.admin_plan_changes(%L)',f.w1),'not_found');
end $$;
reset role;
-- Si la cuenta de quien hizo el cambio ya no existe, el historial se conserva y lo dice.
delete from private.bellis_admins where user_id=(select u1 from fx);
update public.plan_change_audit set actor_admin_user_id=null where workspace_id=(select w1 from fx);
do $$ declare v jsonb; begin
  perform pg_temp.as_user((select u4 from fx));
  v := private.admin_plan_changes((select w1 from fx),20);
  if jsonb_array_length(v) <> 2 or (v->0)->>'actor_label' <> 'Alguien que ya no está en el equipo' or ((v->0)->>'by_me')::boolean then raise exception 'missing_actor_label_wrong %', v; end if;
end $$;
select 'admin_commercial_security_ok' result;
rollback;
