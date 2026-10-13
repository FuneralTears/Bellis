-- H2.8B: cambios de plan desde el backoffice interno. No hay cobro automático: alguien del equipo activa,
-- extiende o quita Bellis Pro a mano, y queda anotado quién lo hizo.
-- Quién puede: solo el rol 'admin' de private.bellis_admins. 'support' sigue leyendo todo y no cambia nada.
-- Como en el resto del backoffice, quien no puede recibe 'not_found'. El navegador nunca escribe en workspaces
-- ni en plan_upgrade_requests: todo pasa por estas funciones. El cambio de plan en sí lo sigue haciendo
-- private.admin_set_workspace_plan (H2.7); lo único que se agrega acá es cortar la prueba al volver a Free.
-- "Volver a Free" es Free desde ese momento, aunque el consultorio tuviera Pro o una prueba todavía vigente.
-- No borra nada: pacientes, turnos, seguimientos, reglas, la conexión de Mercado Pago y el historial quedan como están.
-- Un cambio hecho a mano no es un vencimiento: no se anota después como "venció" (ver record_plan_expirations, al final).

create function private.require_bellis_admin_role(p_role text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_bellis_admin(array[p_role]);
end $$;
revoke all on function private.require_bellis_admin_role(text) from public,anon,authenticated;

-- ===== Auditoría de cambios comerciales =====
-- Una fila por cada cosa que el equipo hace sobre el plan o sobre un pedido de Pro. Estados y fechas: ni emails ni nombres.
create table public.plan_change_audit (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_admin_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('pro_activated','pro_extended','downgraded_to_free','upgrade_request_resolved','upgrade_request_dismissed')),
  request_id uuid references public.plan_upgrade_requests(id) on delete set null,
  previous_effective_tier text not null check (previous_effective_tier in ('free','pro_trial','pro')),
  new_effective_tier text not null check (new_effective_tier in ('free','pro_trial','pro')),
  previous_plan_code text not null,
  new_plan_code text not null,
  previous_pro_ends_at timestamptz,
  new_pro_ends_at timestamptz,
  -- La prueba solo cambia cuando se vuelve a Free con una prueba vigente: ahí se corta.
  previous_trial_ends_at timestamptz,
  new_trial_ends_at timestamptz,
  created_at timestamptz not null default now()
);
create index plan_change_audit_workspace_time on public.plan_change_audit(workspace_id,created_at desc);
alter table public.plan_change_audit enable row level security;
revoke all on public.plan_change_audit from public,anon,authenticated,service_role;
grant select on public.plan_change_audit to service_role;

create function private.record_plan_change(
  p_workspace uuid,p_action text,p_request uuid,p_previous_tier text,p_previous_plan text,p_previous_ends timestamptz,p_previous_trial_ends timestamptz
) returns void language sql security definer set search_path = '' as $$
  insert into public.plan_change_audit(workspace_id,actor_admin_user_id,action,request_id,previous_effective_tier,new_effective_tier,
    previous_plan_code,new_plan_code,previous_pro_ends_at,new_pro_ends_at,previous_trial_ends_at,new_trial_ends_at)
  select w.id,(select auth.uid()),p_action,p_request,p_previous_tier,private.workspace_tier(w.id),p_previous_plan,w.plan_code,p_previous_ends,w.pro_ends_at,
    p_previous_trial_ends,w.trial_ends_at
  from public.workspaces w where w.id=p_workspace;
$$;
revoke all on function private.record_plan_change(uuid,text,uuid,text,text,timestamptz,timestamptz) from public,anon,authenticated;

-- ===== Cambio de plan =====
-- El corazón de las tres acciones. Activar o extender exige una fecha de fin futura (y no más de tres años adelante,
-- para que un error de tipeo no regale una década). Extender un Pro vigente solo puede alejar el vencimiento, y
-- conserva su fecha de inicio. Activar Pro con un pedido abierto lo deja resuelto en la misma transacción.
-- Volver a Free deja al consultorio en Free en el acto: se quita Pro y, si la prueba seguía vigente, termina en ese
-- momento. La prueba es una fecha (private.workspace_tier), así que cortarla es mover su fin a ahora; cuándo empezó
-- queda como estaba, y por eso no vuelve a otorgarse. Si por algo el resultado no fuera Free, no se confirma nada.
create function private.admin_change_workspace_plan(p_workspace uuid,p_target_plan text,p_pro_ends_at timestamptz,p_request uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_workspace public.workspaces%rowtype; v_tier text; v_result text; v_action text; v_open uuid; v_trial_cut boolean := false;
begin
  perform private.require_bellis_admin_role('admin');
  if p_target_plan is null or p_target_plan not in ('free','pro') then raise exception 'invalid_plan'; end if;
  select * into v_workspace from public.workspaces where id=p_workspace for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_tier := private.workspace_tier(p_workspace);
  if p_target_plan='pro' then
    if p_pro_ends_at is null or p_pro_ends_at <= now() then raise exception 'pro_ends_at_required'; end if;
    if p_pro_ends_at > now() + interval '3 years' then raise exception 'pro_ends_at_too_far'; end if;
    if v_tier='pro' and v_workspace.pro_ends_at is not null and p_pro_ends_at < v_workspace.pro_ends_at then raise exception 'pro_end_not_extended'; end if;
  elsif p_pro_ends_at is not null then raise exception 'invalid_plan_arguments';
  end if;
  v_result := private.admin_set_workspace_plan(p_workspace,p_target_plan,p_pro_ends_at);
  if p_target_plan='free' then
    update public.workspaces set trial_ends_at=greatest(now(),trial_started_at + interval '1 microsecond'),plan_updated_at=now()
    where id=p_workspace and trial_ends_at > now();
    v_trial_cut := found;
    if private.workspace_tier(p_workspace) <> 'free' then raise exception 'downgrade_incomplete'; end if;
  end if;
  v_action := case when p_target_plan='free' then (case when v_result='unchanged' and not v_trial_cut then null else 'downgraded_to_free' end)
    when v_result='unchanged' then null when v_result='pro_activated' then 'pro_activated' else 'pro_extended' end;
  if v_action is not null then
    perform private.record_plan_change(p_workspace,v_action,p_request,v_tier,v_workspace.plan_code,v_workspace.pro_ends_at,v_workspace.trial_ends_at);
  end if;
  -- Con Pro activo, un pedido abierto de ese consultorio ya no espera nada.
  if p_target_plan='pro' then
    update public.plan_upgrade_requests r set status='resolved',resolved_at=now()
    where r.workspace_id=p_workspace and r.status='open' and (p_request is null or r.id=p_request) returning r.id into v_open;
    if v_open is not null then
      perform private.record_plan_change(p_workspace,'upgrade_request_resolved',v_open,v_tier,v_workspace.plan_code,v_workspace.pro_ends_at,v_workspace.trial_ends_at);
    end if;
  end if;
  return (select jsonb_build_object('action',coalesce(v_action,'unchanged'),'workspace_id',w.id,'effective_tier',private.workspace_tier(w.id),'plan_code',w.plan_code,
    'pro_started_at',w.pro_started_at,'pro_ends_at',w.pro_ends_at,'request_resolved',v_open is not null) from public.workspaces w where w.id=p_workspace);
end $$;
revoke all on function private.admin_change_workspace_plan(uuid,text,timestamptz,uuid) from public,anon,authenticated;

create function private.admin_set_workspace_plan_as_admin(p_workspace uuid,p_target_plan text,p_pro_ends_at timestamptz) returns jsonb
language sql security definer set search_path = '' as $$
  select private.admin_change_workspace_plan(p_workspace,p_target_plan,p_pro_ends_at,null);
$$;
revoke all on function private.admin_set_workspace_plan_as_admin(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function private.admin_set_workspace_plan_as_admin(uuid,text,timestamptz) to authenticated;

-- Lo que llama el backoffice. Distinta de private.admin_set_workspace_plan, que sigue sin estar al alcance de la API.
create function public.admin_set_workspace_plan(p_workspace uuid,p_target_plan text,p_pro_ends_at timestamptz default null) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.admin_set_workspace_plan_as_admin(p_workspace,p_target_plan,p_pro_ends_at);
$$;
revoke all on function public.admin_set_workspace_plan(uuid,text,timestamptz) from public,anon;
grant execute on function public.admin_set_workspace_plan(uuid,text,timestamptz) to authenticated;

-- ===== Pedidos de Pro =====
-- Tres salidas para un pedido abierto: activar Pro (cambia el plan y lo resuelve, todo o nada), resolverlo sin
-- activar, o descartarlo. Un pedido que ya no está abierto no se vuelve a tocar.
create function private.admin_resolve_upgrade_request(p_request uuid,p_action text,p_pro_ends_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_request public.plan_upgrade_requests%rowtype; v_workspace public.workspaces%rowtype; v_tier text; v_plan jsonb;
begin
  perform private.require_bellis_admin_role('admin');
  if p_action is null or p_action not in ('activate','resolve','dismiss') then raise exception 'invalid_action'; end if;
  select * into v_request from public.plan_upgrade_requests where id=p_request for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_request.status<>'open' then raise exception 'request_not_open'; end if;
  if p_action='activate' then
    v_plan := private.admin_change_workspace_plan(v_request.workspace_id,'pro',p_pro_ends_at,p_request);
    -- El cambio de plan ya lo dejó resuelto; si por algo no fue así, no se confirma nada.
    if (select status from public.plan_upgrade_requests where id=p_request) <> 'resolved' then raise exception 'request_not_resolved'; end if;
  else
    if p_pro_ends_at is not null then raise exception 'invalid_plan_arguments'; end if;
    select * into v_workspace from public.workspaces where id=v_request.workspace_id;
    v_tier := private.workspace_tier(v_request.workspace_id);
    update public.plan_upgrade_requests set status=case when p_action='resolve' then 'resolved' else 'dismissed' end,resolved_at=now() where id=p_request;
    perform private.record_plan_change(v_request.workspace_id,case when p_action='resolve' then 'upgrade_request_resolved' else 'upgrade_request_dismissed' end,
      p_request,v_tier,v_workspace.plan_code,v_workspace.pro_ends_at,v_workspace.trial_ends_at);
  end if;
  return (select jsonb_build_object('request_id',r.id,'status',r.status,'resolved_at',r.resolved_at,'workspace_id',r.workspace_id,
    'effective_tier',private.workspace_tier(r.workspace_id),'plan',v_plan) from public.plan_upgrade_requests r where r.id=p_request);
end $$;
revoke all on function private.admin_resolve_upgrade_request(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function private.admin_resolve_upgrade_request(uuid,text,timestamptz) to authenticated;

create function public.admin_resolve_upgrade_request(p_request uuid,p_action text,p_pro_ends_at timestamptz default null) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.admin_resolve_upgrade_request(p_request,p_action,p_pro_ends_at);
$$;
revoke all on function public.admin_resolve_upgrade_request(uuid,text,timestamptz) from public,anon;
grant execute on function public.admin_resolve_upgrade_request(uuid,text,timestamptz) to authenticated;

-- La lista de pedidos, para admin y para soporte. Abiertos: primero el que más espera. El resto: lo último primero.
create function private.admin_upgrade_requests(p_status text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_status text := coalesce(p_status,'open'); v_limit integer := greatest(1,least(coalesce(p_limit,50),100)); v_offset integer := greatest(0,coalesce(p_offset,0));
begin
  perform private.require_bellis_admin();
  if v_status not in ('open','resolved','dismissed','all') then raise exception 'invalid_filter'; end if;
  with matching as (
    select r.id request_id,r.workspace_id,r.requested_plan,r.status,r.created_at requested_at,r.resolved_at,
      w.workspace_name,w.owner_email,w.profession,w.effective_tier,w.plan_code,w.status workspace_status,w.trial_ends_at,w.pro_ends_at,
      w.last_sign_in_at,w.last_activity_at,w.patient_count,w.appointment_count,w.public_booking_count,
      -- Cómo se cerró: activando Pro, resolviéndolo a mano o descartándolo.
      (select case when exists(select 1 from public.plan_change_audit a where a.request_id=r.id and a.action in ('pro_activated','pro_extended')) then 'pro_activated'
        else (select a.action from public.plan_change_audit a where a.request_id=r.id order by a.id desc limit 1) end) resolution
    from public.plan_upgrade_requests r join private.admin_workspace_rows() w on w.workspace_id=r.workspace_id
    where v_status='all' or r.status=v_status),
  ordered as (
    select m.*, row_number() over (order by case when m.status='open' then 0 else 1 end,
      case when m.status='open' then extract(epoch from m.requested_at) end asc, m.resolved_at desc nulls last, m.request_id) n from matching m)
  select jsonb_build_object('total',(select count(*) from matching),'limit',v_limit,'offset',v_offset,
    'open',(select count(*) from public.plan_upgrade_requests where status='open'),
    'rows',coalesce((select jsonb_agg(to_jsonb(o) - 'n' order by o.n) from ordered o where o.n > v_offset and o.n <= v_offset + v_limit),'[]'::jsonb)) into v;
  return v;
end $$;
revoke all on function private.admin_upgrade_requests(text,integer,integer) from public,anon,authenticated;
grant execute on function private.admin_upgrade_requests(text,integer,integer) to authenticated;

create function public.admin_upgrade_requests(p_status text default 'open',p_limit integer default 50,p_offset integer default 0) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.admin_upgrade_requests(p_status,p_limit,p_offset);
$$;
revoke all on function public.admin_upgrade_requests(text,integer,integer) from public,anon;
grant execute on function public.admin_upgrade_requests(text,integer,integer) to authenticated;

-- Los cambios comerciales de un consultorio, para el bloque "Plan comercial" del detalle, con quién hizo cada uno.
-- La auditoría guarda el id de la persona, no su email. Acá se la nombra para el equipo: "Vos" si es quien mira, y
-- si fue otra persona su email, leído de auth.users en el momento. Esa tabla sigue sin estar al alcance del navegador:
-- la identificación solo sale por esta función, que es del backoffice.
create function private.admin_plan_changes(p_workspace uuid,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_bellis_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'action',a.action,'previous_effective_tier',a.previous_effective_tier,'new_effective_tier',a.new_effective_tier,
      'previous_plan_code',a.previous_plan_code,'new_plan_code',a.new_plan_code,'previous_pro_ends_at',a.previous_pro_ends_at,'new_pro_ends_at',a.new_pro_ends_at,
      'previous_trial_ends_at',a.previous_trial_ends_at,'new_trial_ends_at',a.new_trial_ends_at,
      'by_me',coalesce(a.actor_admin_user_id=(select auth.uid()),false),
      'actor_label',case when a.actor_admin_user_id=(select auth.uid()) then 'Vos'
        else coalesce((select u.email::text from auth.users u where u.id=a.actor_admin_user_id),'Alguien que ya no está en el equipo') end,
      'created_at',a.created_at) order by a.id desc)
    from (select * from public.plan_change_audit c where c.workspace_id=p_workspace order by c.id desc limit greatest(1,least(coalesce(p_limit,20),100))) a),'[]'::jsonb);
end $$;
revoke all on function private.admin_plan_changes(uuid,integer) from public,anon,authenticated;
grant execute on function private.admin_plan_changes(uuid,integer) to authenticated;

create function public.admin_plan_changes(p_workspace uuid,p_limit integer default 20) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.admin_plan_changes(p_workspace,p_limit);
$$;
revoke all on function public.admin_plan_changes(uuid,integer) from public,anon;
grant execute on function public.admin_plan_changes(uuid,integer) to authenticated;

-- ===== Vencimientos: solo los que ocurren por fecha =====
-- Reemplaza la función de 20261017100000. Una prueba o un Pro que terminan porque llegó su fecha se siguen anotando
-- como antes, una sola vez. Lo que deja de anotarse es el fin que puso una persona del equipo al volver a Free: eso ya
-- está en plan_change_audit como 'downgraded_to_free', y decir después "venció" sería falso. Se reconoce porque la
-- auditoría de ese cambio movió el fin a la fecha que el consultorio tiene hoy. Un Pro o una prueba que ya habían
-- vencido solos antes de volver a Free no se movieron, y se siguen contando como vencimientos.
create or replace function private.record_plan_expirations() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0; v_step integer;
begin
  insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
  select 'trial_expired',w.id,'workspace',w.id,jsonb_build_object('ended_at',w.trial_ends_at),w.trial_ends_at
  from public.workspaces w where w.trial_ends_at <= now()
    and not exists(select 1 from public.plan_change_audit a where a.workspace_id=w.id and a.action='downgraded_to_free'
      and a.new_trial_ends_at=w.trial_ends_at and a.previous_trial_ends_at is distinct from a.new_trial_ends_at)
  on conflict do nothing;
  get diagnostics v_step = row_count; v_count := v_count + v_step;
  insert into public.product_events(event_name,workspace_id,entity_type,entity_id,metadata,created_at)
  select 'pro_expired',w.id,'workspace',w.id,jsonb_build_object('ended_at',w.pro_ends_at),w.pro_ends_at
  from public.workspaces w where w.pro_started_at is not null and w.pro_ends_at <= now()
    and not exists(select 1 from public.plan_change_audit a where a.workspace_id=w.id and a.action='downgraded_to_free'
      and a.new_pro_ends_at=w.pro_ends_at and a.previous_pro_ends_at is distinct from a.new_pro_ends_at)
  on conflict do nothing;
  get diagnostics v_step = row_count; v_count := v_count + v_step;
  return v_count;
end $$;
revoke all on function private.record_plan_expirations() from public,anon,authenticated;
