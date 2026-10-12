-- H2.7: lo que es de Bellis Pro se controla en el servidor, no solo en la pantalla.
-- Cada función de acá es la que ya existía, copiada tal cual, con la consulta de capacidad agregada. Ninguna
-- cambia de firma ni de permisos. Un workspace sin la capacidad recibe 'pro_access_required'.
--
-- Sin control, a propósito: registrar un pago de Mercado Pago (webhook y reconciliación), renovar sus tokens,
-- desconectar la cuenta, y elegir horario para una solicitud ya paga. Un pago iniciado con Pro se termina
-- aunque Pro haya vencido en el medio.

-- ===== Mercado Pago =====

-- Reserva pública. Dos cambios sobre 20260929000000:
--   * solo 'suspended' deja al workspace sin atender; una prueba vencida ya no apaga nada.
--   * con Mercado Pago como medio hace falta la capacidad. El link de pago externo es de Bellis Free.
create or replace function public.create_checkout_intent(
  p_service uuid,p_first_name text,p_last_name text,p_email text,p_phone text,
  p_answers jsonb,p_token_hash text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_intent uuid; v_workspace public.workspaces%rowtype; v_booking public.booking_intents%rowtype;
  v_service_link text;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token_hash'; end if;
  v_intent := public.create_preconsultation_intent(p_service,p_first_name,p_last_name,p_email,p_phone,p_answers);
  select * into v_booking from public.booking_intents where id=v_intent;
  select * into v_workspace from public.workspaces where id=v_booking.workspace_id;
  select external_payment_url into v_service_link from public.services where id=p_service;
  if v_workspace.status='suspended' then raise exception 'workspace_unavailable'; end if;
  if v_workspace.payment_provider='external_link' then
    if coalesce(v_service_link,v_workspace.external_payment_url) is null
      then raise exception 'payment_not_configured'; end if;
  elsif v_workspace.payment_provider='mercado_pago_ar' then
    if not private.workspace_has_capability(v_workspace.id,'mercado_pago') then raise exception 'pro_access_required'; end if;
    if v_booking.currency_code<>'ARS' or v_booking.price_minor<=0 or
      not exists(select 1 from private.mercado_pago_accounts a where a.workspace_id=v_booking.workspace_id and a.active)
      then raise exception 'payment_not_configured'; end if;
  else
    raise exception 'payment_not_configured';
  end if;
  update public.booking_intents set access_token_hash=p_token_hash where id=v_intent;
  insert into public.payments(workspace_id,booking_intent_id,provider,provider_order_id,amount_minor,currency_code,status)
  values(v_booking.workspace_id,v_intent,v_workspace.payment_provider,
    case when v_workspace.payment_provider='external_link' then v_intent::text else null end,
    v_booking.price_minor,v_booking.currency_code,'pending');
  return v_intent;
end $$;

-- Conectar una cuenta: al empezar y al guardar. Si Pro vence entre los dos pasos, no se guarda nada.
create or replace function public.start_mercado_pago_oauth(p_user uuid,p_state_hash text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_workspace uuid; v_role public.workspace_role;
begin
  if p_state_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_oauth_state'; end if;
  select m.workspace_id,m.role into v_workspace,v_role from public.workspace_members m
    where m.user_id=p_user order by m.created_at limit 1;
  if v_workspace is null or v_role<>'owner' then raise exception 'not_authorized'; end if;
  if not private.workspace_has_capability(v_workspace,'mercado_pago') then raise exception 'pro_access_required'; end if;
  -- Only the latest attempt of a workspace stays valid.
  delete from private.mercado_pago_oauth_states s
    where s.expires_at < now() - interval '1 day' or (s.workspace_id=v_workspace and s.consumed_at is null);
  insert into private.mercado_pago_oauth_states(state_hash,workspace_id,user_id,expires_at)
  values(p_state_hash,v_workspace,p_user,now()+interval '10 minutes');
  return v_workspace;
end $$;

create or replace function public.store_mercado_pago_connection(
  p_workspace uuid,p_user uuid,p_seller text,p_access_token text,p_refresh_token text,
  p_expires_at timestamptz,p_environment text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_account private.mercado_pago_accounts%rowtype; v_access uuid; v_refresh uuid;
begin
  if p_seller !~ '^[0-9]{1,24}$' or length(p_access_token) not between 10 and 2000
    or (p_refresh_token is not null and length(p_refresh_token) not between 10 and 2000)
    or p_environment not in ('test','production') or (p_expires_at is not null and p_expires_at <= now())
    then raise exception 'invalid_mercado_pago_connection'; end if;
  if not exists(select 1 from public.workspace_members m
    where m.workspace_id=p_workspace and m.user_id=p_user and m.role='owner')
    then raise exception 'not_authorized'; end if;
  if not private.workspace_has_capability(p_workspace,'mercado_pago') then raise exception 'pro_access_required'; end if;
  select * into v_account from private.mercado_pago_accounts a where a.workspace_id=p_workspace for update;
  v_access := private.put_mercado_pago_secret(v_account.access_token_secret_id,p_access_token);
  if p_refresh_token is not null then
    v_refresh := private.put_mercado_pago_secret(v_account.refresh_token_secret_id,p_refresh_token);
  else
    delete from vault.secrets s where s.id=v_account.refresh_token_secret_id;
  end if;
  insert into private.mercado_pago_accounts as a(workspace_id,seller_user_id,access_token_secret_id,
    refresh_token_secret_id,token_expires_at,environment,active,status,connected_by,connected_at)
  values(p_workspace,p_seller,v_access,v_refresh,p_expires_at,p_environment,true,'connected',p_user,now())
  on conflict(workspace_id) do update set seller_user_id=excluded.seller_user_id,
    access_token_secret_id=excluded.access_token_secret_id,refresh_token_secret_id=excluded.refresh_token_secret_id,
    token_expires_at=excluded.token_expires_at,environment=excluded.environment,active=true,status='connected',
    connected_by=excluded.connected_by,connected_at=now(),disconnected_at=null,refresh_locked_until=null,updated_at=now();
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(p_workspace,p_user,'mercado_pago_connected','workspace',p_workspace);
end $$;

-- Elegir Mercado Pago como medio de cobro. Pasar a link externo, o guardar sin cambiar el medio, sigue libre.
create or replace function private.require_mercado_pago_connection()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.payment_provider='mercado_pago_ar' and old.payment_provider is distinct from new.payment_provider
    and not private.workspace_has_capability(new.id,'mercado_pago') then raise exception 'pro_access_required'; end if;
  if new.payment_provider='mercado_pago_ar' and old.payment_provider is distinct from new.payment_provider
    and not exists(select 1 from private.mercado_pago_accounts a where a.workspace_id=new.id and a.status='connected'
      -- Same rule as the status the panel shows: past its expiry with nothing to renew it is not connected.
      and not (a.token_expires_at<now() and a.refresh_token_secret_id is null))
    then raise exception 'mercado_pago_not_connected'; end if;
  return new;
end $$;

-- ===== Automatizaciones =====
-- Reglas, ejecuciones y resultados se conservan siempre. Sin la capacidad no se encola ni se ejecuta nada nuevo.

create or replace function private.enqueue_appointment_automations() returns trigger language plpgsql security definer set search_path='' as $$
declare v_event timestamptz;
begin
  if new.status='completed' and (tg_op='INSERT' or old.status is distinct from new.status)
    and private.workspace_has_capability(new.workspace_id,'automations') then
    v_event:=coalesce(new.status_changed_at,new.starts_at);
    insert into public.automation_runs(workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
      select new.workspace_id,r.id,new.patient_id,new.professional_id,'appointment',new.id,v_event,
        v_event + make_interval(mins=>r.delay_minutes)
      from public.automation_rules r where r.workspace_id=new.workspace_id and r.enabled and r.enabled_at<=v_event
        and r.trigger_type='appointment_completed'
      on conflict(automation_rule_id,reference_id) do nothing;
  end if;
  return new;
end $$;

create or replace function private.enqueue_payment_automations() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='pending' and (tg_op='INSERT' or old.status is distinct from new.status)
    and private.workspace_has_capability(new.workspace_id,'automations') then
    insert into public.automation_runs(workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
      select new.workspace_id,r.id,i.patient_id,i.professional_id,'payment',new.id,new.created_at,
        new.created_at + make_interval(mins=>r.delay_minutes)
      from public.booking_intents i join public.automation_rules r on r.workspace_id=new.workspace_id
      where i.id=new.booking_intent_id and i.workspace_id=new.workspace_id
        and r.enabled and r.enabled_at<=new.created_at and r.trigger_type='payment_pending'
      on conflict(automation_rule_id,reference_id) do nothing;
  end if;
  return new;
end $$;

-- El repaso de cada hora solo toma eventos ocurridos desde que el workspace tiene Pro sin interrupción: lo que
-- pasó mientras estaba en Free no se dispara al volver. Sin Pro, workspace_pro_since es null y no encola nada.
create or replace function private.enqueue_automation_candidates() returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.automation_runs(workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
    select a.workspace_id,r.id,a.patient_id,a.professional_id,'appointment',a.id,
      coalesce(a.status_changed_at,a.starts_at),coalesce(a.status_changed_at,a.starts_at)+make_interval(mins=>r.delay_minutes)
    from public.appointments a join public.automation_rules r on r.workspace_id=a.workspace_id
    where a.status='completed' and r.enabled and r.trigger_type='appointment_completed'
      and coalesce(a.status_changed_at,a.starts_at)>=r.enabled_at
      and coalesce(a.status_changed_at,a.starts_at)>=private.workspace_pro_since(a.workspace_id)
    on conflict(automation_rule_id,reference_id) do nothing;
  insert into public.automation_runs(workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
    select pm.workspace_id,r.id,i.patient_id,i.professional_id,'payment',pm.id,pm.created_at,
      pm.created_at+make_interval(mins=>r.delay_minutes)
    from public.payments pm join public.booking_intents i on i.id=pm.booking_intent_id and i.workspace_id=pm.workspace_id
    join public.automation_rules r on r.workspace_id=pm.workspace_id
    where pm.status='pending' and r.enabled and r.trigger_type='payment_pending' and pm.created_at>=r.enabled_at
      and pm.created_at>=private.workspace_pro_since(pm.workspace_id)
    on conflict(automation_rule_id,reference_id) do nothing;
end $$;

-- Una ejecución programada se conserva hasta su hora. Recién ahí se decide: con Pro se ejecuta; sin Pro queda
-- 'skipped' con result.reason = 'pro_access_required'. Nada se descarta por adelantado, así una renovación a
-- tiempo no pierde lo que estaba en cola.
create or replace function private.process_due_automation_runs(p_limit integer default 100) returns integer
language plpgsql security definer set search_path='' as $$
declare v_run public.automation_runs%rowtype; v_rule public.automation_rules%rowtype;
  v_valid boolean; v_reason text; v_follow_up uuid; v_actor uuid; v_processed integer:=0;
begin
  for v_run in select * from public.automation_runs where status='scheduled' and scheduled_for<=now()
    order by scheduled_for,id for update skip locked limit least(greatest(p_limit,1),500) loop
    v_processed:=v_processed+1;
    -- Llegó su hora y el workspace no tiene Bellis Pro: no se ejecuta. Queda en el historial con una razón
    -- estable y no vuelve a encolarse (la clave regla + evento ya está usada).
    if not private.workspace_has_capability(v_run.workspace_id,'automations') then
      update public.automation_runs set status='skipped',executed_at=now(),result=jsonb_build_object('reason','pro_access_required') where id=v_run.id;
      insert into public.audit_events(workspace_id,action,object_type,object_id)
        values(v_run.workspace_id,'automation_run_skipped','automation_run',v_run.id);
      continue;
    end if;
    update public.automation_runs set status='processing',attempt_count=attempt_count+1 where id=v_run.id;
    begin
      select * into v_rule from public.automation_rules where id=v_run.automation_rule_id and workspace_id=v_run.workspace_id;
      v_valid:=false; v_reason:=null;
      if v_rule.id is null or not v_rule.enabled or v_run.triggered_at<v_rule.enabled_at then v_reason:='Regla desactivada o reactivada después del evento';
      elsif not exists(select 1 from public.patients p where p.id=v_run.patient_id and p.workspace_id=v_run.workspace_id and p.deleted_at is null) then
        v_reason:='Paciente no disponible';
      elsif v_rule.rule_key in ('first_consultation','inactive_patient') then
        select exists(select 1 from public.appointments a where a.id=v_run.reference_id and a.workspace_id=v_run.workspace_id
          and a.patient_id=v_run.patient_id and a.professional_id=v_run.professional_id and a.status='completed'
          and a.starts_at<now()) into v_valid;
        if not v_valid then v_reason:='El turno ya no está completado';
        elsif exists(select 1 from public.appointments a where a.patient_id=v_run.patient_id and a.workspace_id=v_run.workspace_id
          and a.status='scheduled' and a.starts_at>now()) then v_valid:=false; v_reason:='Ya tiene un próximo turno';
        elsif v_rule.rule_key='first_consultation' and
          (select count(*) from public.appointments a where a.patient_id=v_run.patient_id and a.workspace_id=v_run.workspace_id
            and a.status='completed' and a.starts_at<now())<>1 then
          v_valid:=false; v_reason:='Ya tuvo más de una consulta';
        elsif v_rule.rule_key='inactive_patient' and
          (not exists(select 1 from public.appointments a where a.id=v_run.reference_id and a.workspace_id=v_run.workspace_id
            and a.starts_at<=now()-make_interval(mins=>v_rule.delay_minutes))
          or exists(select 1 from public.appointments a where a.patient_id=v_run.patient_id and a.workspace_id=v_run.workspace_id
            and a.status='completed' and a.starts_at<now() and a.starts_at>(select ref.starts_at from public.appointments ref where ref.id=v_run.reference_id))) then
          v_valid:=false; v_reason:='Hubo una consulta más reciente o aún no pasó el plazo';
        end if;
      elsif v_rule.rule_key='pending_payment' then
        select exists(select 1 from public.payments pm join public.booking_intents i
          on i.id=pm.booking_intent_id and i.workspace_id=pm.workspace_id
          where pm.id=v_run.reference_id and pm.workspace_id=v_run.workspace_id and pm.status='pending'
            and i.patient_id=v_run.patient_id and i.professional_id=v_run.professional_id
            and i.status='pending_payment' and i.expires_at>now()
            and not exists(select 1 from public.payments approved where approved.booking_intent_id=i.id
              and approved.workspace_id=i.workspace_id and approved.status='approved')) into v_valid;
        if not v_valid then v_reason:='El pago ya no está pendiente'; end if;
      end if;
      if v_valid and exists(select 1 from public.patient_follow_ups f where f.workspace_id=v_run.workspace_id
        and f.patient_id=v_run.patient_id and f.status='pending' and lower(btrim(f.title))=lower(btrim(v_rule.action_title))) then
        v_valid:=false; v_reason:='Ya existe un seguimiento pendiente equivalente';
      end if;
      if not v_valid then
        update public.automation_runs set status='skipped',executed_at=now(),result=jsonb_build_object('reason',coalesce(v_reason,'Condición no vigente')) where id=v_run.id;
        insert into public.audit_events(workspace_id,action,object_type,object_id)
          values(v_run.workspace_id,'automation_run_skipped','automation_run',v_run.id);
      else
        select m.user_id into v_actor from public.workspace_members m where m.workspace_id=v_run.workspace_id
          and m.role in ('owner','admin') order by case when m.role='owner' then 0 else 1 end,m.created_at limit 1;
        if v_actor is null then raise exception 'Workspace sin responsable para crear seguimiento'; end if;
        insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,description,due_date,priority,created_by,source,automation_run_id)
          values(v_run.workspace_id,v_run.patient_id,v_run.professional_id,v_rule.action_title,
            'Generado automáticamente por Bellis. Motivo: '||v_rule.name,
            (now() at time zone (select timezone from public.workspaces where id=v_run.workspace_id))::date,
            v_rule.action_priority,v_actor,'automation',v_run.id) returning id into v_follow_up;
        insert into public.patient_activities(workspace_id,patient_id,professional_id,type,title,description,metadata,created_by)
          values(v_run.workspace_id,v_run.patient_id,v_run.professional_id,'automation_created_follow_up',
            'Seguimiento automático creado',v_rule.action_title||' · Motivo: '||v_rule.name,
            jsonb_build_object('follow_up_id',v_follow_up,'automation_run_id',v_run.id),v_actor);
        update public.automation_runs set status='completed',executed_at=now(),follow_up_id=v_follow_up,
          result=jsonb_build_object('follow_up_id',v_follow_up,'reason',v_rule.name) where id=v_run.id;
        insert into public.audit_events(workspace_id,action,object_type,object_id)
          values(v_run.workspace_id,'automation_run_completed','automation_run',v_run.id);
      end if;
    exception when others then
      update public.automation_runs set status=case when attempt_count>=2 then 'failed' else 'scheduled' end,
        scheduled_for=case when attempt_count>=2 then scheduled_for else now()+interval '15 minutes' end,
        error_message=left(sqlerrm,500),executed_at=case when attempt_count>=2 then now() else null end
        where id=v_run.id;
      insert into public.audit_events(workspace_id,action,object_type,object_id)
        values(v_run.workspace_id,case when v_run.attempt_count+1>=2 then 'automation_run_failed' else 'automation_run_retry' end,'automation_run',v_run.id);
    end;
  end loop;
  return v_processed;
end $$;

-- Reintentar a mano también es ejecutar: sin Pro no se puede.
create or replace function public.retry_failed_automation_run(p_run uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_run public.automation_runs%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authorized'; end if;
  select * into v_run from public.automation_runs where id=p_run for update;
  if v_run.id is null or not (
    private.has_workspace_role(v_run.workspace_id,array['owner','admin']::public.workspace_role[])
    or exists(select 1 from public.professionals p where p.id=v_run.professional_id
      and p.workspace_id=v_run.workspace_id and p.user_id=auth.uid())) then raise exception 'not_authorized'; end if;
  if not private.workspace_has_capability(v_run.workspace_id,'automations') then raise exception 'pro_access_required'; end if;
  if v_run.status<>'failed' or v_run.follow_up_id is not null
    or exists(select 1 from public.patient_follow_ups f where f.workspace_id=v_run.workspace_id
      and f.automation_run_id=v_run.id)
    or not exists(select 1 from public.automation_rules r where r.id=v_run.automation_rule_id
      and r.workspace_id=v_run.workspace_id and r.enabled) then raise exception 'retry_unavailable'; end if;
  update public.automation_runs set status='scheduled',attempt_count=0,scheduled_for=now(),executed_at=null,
    error_message=null,result='{}'::jsonb where id=v_run.id;
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
    values(v_run.workspace_id,auth.uid(),'automation_run_manual_retry','automation_run',v_run.id);
  return true;
end $$;
