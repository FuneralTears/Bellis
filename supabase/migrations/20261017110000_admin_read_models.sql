-- H2.8A: lo que el backoffice interno lee. Solo lectura; los cambios comerciales llegan en otra migración.
-- Todas las funciones empiezan con private.require_bellis_admin(): quien no es del equipo recibe 'not_found',
-- lo mismo que si no existieran. El navegador nunca consulta tablas: solo llama a estas funciones.
-- Privacidad: se usan cantidades, ids, fechas y estados. Ninguna función lee notas, respuestas de formularios,
-- títulos o descripciones de seguimientos ni nombres de pacientes. De cada cuenta se muestra el nombre del
-- consultorio, la profesión y el email de quien la creó, que es lo que el equipo necesita para contactarla.
-- Dos fechas distintas, que no se mezclan:
--   last_sign_in_at    la última vez que alguien del consultorio inició sesión. Sale de auth.users, que el
--                      navegador nunca consulta: solo llega a través de estas funciones.
--   last_activity_at   la última acción de producto (private.product_activity_events). Iniciar sesión no es una.

-- Una fila por workspace con todo lo que la lista y el detalle muestran. Sin permisos propios: solo la usan
-- las funciones de abajo, después de validar a quien llama.
create function private.admin_workspace_rows()
returns table(
  workspace_id uuid, workspace_name text, owner_email text, profession text, registered_at timestamptz,
  onboarding_completed boolean, onboarding_completed_at timestamptz, status text, plan_code text, effective_tier text,
  trial_started_at timestamptz, trial_ends_at timestamptz, pro_started_at timestamptz, pro_ends_at timestamptz,
  last_sign_in_at timestamptz, last_activity_at timestamptz, active_7d boolean, active_30d boolean, events_7d integer, events_30d integer,
  patient_count integer, appointment_count integer, public_booking_count integer, followup_count integer, automation_count integer,
  upgrade_request_open boolean, upgrade_requested_at timestamptz,
  payment_provider text, external_link_configured boolean, mercado_pago_connected boolean, booking_available boolean, booking_paused boolean)
language sql stable security definer set search_path = '' as $$
  with base as (
    select w.*, private.workspace_tier(w.id) tier,
      (select u.email::text from public.workspace_members m join auth.users u on u.id=m.user_id
        where m.workspace_id=w.id and m.role='owner' order by m.created_at limit 1) owner_email,
      (select p.specialty from public.professionals p where p.workspace_id=w.id order by p.created_at limit 1) profession,
      (select max(u.last_sign_in_at) from public.workspace_members m join auth.users u on u.id=m.user_id where m.workspace_id=w.id) last_sign_in,
      exists(select 1 from private.mercado_pago_accounts a where a.workspace_id=w.id and a.status='connected'
        and not (a.token_expires_at<now() and a.refresh_token_secret_id is null)) mp_connected,
      (w.external_payment_url is not null or exists(select 1 from public.services s
        where s.workspace_id=w.id and s.active and s.external_payment_url is not null)) link_configured,
      exists(select 1 from public.services s where s.workspace_id=w.id and s.active) has_service
    from public.workspaces w),
  activity as (
    select e.workspace_id, max(e.created_at) last_at,
      count(*) filter (where e.created_at >= now() - interval '7 days') n7,
      count(*) filter (where e.created_at >= now() - interval '30 days') n30
    from public.product_events e where e.event_name = any(private.product_activity_events()) group by e.workspace_id),
  ready as (
    -- La misma cuenta que hace la página pública: Mercado Pago necesita la capacidad y una cuenta conectada;
    -- el link externo necesita un link cargado, en el servicio o en el workspace.
    select b.id,
      b.onboarding_completed_at is not null and b.status='active' and b.has_service and (
        (b.payment_provider='mercado_pago_ar' and b.mp_connected and private.workspace_has_capability(b.id,'mercado_pago'))
        or (b.payment_provider='external_link' and b.link_configured)) available
    from base b)
  select b.id, b.name, b.owner_email, b.profession, b.created_at,
    b.onboarding_completed_at is not null, b.onboarding_completed_at, b.status, b.plan_code, b.tier,
    b.trial_started_at, b.trial_ends_at, b.pro_started_at, b.pro_ends_at,
    b.last_sign_in, a.last_at, coalesce(a.n7,0) > 0, coalesce(a.n30,0) > 0, coalesce(a.n7,0)::integer, coalesce(a.n30,0)::integer,
    (select count(*) from public.patients p where p.workspace_id=b.id)::integer,
    (select count(*) from public.appointments ap where ap.workspace_id=b.id)::integer,
    (select count(*) from public.appointments ap join public.booking_intents i on i.id=ap.booking_intent_id
      where ap.workspace_id=b.id and i.source='public')::integer,
    (select count(*) from public.patient_follow_ups f where f.workspace_id=b.id)::integer,
    (select count(*) from public.automation_rules r where r.workspace_id=b.id and r.enabled)::integer,
    exists(select 1 from public.plan_upgrade_requests q where q.workspace_id=b.id and q.status='open'),
    (select max(q.created_at) from public.plan_upgrade_requests q where q.workspace_id=b.id and q.status='open'),
    b.payment_provider, b.link_configured, b.mp_connected, r.available,
    -- En pausa: la página está publicada pero hoy nadie puede reservar.
    b.onboarding_completed_at is not null and b.status='active' and not r.available
  from base b join ready r on r.id=b.id left join activity a on a.workspace_id=b.id;
$$;
revoke all on function private.admin_workspace_rows() from public,anon,authenticated;

-- ===== Resumen =====
-- Solo números. Los tres planes se cuentan sobre los workspaces no suspendidos, hayan o no terminado el onboarding.
create function private.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_bellis_admin();
  select jsonb_build_object(
    'total_users',(select count(*) from auth.users),
    'registrations_last_7d',(select count(*) from auth.users u where u.created_at >= now() - interval '7 days'),
    'registrations_last_30d',(select count(*) from auth.users u where u.created_at >= now() - interval '30 days'),
    'total_workspaces',count(*),
    'onboarded_workspaces',count(*) filter (where r.onboarding_completed),
    'suspended_workspaces',count(*) filter (where r.status='suspended'),
    'active_7d',count(*) filter (where r.active_7d),
    'active_30d',count(*) filter (where r.active_30d),
    'pro_trial_active',count(*) filter (where r.effective_tier='pro_trial' and r.status='active'),
    'pro_active',count(*) filter (where r.effective_tier='pro' and r.status='active'),
    'free_active',count(*) filter (where r.effective_tier='free' and r.status='active'),
    'upgrade_requests_open',count(*) filter (where r.upgrade_request_open),
    'trials_expiring_7d',count(*) filter (where r.effective_tier='pro_trial' and r.trial_ends_at < now() + interval '7 days'),
    'workspaces_with_booking_paused',count(*) filter (where r.booking_paused),
    'generated_at',now())
  into v from private.admin_workspace_rows() r;
  return v;
end $$;
revoke all on function private.admin_overview() from public,anon,authenticated;
grant execute on function private.admin_overview() to authenticated;

create function public.admin_overview() returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.admin_overview(); $$;
revoke all on function public.admin_overview() from public,anon;
grant execute on function public.admin_overview() to authenticated;

-- ===== Lista =====
create function private.admin_workspaces(
  p_search text,p_onboarding text,p_tier text,p_active text,p_upgrade_requested boolean,p_booking_paused boolean,
  p_sort text,p_limit integer,p_offset integer
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_limit integer := greatest(1,least(coalesce(p_limit,25),100)); v_offset integer := greatest(0,coalesce(p_offset,0));
  v_sort text := coalesce(p_sort,'newest'); v_like text;
begin
  perform private.require_bellis_admin();
  if p_onboarding is not null and p_onboarding not in ('complete','incomplete')
    or p_tier is not null and p_tier not in ('free','pro_trial','pro')
    or p_active is not null and p_active not in ('7d','30d')
    or v_sort not in ('newest','last_activity','trial_ending','most_active')
    then raise exception 'invalid_filter'; end if;
  if nullif(btrim(coalesce(p_search,'')),'') is not null then
    v_like := '%' || replace(replace(replace(lower(btrim(left(p_search,120))),'\','\\'),'%','\%'),'_','\_') || '%';
  end if;
  with filtered as (
    select r.* from private.admin_workspace_rows() r
    where (v_like is null or lower(r.workspace_name) like v_like or lower(coalesce(r.owner_email,'')) like v_like
        or lower(coalesce(r.profession,'')) like v_like or r.workspace_id::text like v_like)
      and (p_onboarding is null or r.onboarding_completed = (p_onboarding='complete'))
      and (p_tier is null or r.effective_tier=p_tier)
      and (p_active is null or (p_active='7d' and r.active_7d) or (p_active='30d' and r.active_30d))
      and (p_upgrade_requested is not true or r.upgrade_request_open)
      and (p_booking_paused is not true or r.booking_paused)),
  ordered as (
    select f.*, row_number() over (order by
      case when v_sort='last_activity' then extract(epoch from f.last_activity_at) end desc nulls last,
      case when v_sort='trial_ending' and f.effective_tier='pro_trial' then extract(epoch from f.trial_ends_at) end asc nulls last,
      case when v_sort='most_active' then f.events_30d end desc nulls last,
      f.registered_at desc, f.workspace_id) n
    from filtered f)
  select jsonb_build_object('total',(select count(*) from filtered),'limit',v_limit,'offset',v_offset,
    'rows',coalesce((select jsonb_agg(to_jsonb(o) - 'n' order by o.n) from ordered o where o.n > v_offset and o.n <= v_offset + v_limit),'[]'::jsonb))
  into v;
  return v;
end $$;
revoke all on function private.admin_workspaces(text,text,text,text,boolean,boolean,text,integer,integer) from public,anon,authenticated;
grant execute on function private.admin_workspaces(text,text,text,text,boolean,boolean,text,integer,integer) to authenticated;

create function public.admin_workspaces(
  p_search text default null,p_onboarding text default null,p_tier text default null,p_active text default null,
  p_upgrade_requested boolean default false,p_booking_paused boolean default false,
  p_sort text default 'newest',p_limit integer default 25,p_offset integer default 0
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.admin_workspaces(p_search,p_onboarding,p_tier,p_active,p_upgrade_requested,p_booking_paused,p_sort,p_limit,p_offset);
$$;
revoke all on function public.admin_workspaces(text,text,text,text,boolean,boolean,text,integer,integer) from public,anon;
grant execute on function public.admin_workspaces(text,text,text,text,boolean,boolean,text,integer,integer) to authenticated;

-- ===== Detalle =====
-- La fila de la lista, más el plan en detalle y los últimos eventos del workspace.
create function private.admin_workspace_detail(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_row jsonb; v_tier text; v_trial_ends timestamptz; v_pro_ends timestamptz; v_days integer;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  perform private.require_bellis_admin();
  select to_jsonb(r), r.effective_tier, r.trial_ends_at, r.pro_ends_at into v_row, v_tier, v_trial_ends, v_pro_ends
  from private.admin_workspace_rows() r where r.workspace_id=p_workspace;
  if v_row is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- Días que quedan del plan vigente, contados en días de Argentina. 0 es el último día.
  v_days := case
    when v_tier='pro_trial' then ((v_trial_ends - interval '1 second') at time zone 'America/Argentina/Buenos_Aires')::date - v_today
    when v_tier='pro' and v_pro_ends is not null then ((v_pro_ends - interval '1 second') at time zone 'America/Argentina/Buenos_Aires')::date - v_today
  end;
  return v_row || jsonb_build_object(
    'days_remaining',v_days,
    'capabilities',to_jsonb(private.plan_capabilities(v_tier)),
    'timeline',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'event_name',t.event_name,'entity_type',t.entity_type,
        'metadata',t.metadata,'created_at',t.created_at) order by t.created_at desc, t.id desc)
      from (select e.* from public.product_events e where e.workspace_id=p_workspace order by e.created_at desc, e.id desc limit 50) t),'[]'::jsonb));
end $$;
revoke all on function private.admin_workspace_detail(uuid) from public,anon,authenticated;
grant execute on function private.admin_workspace_detail(uuid) to authenticated;

create function public.admin_workspace_detail(p_workspace uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.admin_workspace_detail(p_workspace); $$;
revoke all on function public.admin_workspace_detail(uuid) from public,anon;
grant execute on function public.admin_workspace_detail(uuid) to authenticated;

-- ===== Actividad reciente =====
-- Los últimos eventos de todo el producto, con el nombre del consultorio para poder ubicarlos.
create function private.admin_recent_activity(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_bellis_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'event_name',t.event_name,'workspace_id',t.workspace_id,
      'workspace_name',t.name,'metadata',t.metadata,'created_at',t.created_at) order by t.created_at desc, t.id desc)
    from (select e.id,e.event_name,e.workspace_id,e.metadata,e.created_at,w.name
      from public.product_events e left join public.workspaces w on w.id=e.workspace_id
      order by e.created_at desc, e.id desc limit greatest(1,least(coalesce(p_limit,20),100))) t),'[]'::jsonb);
end $$;
revoke all on function private.admin_recent_activity(integer) from public,anon,authenticated;
grant execute on function private.admin_recent_activity(integer) to authenticated;

create function public.admin_recent_activity(p_limit integer default 20) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.admin_recent_activity(p_limit); $$;
revoke all on function public.admin_recent_activity(integer) from public,anon;
grant execute on function public.admin_recent_activity(integer) to authenticated;
