-- H2.8A Resumen del backoffice: los números, contados contra lo que había antes del fixture.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f9100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ov-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f9100000-0000-4000-8000-000000000001','admin',true),('f9100000-0000-4000-8000-000000000002','support',true),('f9100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f9100000-0000-4000-8000-000000000001'::uuid u1,'f9100000-0000-4000-8000-000000000002'::uuid u2,'f9100000-0000-4000-8000-000000000003'::uuid u3,'f9100000-0000-4000-8000-000000000004'::uuid u4,'f9100000-0000-4000-8000-000000000005'::uuid u5,'f9100000-0000-4000-8000-000000000006'::uuid u6,
  'f9100000-0000-4000-8000-0000000000a1'::uuid w1,'f9100000-0000-4000-8000-0000000000a2'::uuid w2,'f9100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f9100000-0000-4000-8000-0000000000b1'::uuid pr1,'f9100000-0000-4000-8000-0000000000b2'::uuid pr2,'f9100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f9100000-0000-4000-8000-0000000000c1'::uuid s1,'f9100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f9100000-0000-4000-8000-0000000000d1'::uuid p1,'f9100000-0000-4000-8000-0000000000d2'::uuid p2,'f9100000-0000-4000-8000-0000000000e1'::uuid i1,'f9100000-0000-4000-8000-0000000000e2'::uuid i2;
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

do $$ begin
  perform pg_temp.as_user((select u1 from fx));
  insert into memo values('before',private.admin_overview());
end $$;

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f9100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ov-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-ov-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-ov-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-ov-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-ov-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-ov-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-ov-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-ov'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

create function pg_temp.delta(p_key text) returns integer language sql as $$
  select (private.admin_overview()->>p_key)::integer - ((select value from memo where tag='before')->>p_key)::integer $$;
create function pg_temp.expect(p_key text,p_delta integer) returns void language plpgsql as $$
begin if pg_temp.delta(p_key) <> p_delta then raise exception '% changed by %, expected %', p_key, pg_temp.delta(p_key), p_delta; end if; end $$;

do $$ declare f record; v jsonb; k text; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);
  v := private.admin_overview();
  foreach k in array array['total_users','total_workspaces','onboarded_workspaces','active_7d','active_30d','pro_trial_active','pro_active','free_active',
    'upgrade_requests_open','registrations_last_7d','registrations_last_30d','trials_expiring_7d','workspaces_with_booking_paused','suspended_workspaces','generated_at'] loop
    if not v ? k then raise exception 'overview_missing %', k; end if;
  end loop;
  -- Tres registros: dos con onboarding (uno en prueba, uno Pro) y uno sin terminar, que es Free.
  perform pg_temp.expect('total_users',3); perform pg_temp.expect('registrations_last_7d',3); perform pg_temp.expect('registrations_last_30d',3);
  perform pg_temp.expect('total_workspaces',3); perform pg_temp.expect('onboarded_workspaces',2);
  perform pg_temp.expect('pro_trial_active',1); perform pg_temp.expect('pro_active',1); perform pg_temp.expect('free_active',1);
  -- Registrarse no es actividad; terminar el onboarding sí.
  perform pg_temp.expect('active_7d',2); perform pg_temp.expect('active_30d',2);
  perform pg_temp.expect('upgrade_requests_open',0); perform pg_temp.expect('workspaces_with_booking_paused',0);
  perform pg_temp.expect('trials_expiring_7d',0); perform pg_temp.expect('suspended_workspaces',0);
  -- Solo números: ni emails ni nombres.
  if v::text ~ '@' or v::text ~* 'h28smoke' then raise exception 'overview_has_pii'; end if;
end $$;

-- Un pedido de Pro, una prueba por vencer, una página pausada y una suspensión.
set local role authenticated;
do $$ begin perform pg_temp.as_user((select u3 from fx)); perform public.request_pro_upgrade((select w1 from fx)); end $$;
reset role;
do $$ declare f record; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u1);
  perform pg_temp.expect('upgrade_requests_open',1);
  update public.workspaces set trial_started_at=now()-interval '27 days',trial_ends_at=now()+interval '3 days' where id=f.w1;
  perform pg_temp.expect('trials_expiring_7d',1);
  -- Sin link de pago, la página de W1 queda publicada pero nadie puede reservar.
  update public.workspaces set external_payment_url=null where id=f.w1;
  perform pg_temp.expect('workspaces_with_booking_paused',1);
  -- La prueba vence: pasa a Free sin que se escriba nada.
  update public.workspaces set trial_started_at=now()-interval '40 days',trial_ends_at=now()-interval '9 days' where id=f.w1;
  perform pg_temp.expect('pro_trial_active',0); perform pg_temp.expect('free_active',2); perform pg_temp.expect('trials_expiring_7d',0);
  -- Actividad vieja deja de contar para 7 días y después para 30.
  update public.product_events set created_at=now()-interval '10 days' where workspace_id=f.w1;
  perform pg_temp.expect('active_7d',1); perform pg_temp.expect('active_30d',2);
  update public.product_events set created_at=now()-interval '40 days' where workspace_id=f.w1;
  perform pg_temp.expect('active_30d',1);
  -- Un suspendido sale de los tres planes.
  update public.workspaces set status='suspended' where id=f.w3;
  perform pg_temp.expect('suspended_workspaces',1); perform pg_temp.expect('pro_active',0); perform pg_temp.expect('total_workspaces',3);
end $$;
select 'admin_overview_ok' result;
rollback;
