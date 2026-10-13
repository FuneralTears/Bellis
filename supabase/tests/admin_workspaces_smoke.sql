-- H2.8A Lista de workspaces del backoffice: filtros, orden, paginado y qué columnas salen.
-- Datos sintéticos: usuarios @example.invalid y consultorios propios de este smoke. Ningún usuario ni workspace real.
-- Una sola transacción, que se revierte al final.
begin;
-- u1 admin de Bellis, u2 soporte, u4 admin dado de baja. u3, u5 y u6 son dueños de consultorios y nada más.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('f8100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ws-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[1,2,4]) n;
insert into private.bellis_admins(user_id,role,active) values
  ('f8100000-0000-4000-8000-000000000001','admin',true),('f8100000-0000-4000-8000-000000000002','support',true),('f8100000-0000-4000-8000-000000000004','admin',false);
create temp table fx as select
  'f8100000-0000-4000-8000-000000000001'::uuid u1,'f8100000-0000-4000-8000-000000000002'::uuid u2,'f8100000-0000-4000-8000-000000000003'::uuid u3,'f8100000-0000-4000-8000-000000000004'::uuid u4,'f8100000-0000-4000-8000-000000000005'::uuid u5,'f8100000-0000-4000-8000-000000000006'::uuid u6,
  'f8100000-0000-4000-8000-0000000000a1'::uuid w1,'f8100000-0000-4000-8000-0000000000a2'::uuid w2,'f8100000-0000-4000-8000-0000000000a3'::uuid w3,
  'f8100000-0000-4000-8000-0000000000b1'::uuid pr1,'f8100000-0000-4000-8000-0000000000b2'::uuid pr2,'f8100000-0000-4000-8000-0000000000b3'::uuid pr3,
  'f8100000-0000-4000-8000-0000000000c1'::uuid s1,'f8100000-0000-4000-8000-0000000000c3'::uuid s3,
  'f8100000-0000-4000-8000-0000000000d1'::uuid p1,'f8100000-0000-4000-8000-0000000000d2'::uuid p2,'f8100000-0000-4000-8000-0000000000e1'::uuid i1,'f8100000-0000-4000-8000-0000000000e2'::uuid i2;
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
select '00000000-0000-0000-0000-000000000000',('f8100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'h28-ws-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from unnest(array[3,5,6]) n;
insert into public.workspaces(id,name,slug,payment_provider,external_payment_url,onboarding_completed_at) values
  ((select w1 from fx),'H28smoke Uno','h28-ws-1','external_link','https://pagos.example/h28',now()),
  ((select w2 from fx),'H28smoke Dos','h28-ws-2','mercado_pago_ar',null,null),
  ((select w3 from fx),'H28smoke Tres','h28-ws-3','mercado_pago_ar',null,now());
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u3,'owner'::public.workspace_role from fx union all select w2,u5,'owner' from fx union all select w3,u6,'owner' from fx;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u3,'Smoke Uno','Psicología','h28-ws-a' from fx union all select pr2,w2,u5,'Smoke Dos','Nutrición','h28-ws-b' from fx
union all select pr3,w3,u6,'Smoke Tres','Kinesiología','h28-ws-c' from fx;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality,min_notice_minutes)
select s1,w1,pr1,'Consulta',1000000,60,'online',0 from fx union all select s3,w3,pr3,'Consulta',1000000,60,'online',0 from fx;
insert into private.mercado_pago_accounts(workspace_id,seller_user_id,access_token_secret_id,environment,token_expires_at)
select w3,'h28',vault.create_secret('fake-h28-ws'),'test',now()+interval '1 day' from fx;
select private.start_workspace_trial((select w1 from fx));
update public.workspaces set plan_code='pro',pro_started_at=now()-interval '5 days',pro_ends_at=now()+interval '25 days' where id=(select w3 from fx);

insert into public.patients(id,workspace_id,first_name,last_name,email,created_by)
select p1,w1,'Zzsecreto','Manual','h28-ws-p1@example.invalid',u3 from fx union all select p2,w1,'Zzsecreto','Publico','h28-ws-p2@example.invalid',null from fx;
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes,expires_at,source,created_by)
select i1,w1,pr1,s1,p1,'scheduled'::public.booking_status,1000000,60,now()+interval '1 day','manual',u3 from fx
union all select i2,w1,pr1,s1,p2,'scheduled',1000000,60,now()+interval '1 day','public',null from fx;
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i1,pr1,p1,now()+interval '2 days',now()+interval '2 days 1 hour','scheduled'::public.booking_status from fx
union all select w1,i2,pr1,p2,now()+interval '3 days',now()+interval '3 days 1 hour','scheduled' from fx;
insert into public.patient_notes(workspace_id,patient_id,author_id,content) select w1,p1,u3,'Zzsecreto nota clínica' from fx;
insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,description,due_date,created_by)
select w1,p1,pr1,'Zzsecreto seguimiento','Zzsecreto detalle',current_date+1,u3 from fx;

set local role authenticated;
do $$ begin perform pg_temp.as_user((select u6 from fx)); perform public.request_pro_upgrade((select w3 from fx)); end $$;
reset role;
-- W3 tuvo actividad hace tiempo: sirve para ordenar y para separar 7 de 30 días.
update public.product_events set created_at=now()-interval '12 days' where workspace_id=(select w3 from fx);

create function pg_temp.names(p jsonb) returns text language sql as $$
  select coalesce(string_agg(r->>'workspace_name',',' order by ord),'') from jsonb_array_elements(p->'rows') with ordinality t(r,ord) $$;

set local role authenticated;
do $$ declare f record; v jsonb; r jsonb; k text; begin
  select * into f from fx;
  perform pg_temp.as_user(f.u2);

  -- Búsqueda: por nombre, por email de quien la creó, por profesión y por id. Los comodines se buscan como texto.
  v := public.admin_workspaces('h28smoke');
  if (v->>'total')::int <> 3 or jsonb_array_length(v->'rows') <> 3 then raise exception 'search_by_name %', v->>'total'; end if;
  if (public.admin_workspaces('H28-WS-5@example')->>'total')::int <> 1 then raise exception 'search_by_email'; end if;
  if pg_temp.names(public.admin_workspaces('h28-ws-5@example')) <> 'H28smoke Dos' then raise exception 'search_by_email_row'; end if;
  if (public.admin_workspaces(f.w3::text)->>'total')::int <> 1 then raise exception 'search_by_id'; end if;
  if (public.admin_workspaces('h28smoke%zz')->>'total')::int <> 0 or (public.admin_workspaces('h28smok_ uno')->>'total')::int <> 0 then raise exception 'wildcards_not_escaped'; end if;
  if (public.admin_workspaces('zz-nada-h28-zz')->>'total')::int <> 0 then raise exception 'search_matches_everything'; end if;

  -- Columnas: las que el equipo necesita, y nada clínico.
  r := (public.admin_workspaces('h28smoke uno')->'rows')->0;
  foreach k in array array['workspace_id','workspace_name','owner_email','profession','registered_at','onboarding_completed','effective_tier','trial_ends_at','pro_ends_at',
    'last_sign_in_at','last_activity_at','active_7d','active_30d','patient_count','appointment_count','public_booking_count','followup_count','automation_count','upgrade_request_open',
    'payment_provider','mercado_pago_connected','booking_available'] loop
    if not r ? k then raise exception 'row_missing %', k; end if;
  end loop;
  if r->>'owner_email' <> 'h28-ws-3@example.invalid' or r->>'profession' <> 'Psicología' or r->>'effective_tier' <> 'pro_trial' then raise exception 'row_account_wrong %', r; end if;
  if (r->>'patient_count')::int <> 2 or (r->>'appointment_count')::int <> 2 or (r->>'public_booking_count')::int <> 1 or (r->>'followup_count')::int <> 1
    or (r->>'automation_count')::int <> 0 then raise exception 'row_counts_wrong %', r; end if;
  if not (r->>'active_7d')::boolean or not (r->>'booking_available')::boolean or (r->>'mercado_pago_connected')::boolean or (r->>'upgrade_request_open')::boolean
    or r->>'payment_provider' <> 'external_link' then raise exception 'row_state_wrong %', r; end if;
  if public.admin_workspaces('h28smoke')::text ~* 'zzsecreto' then raise exception 'clinical_text_in_list'; end if;

  -- Filtros.
  if pg_temp.names(public.admin_workspaces('h28smoke','incomplete')) <> 'H28smoke Dos' then raise exception 'filter_onboarding_incomplete'; end if;
  if (public.admin_workspaces('h28smoke','complete')->>'total')::int <> 2 then raise exception 'filter_onboarding_complete'; end if;
  if pg_temp.names(public.admin_workspaces('h28smoke',null,'pro_trial')) <> 'H28smoke Uno' or pg_temp.names(public.admin_workspaces('h28smoke',null,'pro')) <> 'H28smoke Tres'
    or pg_temp.names(public.admin_workspaces('h28smoke',null,'free')) <> 'H28smoke Dos' then raise exception 'filter_tier'; end if;
  if pg_temp.names(public.admin_workspaces('h28smoke',null,null,'7d')) <> 'H28smoke Uno' then raise exception 'filter_active_7d %', pg_temp.names(public.admin_workspaces('h28smoke',null,null,'7d')); end if;
  if (public.admin_workspaces('h28smoke',null,null,'30d')->>'total')::int <> 2 then raise exception 'filter_active_30d'; end if;
  if pg_temp.names(public.admin_workspaces('h28smoke',null,null,null,true)) <> 'H28smoke Tres' then raise exception 'filter_upgrade_requested'; end if;
  if (public.admin_workspaces('h28smoke',null,null,null,false,true)->>'total')::int <> 0 then raise exception 'filter_booking_paused_before'; end if;
  if (public.admin_workspaces('h28smoke','complete','pro',null,true)->>'total')::int <> 1 or (public.admin_workspaces('h28smoke','incomplete','pro')->>'total')::int <> 0
    then raise exception 'filters_do_not_combine'; end if;

  -- Orden.
  if pg_temp.names(public.admin_workspaces('h28smoke',p_sort => 'last_activity')) <> 'H28smoke Uno,H28smoke Tres,H28smoke Dos' then raise exception 'sort_last_activity %', pg_temp.names(public.admin_workspaces('h28smoke',p_sort => 'last_activity')); end if;
  if split_part(pg_temp.names(public.admin_workspaces('h28smoke',p_sort => 'trial_ending')),',',1) <> 'H28smoke Uno' then raise exception 'sort_trial_ending'; end if;
  if split_part(pg_temp.names(public.admin_workspaces('h28smoke',p_sort => 'most_active')),',',1) <> 'H28smoke Uno' then raise exception 'sort_most_active'; end if;
  if (public.admin_workspaces('h28smoke',p_sort => 'newest')->>'total')::int <> 3 then raise exception 'sort_newest'; end if;

  -- Paginado: el total no cambia, las páginas no se pisan y el tamaño tiene tope.
  v := public.admin_workspaces('h28smoke',p_sort => 'last_activity',p_limit => 2);
  if (v->>'total')::int <> 3 or pg_temp.names(v) <> 'H28smoke Uno,H28smoke Tres' then raise exception 'page_one %', pg_temp.names(v); end if;
  v := public.admin_workspaces('h28smoke',p_sort => 'last_activity',p_limit => 2,p_offset => 2);
  if (v->>'total')::int <> 3 or pg_temp.names(v) <> 'H28smoke Dos' then raise exception 'page_two %', pg_temp.names(v); end if;
  if (public.admin_workspaces(p_limit => 100000)->>'limit')::int <> 100 or (public.admin_workspaces(p_limit => 0)->>'limit')::int <> 1
    or (public.admin_workspaces(p_offset => -5)->>'offset')::int <> 0 then raise exception 'limit_not_clamped'; end if;

  -- Un filtro desconocido se rechaza: no se ignora en silencio.
  perform pg_temp.fails($q$select public.admin_workspaces(p_tier => 'gold')$q$,'invalid_filter');
  perform pg_temp.fails($q$select public.admin_workspaces(p_onboarding => 'maybe')$q$,'invalid_filter');
  perform pg_temp.fails($q$select public.admin_workspaces(p_active => '90d')$q$,'invalid_filter');
  perform pg_temp.fails($q$select public.admin_workspaces(p_sort => 'name; drop table x')$q$,'invalid_filter');
end $$;
reset role;

-- Reservas en pausa: Mercado Pago elegido sin cuenta conectada, o link externo sin link.
update private.mercado_pago_accounts set status='disconnected',active=false where workspace_id=(select w3 from fx);
update public.workspaces set external_payment_url=null where id=(select w1 from fx);
set local role authenticated;
do $$ declare v jsonb; begin
  perform pg_temp.as_user((select u1 from fx));
  v := public.admin_workspaces('h28smoke',null,null,null,false,true,'newest');
  -- W2 no terminó el onboarding: no tiene página publicada, así que no cuenta como pausada.
  if (v->>'total')::int <> 2 or v::text ~ 'H28smoke Dos' then raise exception 'filter_booking_paused %', pg_temp.names(v); end if;
  if ((v->'rows'->0)->>'booking_available')::boolean then raise exception 'paused_row_says_available'; end if;
end $$;
reset role;

-- ===== Último acceso y última actividad son dos cosas distintas =====
create function pg_temp.w(p_workspace uuid) returns jsonb language sql as $$
  select to_jsonb(r) from private.admin_workspace_rows() r where r.workspace_id=p_workspace $$;
-- Deja a W1 sin actividad reciente, para medir de a un evento.
create function pg_temp.quiet() returns void language sql as $$
  update public.product_events set created_at=now()-interval '45 days' where workspace_id=(select w1 from fx) $$;
create function pg_temp.must_be_active(p_what text) returns void language plpgsql as $$
declare r jsonb := pg_temp.w((select w1 from fx));
begin
  if not (r->>'active_7d')::boolean or not (r->>'active_30d')::boolean or (r->>'events_7d')::int <> 1 or (r->>'last_activity_at')::timestamptz <> now()
    then raise exception '% does not count as activity: %', p_what, r; end if;
  perform pg_temp.quiet();
  if (pg_temp.w((select w1 from fx))->>'active_30d')::boolean then raise exception 'still active after %', p_what; end if;
end $$;
do $$ declare f record; r jsonb; v_payment uuid; begin
  select * into f from fx;
  -- W2 nunca entró ni hizo nada.
  r := pg_temp.w(f.w2);
  if r->>'last_sign_in_at' is not null or r->>'last_activity_at' is not null or (r->>'active_7d')::boolean then raise exception 'idle_workspace_wrong %', r; end if;
  -- Iniciar sesión se ve como último acceso, y nada más: no vuelve activo al consultorio.
  update auth.users set last_sign_in_at=now()-interval '2 hours' where id=f.u5;
  r := pg_temp.w(f.w2);
  if (r->>'last_sign_in_at')::timestamptz <> now()-interval '2 hours' then raise exception 'last_sign_in_missing %', r; end if;
  if (r->>'active_7d')::boolean or (r->>'active_30d')::boolean or (r->>'events_30d')::int <> 0 or r->>'last_activity_at' is not null then raise exception 'login_counts_as_activity %', r; end if;
  if exists(select 1 from public.product_events where workspace_id=f.w2 and event_name <> 'user_registered') then raise exception 'login_created_an_event'; end if;
  -- Y al revés: actividad sin un ingreso registrado no inventa un último acceso.
  if pg_temp.w(f.w1)->>'last_sign_in_at' is not null then raise exception 'activity_set_last_sign_in'; end if;
  -- Con más de una persona en el consultorio, cuenta el ingreso más reciente.
  insert into public.workspace_members(workspace_id,user_id,role) values(f.w2,f.u4,'professional');
  update auth.users set last_sign_in_at=now()-interval '10 minutes' where id=f.u4;
  if (pg_temp.w(f.w2)->>'last_sign_in_at')::timestamptz <> now()-interval '10 minutes' then raise exception 'latest_sign_in_not_used'; end if;

  -- Cada una de las cuatro acciones nuevas, sola, vuelve activo a un consultorio que no lo estaba.
  perform pg_temp.quiet();
  if (pg_temp.w(f.w1)->>'active_30d')::boolean then raise exception 'fixture_still_active'; end if;
  insert into public.payments(workspace_id,booking_intent_id,provider,amount_minor,status) values(f.w1,f.i1,'external_link',1000000,'pending') returning id into v_payment;
  if (pg_temp.w(f.w1)->>'active_30d')::boolean then raise exception 'pending_payment_counts_as_activity'; end if;
  update public.payments set status='approved',approved_at=now() where id=v_payment;
  perform pg_temp.must_be_active('payment_recorded');
  update public.appointments set status='completed' where booking_intent_id=f.i1;
  perform pg_temp.must_be_active('appointment_completed');
  update public.appointments set status='cancelled' where booking_intent_id=f.i2;
  perform pg_temp.must_be_active('appointment_cancelled');
  insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w1,f.p1,f.u3,'Zzsecreto segunda nota');
  perform pg_temp.must_be_active('patient_note_created');
  -- Lo comercial no es actividad.
  perform private.record_product_event('upgrade_requested',f.w1,f.u3,'workspace',f.w1);
  perform private.record_product_event('pro_activated',f.w1,null,'workspace',f.w1);
  perform private.record_product_event('trial_expired',f.w1,null,'workspace',f.w1,jsonb_build_object('ended_at',now()));
  if (pg_temp.w(f.w1)->>'active_30d')::boolean then raise exception 'commercial_event_counts_as_activity'; end if;
  -- El texto de las notas no está en ningún evento.
  if exists(select 1 from public.product_events e where e.workspace_id in (f.w1,f.w2,f.w3) and to_jsonb(e)::text ~* 'zzsecreto') then raise exception 'note_text_in_events'; end if;
end $$;
select 'admin_workspaces_ok' result;
rollback;
