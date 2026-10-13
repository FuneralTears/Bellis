-- H2.8A Seguridad del backoffice: quién puede leer datos internos y quién no.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('fb100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-sec-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('fb100000-0000-4000-8000-000000000001','admin',true),('fb100000-0000-4000-8000-000000000002','support',true),('fb100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'fb100000-0000-4000-8000-000000000001'::uuid u1,'fb100000-0000-4000-8000-000000000002'::uuid u2,'fb100000-0000-4000-8000-000000000003'::uuid u3,'fb100000-0000-4000-8000-000000000004'::uuid u4,'fb100000-0000-4000-8000-000000000005'::uuid u5,'fb100000-0000-4000-8000-000000000006'::uuid u6,
  'fb100000-0000-4000-8000-0000000000a1'::uuid w1,'fb100000-0000-4000-8000-0000000000a2'::uuid w2,'fb100000-0000-4000-8000-0000000000a3'::uuid w3,
  'fb100000-0000-4000-8000-0000000000b1'::uuid pr1,'fb100000-0000-4000-8000-0000000000b2'::uuid pr2,'fb100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'fb100000-0000-4000-8000-0000000000c1'::uuid s1,'fb100000-0000-4000-8000-0000000000c3'::uuid s3,
  'fb100000-0000-4000-8000-0000000000d1'::uuid p1,'fb100000-0000-4000-8000-0000000000d2'::uuid p2,'fb100000-0000-4000-8000-0000000000e1'::uuid i1,'fb100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('fb100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-sec-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-sec-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-sec-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-sec-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-sec-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-sec-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-sec-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-sec'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

-- ===== Permisos sobre los objetos =====
do $$ declare v text; begin
  if has_table_privilege('authenticated','private.bellis_admins','select') or has_table_privilege('anon','private.bellis_admins','select')
    or has_table_privilege('authenticated','private.bellis_admins','insert') or has_table_privilege('authenticated','private.bellis_admins','update')
    or has_table_privilege('service_role','private.bellis_admins','select')
    then raise exception 'bellis_admins_exposed'; end if;
  if not (select relrowsecurity from pg_class where oid='private.bellis_admins'::regclass) then raise exception 'bellis_admins_without_rls'; end if;
  -- Lo interno no se llama desde la API.
  foreach v in array array['private.bellis_admin_role()','private.is_bellis_admin(text[])','private.require_bellis_admin(text[])','private.admin_workspace_rows()'] loop
    if has_function_privilege('authenticated',v,'execute') or has_function_privilege('anon',v,'execute') then raise exception 'internal_function_exposed %',v; end if;
  end loop;
  -- Lo público exige sesión; después cada función valida que sea del equipo.
  foreach v in array array['public.bellis_admin_session()','public.admin_overview()','public.admin_workspace_detail(uuid)','public.admin_recent_activity(integer)',
    'public.admin_workspaces(text,text,text,text,boolean,boolean,text,integer,integer)'] loop
    if has_function_privilege('anon',v,'execute') then raise exception 'anon_can_call %',v; end if;
    if not has_function_privilege('authenticated',v,'execute') then raise exception 'authenticated_cannot_call %',v; end if;
  end loop;
  -- Nadie quedó cargado por la migración: los únicos admins son los de este smoke.
  if (select count(*) from private.bellis_admins where user_id not in ((select u1 from fx),(select u2 from fx),(select u4 from fx)) and user_id::text like 'fb100000%') <> 0
    then raise exception 'unexpected_admin'; end if;
end $$;

update auth.users set last_sign_in_at=now()-interval '3 hours' where id=(select u3 from fx);

-- ===== Quien no es del equipo no lee nada =====
set local role authenticated;
do $$ declare f record; v_user uuid; q text; begin
  select * into f from fx;
  -- El dueño de un consultorio (ni siquiera sobre el suyo), el dueño de otro, un admin dado de baja y una sesión sin usuario.
  foreach v_user in array array[f.u3,f.u5,f.u4,null] loop
    perform pg_temp.as_user(v_user);
    foreach q in array array['select public.bellis_admin_session()','select public.admin_overview()','select public.admin_workspaces()',
      format('select public.admin_workspace_detail(%L)',f.w1),'select public.admin_recent_activity()'] loop
      perform pg_temp.fails(q,'not_found');
    end loop;
  end loop;
  -- Tampoco por la tabla ni por las funciones internas, ni puede promoverse a sí mismo.
  perform pg_temp.as_user(f.u3);
  perform pg_temp.fails('select * from private.bellis_admins','42501');
  perform pg_temp.fails(format('insert into private.bellis_admins(user_id,role) values(%L,%L)',f.u3,'admin'),'42501');
  perform pg_temp.fails('select private.is_bellis_admin()','42501');
  perform pg_temp.fails('select private.require_bellis_admin()','42501');
  perform pg_temp.fails('select * from private.admin_workspace_rows()','42501');
  perform pg_temp.fails('select * from public.product_events','42501');
  -- La fecha del último ingreso vive en auth.users: nadie la lee directo.
  perform pg_temp.fails('select last_sign_in_at from auth.users','42501');
end $$;
reset role;
set local role anon;
do $$ begin
  perform pg_temp.fails('select public.admin_overview()','42501');
  perform pg_temp.fails('select public.bellis_admin_session()','42501');
  perform pg_temp.fails('select * from public.product_events','42501');
end $$;
reset role;

-- ===== El equipo sí =====
set local role authenticated;
do $$ declare f record; v jsonb; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);
  if public.bellis_admin_session()->>'role' <> 'admin' then raise exception 'admin_role_wrong'; end if;
  if (public.admin_overview()->>'total_workspaces')::int < 3 then raise exception 'admin_cannot_read_overview'; end if;
  v := public.admin_workspaces('h28smoke');
  if (v->>'total')::int <> 3 then raise exception 'admin_cannot_list %', v->>'total'; end if;
  if public.admin_workspace_detail(f.w1)->>'workspace_name' <> 'H28smoke Uno' then raise exception 'admin_cannot_read_detail'; end if;
  -- El último ingreso llega solo por acá, y solo al equipo.
  if (public.admin_workspace_detail(f.w1)->>'last_sign_in_at')::timestamptz <> now()-interval '3 hours' then raise exception 'admin_cannot_read_last_sign_in'; end if;
  if ((public.admin_workspaces('h28smoke uno')->'rows'->0)->>'last_sign_in_at') is null then raise exception 'list_without_last_sign_in'; end if;
  if jsonb_array_length(public.admin_recent_activity(5)) <> 5 then raise exception 'admin_cannot_read_activity'; end if;
  -- Soporte lee lo mismo.
  perform pg_temp.as_user(f.u2);
  if public.bellis_admin_session()->>'role' <> 'support' then raise exception 'support_role_wrong'; end if;
  if (public.admin_workspaces('h28smoke')->>'total')::int <> 3 then raise exception 'support_cannot_list'; end if;
  if public.admin_workspace_detail(f.w3)->>'effective_tier' <> 'pro' then raise exception 'support_cannot_read_detail'; end if;
end $$;
reset role;

-- ===== Roles y baja =====
do $$ declare f record; begin
  select * into f from fx;
  -- Lo reservado a admin no alcanza a soporte.
  perform pg_temp.as_user(f.u2);
  if private.is_bellis_admin(array['admin']) then raise exception 'support_passes_as_admin'; end if;
  perform pg_temp.fails($q$select private.require_bellis_admin(array['admin'])$q$,'not_found');
  perform pg_temp.as_user(f.u1);
  perform private.require_bellis_admin(array['admin']);
  -- Dar de baja a alguien corta el acceso en el momento.
  update private.bellis_admins set active=false where user_id=f.u2;
  perform pg_temp.as_user(f.u2);
  if private.is_bellis_admin() then raise exception 'inactive_admin_still_passes'; end if;
  perform pg_temp.fails('select private.admin_overview()','not_found');
  -- Ser dueño o admin de un workspace no da nada.
  update public.workspace_members set role='admin' where user_id=f.u5;
  perform pg_temp.as_user(f.u5);
  perform pg_temp.fails('select private.admin_overview()','not_found');
end $$;
select 'admin_security_ok' result;
rollback;
