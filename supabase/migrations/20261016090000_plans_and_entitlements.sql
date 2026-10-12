-- H2.7: Bellis Free, la prueba de Bellis Pro y Bellis Pro. Modelo comercial y una sola fuente de verdad para
-- saber qué puede hacer un workspace.
--
-- Lo que se guarda es el plan (free | pro) y las fechas. La prueba no es un plan: es un período con fechas.
-- El acceso efectivo (free | pro_trial | pro) se resuelve siempre por fecha, en private.workspace_tier. Cuando
-- termina la prueba o el Pro no se escribe ni se borra nada: solo cambia lo que responde esa función.
-- `status` deja de hablar de la prueba y queda como estado operativo: active | suspended.

-- La prueba dura 30 días calendario y termina al final del día 30 en hora de Argentina: quien empieza el 14/10
-- conserva Pro durante todo el 13/11. Se guarda el instante en que deja de valer (00:00 del día siguiente).
create function private.trial_end_for(p_start timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$
  select ((p_start at time zone 'America/Argentina/Buenos_Aires')::date + 31)::timestamp
    at time zone 'America/Argentina/Buenos_Aires';
$$;
revoke all on function private.trial_end_for(timestamptz) from public,anon,authenticated;

-- trial_started_at y trial_ends_at ya existían (20260928030100 y la migración inicial), obligatorias y con valor
-- por defecto desde el registro. Pasan a ser opcionales y sin valor por defecto: una cuenta nueva no tiene prueba
-- hasta que termina el onboarding.
alter table public.workspaces
  alter column trial_started_at drop not null,
  alter column trial_started_at drop default,
  add column pro_started_at timestamptz,
  add column pro_ends_at timestamptz,
  add column plan_updated_at timestamptz not null default now(),
  alter column trial_ends_at drop not null,
  alter column trial_ends_at drop default;

-- Lo que había: status 'trial' con una ventana de 30 días desde el registro, que al vencer apagaba la página
-- pública. Esa ventana no era una prueba de Pro y deja de existir. Ningún workspace queda con fechas viejas.
alter table public.workspaces drop constraint workspaces_status_check;
update public.workspaces set status='active' where status='trial';
update public.workspaces set plan_code='free',trial_started_at=null,trial_ends_at=null;
alter table public.workspaces
  alter column status set default 'active',
  alter column plan_code set default 'free',
  add constraint workspaces_status_check check (status in ('active','suspended')),
  add constraint workspaces_plan_code_check check (plan_code in ('free','pro')),
  -- Una prueba tiene principio y fin, o no existe. trial_started_at con valor = la prueba ya fue otorgada.
  add constraint workspaces_trial_window check ((trial_started_at is null) = (trial_ends_at is null)
    and (trial_ends_at is null or trial_ends_at > trial_started_at)),
  add constraint workspaces_pro_window check ((plan_code <> 'pro' or pro_started_at is not null)
    and (pro_ends_at is null or (pro_started_at is not null and pro_ends_at > pro_started_at)));
comment on column public.workspaces.plan_code is 'Plan guardado: free | pro. La prueba no es un plan; ver private.workspace_tier.';
comment on column public.workspaces.trial_started_at is 'Cuándo empezó la prueba de Bellis Pro. Con valor, la prueba ya fue otorgada y no vuelve a empezar.';
comment on column public.workspaces.trial_ends_at is 'Instante en que la prueba deja de valer (00:00 de Argentina del día siguiente al último).';
comment on column public.workspaces.pro_ends_at is 'Hasta cuándo vale Bellis Pro. Pasada la fecha el workspace resuelve a Free sin que se escriba nada.';

-- La prueba empieza una sola vez por workspace. Llamarla de nuevo no cambia nada ni deja otro evento.
create function private.start_workspace_trial(p_workspace uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.workspaces set trial_started_at=now(),trial_ends_at=private.trial_end_for(now()),plan_updated_at=now()
  where id=p_workspace and trial_started_at is null;
  if not found then return false; end if;
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(p_workspace,(select auth.uid()),'trial_started','workspace',p_workspace);
  return true;
end $$;
revoke all on function private.start_workspace_trial(uuid) from public,anon,authenticated;

-- Workspaces que ya existen al aplicar esta migración: los que terminaron el onboarding reciben su prueba de
-- 30 días desde ahora, una sola vez. Los que no lo terminaron la reciben cuando lo completen.
select private.start_workspace_trial(w.id) from public.workspaces w where w.onboarding_completed_at is not null;

-- El acceso efectivo, por fecha. Es la única función que decide en qué plan está un workspace.
create function private.workspace_tier(p_workspace uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when w.plan_code='pro' and w.pro_started_at <= now() and (w.pro_ends_at is null or now() < w.pro_ends_at) then 'pro'
    when w.trial_started_at <= now() and now() < w.trial_ends_at then 'pro_trial'
    else 'free' end
  from public.workspaces w where w.id=p_workspace;
$$;
revoke all on function private.workspace_tier(uuid) from public,anon,authenticated;
grant execute on function private.workspace_tier(uuid) to service_role;

-- Qué incluye cada plan. Es el único lugar donde se decide: agregar una capacidad Pro es agregarla acá.
-- Free es todo lo necesario para trabajar a mano. La prueba y Pro tienen lo mismo.
-- Las últimas siete están reservadas para funciones que todavía no existen.
create function private.plan_capabilities(p_tier text) returns text[]
language sql immutable set search_path = '' as $$
  select array['manual_patients','manual_appointments','manual_payments','manual_followups','public_booking','external_payment_link']
    || case when p_tier in ('pro','pro_trial') then array['mercado_pago','automations','smart_followups',
      'patient_origin','advanced_tags','insurance_management','weekly_metrics','advanced_insights','reports','marketing_tools']
      else array[]::text[] end;
$$;
revoke all on function private.plan_capabilities(text) from public,anon,authenticated;

create function private.workspace_has_capability(p_workspace uuid,p_capability text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_capability = any(private.plan_capabilities(private.workspace_tier(p_workspace))),false);
$$;
revoke all on function private.workspace_has_capability(uuid,text) from public,anon,authenticated;
grant execute on function private.workspace_has_capability(uuid,text) to service_role;

-- Desde cuándo tiene acceso Pro sin interrupción, o null si hoy no lo tiene. Si pasó de la prueba a Pro sin
-- quedarse sin acceso en el medio, cuenta desde que empezó la prueba.
create function private.workspace_pro_since(p_workspace uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select case private.workspace_tier(p_workspace)
    when 'pro' then case when w.trial_started_at <= w.pro_started_at and w.pro_started_at <= w.trial_ends_at
      then w.trial_started_at else w.pro_started_at end
    when 'pro_trial' then w.trial_started_at end
  from public.workspaces w where w.id=p_workspace;
$$;
revoke all on function private.workspace_pro_since(uuid) from public,anon,authenticated;

-- Para las funciones del servidor que deciden antes de llamar a un proveedor externo.
create function public.workspace_capability(p_workspace uuid,p_capability text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select private.workspace_has_capability(p_workspace,p_capability);
$$;
revoke all on function public.workspace_capability(uuid,text) from public,anon,authenticated;
grant execute on function public.workspace_capability(uuid,text) to service_role;

-- Pedidos de "Quiero Bellis Pro". Nadie los lee ni los escribe desde el navegador: se crean con
-- request_pro_upgrade y los va a consumir el backoffice. Un workspace tiene a lo sumo un pedido abierto.
create table public.plan_upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  contact_email text not null,
  requested_plan text not null default 'pro' check (requested_plan in ('pro')),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status='open') = (resolved_at is null))
);
create unique index plan_upgrade_requests_one_open on public.plan_upgrade_requests(workspace_id) where status='open';
alter table public.plan_upgrade_requests enable row level security;
revoke all on public.plan_upgrade_requests from public,anon,authenticated;
grant all on public.plan_upgrade_requests to service_role;

-- Lo que el panel necesita saber del plan, resuelto en el servidor: el frontend no vuelve a calcular fechas.
-- trial_last_day es el último día con Pro en hora de Argentina; trial_days_remaining es 0 ese día.
create function private.workspace_access(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_workspace public.workspaces%rowtype; v_tier text; v_last date; v_today date;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required'; end if;
  if not private.has_workspace_role(p_workspace,array['owner','admin','professional','reception']::public.workspace_role[])
    then raise exception 'not_authorized'; end if;
  select * into v_workspace from public.workspaces where id=p_workspace;
  v_tier := private.workspace_tier(p_workspace);
  v_today := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_last := ((v_workspace.trial_ends_at - interval '1 second') at time zone 'America/Argentina/Buenos_Aires')::date;
  return jsonb_build_object(
    'tier',v_tier,'plan_code',v_workspace.plan_code,'has_pro_access',v_tier in ('pro','pro_trial'),
    'status',v_workspace.status,
    'trial_started_at',v_workspace.trial_started_at,'trial_ends_at',v_workspace.trial_ends_at,
    'trial_last_day',v_last,
    'trial_days_remaining',case when v_tier='pro_trial' then v_last - v_today end,
    'pro_started_at',v_workspace.pro_started_at,'pro_ends_at',v_workspace.pro_ends_at,
    'capabilities',to_jsonb(private.plan_capabilities(v_tier)),
    'upgrade_requested',exists(select 1 from public.plan_upgrade_requests r where r.workspace_id=p_workspace and r.status='open'));
end $$;
revoke all on function private.workspace_access(uuid) from public,anon,authenticated;
grant execute on function private.workspace_access(uuid) to authenticated;

create function public.workspace_access(p_workspace uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.workspace_access(p_workspace);
$$;
revoke all on function public.workspace_access(uuid) from public,anon;
grant execute on function public.workspace_access(uuid) to authenticated;

-- "Quiero Bellis Pro": deja el pedido con el email de la cuenta. No activa nada. Pedirlo dos veces no crea
-- otro pedido: devuelve el que ya está abierto.
create function private.request_pro_upgrade(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_email text; v_request public.plan_upgrade_requests%rowtype; v_created boolean := false;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_workspace_role(p_workspace,array['owner','admin']::public.workspace_role[])
    then raise exception 'not_authorized'; end if;
  select u.email into v_email from auth.users u where u.id=v_user;
  if nullif(trim(coalesce(v_email,'')),'') is null then raise exception 'email_required'; end if;
  insert into public.plan_upgrade_requests(workspace_id,requested_by,contact_email)
  values(p_workspace,v_user,v_email) on conflict(workspace_id) where status='open' do nothing
  returning * into v_request;
  if found then
    v_created := true;
    insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
    values(p_workspace,v_user,'pro_upgrade_requested','workspace',p_workspace);
  else
    select * into v_request from public.plan_upgrade_requests r where r.workspace_id=p_workspace and r.status='open';
  end if;
  return jsonb_build_object('status',v_request.status,'created',v_created,'requested_at',v_request.created_at);
end $$;
revoke all on function private.request_pro_upgrade(uuid) from public,anon,authenticated;
grant execute on function private.request_pro_upgrade(uuid) to authenticated;

create function public.request_pro_upgrade(p_workspace uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.request_pro_upgrade(p_workspace);
$$;
revoke all on function public.request_pro_upgrade(uuid) from public,anon;
grant execute on function public.request_pro_upgrade(uuid) to authenticated;

-- Activación manual de Bellis Pro, mientras no haya cobro automático. Solo la ejecuta el rol administrador de
-- la base (CLI o SQL editor): ningún rol de la API la tiene, y no hay envoltorio público.
--   select private.admin_set_workspace_plan('<workspace>','pro','2026-12-01 03:00+00');  -- Pro hasta esa fecha
--   select private.admin_set_workspace_plan('<workspace>','pro','2027-01-01 03:00+00');  -- extender
--   select private.admin_set_workspace_plan('<workspace>','free');                       -- volver a Free
-- Devuelve lo que hizo: 'pro_activated', 'plan_changed' o 'unchanged'. Repetir la misma llamada no cambia nada
-- ni deja otro evento. Pasar a Free no borra datos: deja de valer Pro desde ese momento.
create function private.admin_set_workspace_plan(
  p_workspace uuid,p_plan text,p_pro_ends_at timestamptz default null,p_pro_started_at timestamptz default null
) returns text language plpgsql security definer set search_path = '' as $$
declare v_workspace public.workspaces%rowtype; v_active boolean; v_start timestamptz; v_action text;
begin
  select * into v_workspace from public.workspaces where id=p_workspace for update;
  if not found then raise exception 'workspace_not_found'; end if;
  v_active := v_workspace.plan_code='pro' and (v_workspace.pro_ends_at is null or now() < v_workspace.pro_ends_at);
  if p_plan='pro' then
    if p_pro_ends_at is null or p_pro_ends_at <= now() then raise exception 'pro_ends_at_required'; end if;
    -- Un Pro vigente conserva su inicio al extenderse. Uno nuevo, o uno que ya había vencido, empieza ahora.
    v_start := case when v_active and p_pro_started_at is null then v_workspace.pro_started_at else coalesce(p_pro_started_at,now()) end;
    if v_start >= p_pro_ends_at then raise exception 'invalid_pro_window'; end if;
    if v_active and v_workspace.pro_started_at=v_start and v_workspace.pro_ends_at=p_pro_ends_at then return 'unchanged'; end if;
    v_action := case when v_active then 'plan_changed' else 'pro_activated' end;
    update public.workspaces set plan_code='pro',pro_started_at=v_start,pro_ends_at=p_pro_ends_at,plan_updated_at=now()
    where id=p_workspace;
  elsif p_plan='free' then
    if p_pro_ends_at is not null or p_pro_started_at is not null then raise exception 'invalid_plan_arguments'; end if;
    if v_workspace.plan_code='free' then return 'unchanged'; end if;
    v_action := 'plan_changed';
    -- Queda la historia de cuándo fue Pro: el fin pasa a ser ahora si todavía estaba vigente.
    update public.workspaces set plan_code='free',plan_updated_at=now(),
      pro_ends_at=case when v_active and pro_started_at < now() then now() else pro_ends_at end
    where id=p_workspace;
  else
    raise exception 'invalid_plan';
  end if;
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(p_workspace,v_action,'workspace',p_workspace);
  return v_action;
end $$;
revoke all on function private.admin_set_workspace_plan(uuid,text,timestamptz,timestamptz) from public,anon,authenticated,service_role;

-- La prueba empieza al terminar el onboarding, no al registrarse: quien deja el onboarding a medias no gasta días.
-- Es la función de 20260928223000 con una sola línea más, al final.
create or replace function private.complete_bellis_onboarding(p_document jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_workspace uuid; v_professional uuid;
  v_done timestamptz; v_price integer; v_duration integer; v_notice integer; v_buffer integer;
  v_start time; v_end time; v_break_start time; v_break_end time; v_has_break boolean;
  v_day integer; v_days jsonb; v_name text; v_mode text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if pg_catalog.jsonb_typeof(p_document)<>'object' or pg_catalog.pg_column_size(p_document)>8192
    then raise exception 'invalid_onboarding'; end if;
  select w.id,w.onboarding_completed_at into v_workspace,v_done
  from public.workspaces w join public.workspace_members m on m.workspace_id=w.id
  where m.user_id=v_user and m.role='owner'
  order by m.created_at limit 1 for update of w;
  if v_workspace is null then raise exception 'workspace_missing'; end if;
  select id into v_professional from public.professionals
  where workspace_id=v_workspace and user_id=v_user order by created_at limit 1;
  if v_professional is null then raise exception 'professional_missing'; end if;
  if v_done is not null then return; end if;

  v_name := trim(coalesce(p_document->>'service',''));
  if length(v_name) not between 2 and 120
    or length(coalesce(p_document->>'description',''))>1000
    then raise exception 'invalid_service'; end if;
  if coalesce(p_document->>'price','') !~ '^[0-9]{1,7}$'
    or coalesce(p_document->>'duration','') !~ '^[0-9]{2,3}$'
    or coalesce(p_document->>'notice','') !~ '^[0-9]{1,3}$'
    or coalesce(p_document->>'buffer','') !~ '^[0-9]{1,3}$'
    then raise exception 'invalid_service'; end if;
  v_price := (p_document->>'price')::integer;
  v_duration := (p_document->>'duration')::integer;
  v_notice := (p_document->>'notice')::integer;
  v_buffer := (p_document->>'buffer')::integer;
  v_mode := p_document->>'mode';
  if v_price<1 or v_duration not between 15 and 480 or v_notice>720 or v_buffer>240
    or v_mode not in ('Online','Presencial','Ambas') then raise exception 'invalid_service'; end if;
  if coalesce(p_document->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_document->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_document->>'breakStart','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_document->>'breakEnd','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    then raise exception 'invalid_hours'; end if;
  v_start := (p_document->>'start')::time;
  v_end := (p_document->>'end')::time;
  v_break_start := (p_document->>'breakStart')::time;
  v_break_end := (p_document->>'breakEnd')::time;
  v_has_break := v_break_start>v_start and v_break_end<v_end and v_break_end>v_break_start;
  if v_start>=v_end then raise exception 'invalid_hours'; end if;
  if not v_has_break and not (v_break_start=v_break_end or v_break_start>=v_end or v_break_end<=v_start)
    then raise exception 'invalid_break'; end if;
  v_days := p_document->'days';
  if pg_catalog.jsonb_typeof(v_days)<>'array' or pg_catalog.jsonb_array_length(v_days)<>7
    or not exists(select 1 from pg_catalog.jsonb_array_elements(v_days) d where d.value='true'::jsonb)
    or exists(select 1 from pg_catalog.jsonb_array_elements(v_days) d where d.value not in ('true'::jsonb,'false'::jsonb))
    then raise exception 'invalid_days'; end if;

  if not exists(select 1 from public.services where workspace_id=v_workspace and professional_id=v_professional) then
    insert into public.services(workspace_id,professional_id,name,description,price_minor,duration_minutes,modality,min_notice_minutes)
    values(v_workspace,v_professional,v_name,nullif(trim(coalesce(p_document->>'description','')),''),v_price*100,v_duration,
      case v_mode when 'Presencial' then 'in_person' when 'Ambas' then 'both' else 'online' end,v_notice*60);
  end if;
  delete from public.availability_rules where workspace_id=v_workspace and professional_id=v_professional;
  for v_day in 0..6 loop
    if v_days->v_day='true'::jsonb then
      if v_has_break then
        insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
        values(v_workspace,v_professional,((v_day+1)%7)::smallint,v_start,v_break_start,v_buffer),
          (v_workspace,v_professional,((v_day+1)%7)::smallint,v_break_end,v_end,v_buffer);
      else
        insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
        values(v_workspace,v_professional,((v_day+1)%7)::smallint,v_start,v_end,v_buffer);
      end if;
    end if;
  end loop;
  update public.workspaces set onboarding_completed_at=now() where id=v_workspace;
  -- Recién ahora el espacio se puede usar: acá empiezan los 30 días de Bellis Pro. Una sola vez; un reintento
  -- no llega hasta acá (el onboarding ya figura completo) y la función tampoco vuelve a empezarla.
  perform private.start_workspace_trial(v_workspace);
end $$;
