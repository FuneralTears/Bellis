-- CRM phase 4. Internal actions only. Timestamps are UTC; due dates use each workspace timezone.
create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  rule_key text not null check (rule_key in ('first_consultation','inactive_patient','pending_payment')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  trigger_type text not null check (trigger_type in ('appointment_completed','payment_pending')),
  condition_type text not null check (condition_type in ('first_completed_without_next','inactive_without_next','payment_still_pending')),
  action_type text not null default 'create_follow_up' check (action_type='create_follow_up'),
  action_title text not null check (char_length(btrim(action_title)) between 1 and 160),
  action_priority text not null check (action_priority in ('low','medium','high')),
  delay_minutes integer not null check (delay_minutes between 60 and 525600),
  enabled boolean not null default false,
  enabled_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,rule_key), unique(workspace_id,id),
  check ((rule_key='pending_payment' and trigger_type='payment_pending' and condition_type='payment_still_pending')
    or (rule_key='first_consultation' and trigger_type='appointment_completed' and condition_type='first_completed_without_next')
    or (rule_key='inactive_patient' and trigger_type='appointment_completed' and condition_type='inactive_without_next'))
);

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  automation_rule_id uuid not null,
  patient_id uuid not null,
  professional_id uuid not null,
  reference_type text not null check (reference_type in ('appointment','payment')),
  reference_id uuid not null,
  triggered_at timestamptz not null,
  scheduled_for timestamptz not null,
  executed_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled','processing','completed','failed','cancelled','skipped')),
  action_type text not null default 'create_follow_up' check (action_type='create_follow_up'),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result)='object' and pg_column_size(result) <= 2048),
  error_message text,
  attempt_count smallint not null default 0 check (attempt_count between 0 and 2),
  follow_up_id uuid,
  created_at timestamptz not null default now(),
  unique(automation_rule_id,reference_id), unique(workspace_id,id),
  foreign key(workspace_id,automation_rule_id) references public.automation_rules(workspace_id,id) on delete cascade,
  foreign key(workspace_id,patient_id) references public.patients(workspace_id,id) on delete cascade,
  foreign key(workspace_id,professional_id) references public.professionals(workspace_id,id)
);
create index automation_runs_due on public.automation_runs(scheduled_for,id) where status='scheduled';
create index automation_runs_workspace_history on public.automation_runs(workspace_id,automation_rule_id,created_at desc);
create index automation_runs_patient on public.automation_runs(workspace_id,patient_id,created_at desc);
create index appointments_automation_completed on public.appointments(workspace_id,patient_id,starts_at desc) where status='completed';
create index payments_automation_pending on public.payments(workspace_id,created_at,id) where status='pending';

alter table public.patient_follow_ups add column source text not null default 'manual' check (source in ('manual','automation'));
alter table public.patient_follow_ups add column automation_run_id uuid unique;
alter table public.patient_follow_ups add constraint patient_follow_ups_workspace_id_id_unique unique(workspace_id,id);
alter table public.patient_follow_ups add constraint patient_follow_ups_source_run_check
  check ((source='manual' and automation_run_id is null) or (source='automation' and automation_run_id is not null));
alter table public.patient_follow_ups add constraint patient_follow_ups_automation_run_fk
  foreign key(workspace_id,automation_run_id) references public.automation_runs(workspace_id,id);
alter table public.automation_runs add constraint automation_runs_follow_up_fk
  foreign key(workspace_id,follow_up_id) references public.patient_follow_ups(workspace_id,id);
alter table public.patient_activities drop constraint patient_activities_type_check;
alter table public.patient_activities add constraint patient_activities_type_check
  check (type in ('note','follow_up_created','follow_up_completed','message_sent','call','email','whatsapp','other','automation_created_follow_up'));

drop policy patient_follow_ups_insert on public.patient_follow_ups;
create policy patient_follow_ups_insert on public.patient_follow_ups for insert to authenticated with check (
  source='manual' and automation_run_id is null and created_by=(select auth.uid())
  and status='pending' and completed_at is null and cancelled_at is null
  and exists(select 1 from public.patients p where p.workspace_id=patient_follow_ups.workspace_id
    and p.id=patient_follow_ups.patient_id and p.deleted_at is null)
  and (exists(select 1 from public.professionals pr where pr.workspace_id=patient_follow_ups.workspace_id
    and pr.id=patient_follow_ups.professional_id and pr.user_id=(select auth.uid()))
    or private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]))
);

alter table public.automation_rules enable row level security;
alter table public.automation_runs enable row level security;
grant select on public.automation_rules, public.automation_runs to authenticated;
grant update(name,description,action_title,action_priority,delay_minutes,enabled) on public.automation_rules to authenticated;
grant all on public.automation_rules,public.automation_runs to service_role;
create policy automation_rules_read on public.automation_rules for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy automation_rules_update on public.automation_rules for update to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])) with check (
  private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
create policy automation_runs_read on public.automation_runs for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.professionals p where p.id=professional_id and p.workspace_id=workspace_id and p.user_id=(select auth.uid())));

create function private.seed_automation_rules(p_workspace uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.automation_rules(workspace_id,rule_key,name,description,trigger_type,condition_type,action_title,action_priority,delay_minutes)
  values
    (p_workspace,'first_consultation','Primera consulta sin próximo turno','Primera consulta completada y sin un turno futuro.','appointment_completed','first_completed_without_next','Contactar para consultar próxima sesión','medium',10080),
    (p_workspace,'inactive_patient','Paciente inactivo','Último turno completado y sin turno futuro.','appointment_completed','inactive_without_next','Revisar seguimiento de paciente inactivo','medium',86400),
    (p_workspace,'pending_payment','Pago pendiente','Pago aún pendiente después de la espera configurada.','payment_pending','payment_still_pending','Revisar pago pendiente','high',1440)
  on conflict(workspace_id,rule_key) do nothing;
end $$;
revoke all on function private.seed_automation_rules(uuid) from public,anon,authenticated;
create function private.seed_automation_rules_trigger() returns trigger language plpgsql security definer set search_path='' as $$
begin perform private.seed_automation_rules(new.id); return new; end $$;
revoke all on function private.seed_automation_rules_trigger() from public,anon,authenticated;
create trigger seed_automation_rules after insert on public.workspaces for each row execute function private.seed_automation_rules_trigger();
do $$ declare v_id uuid; begin for v_id in select id from public.workspaces loop perform private.seed_automation_rules(v_id); end loop; end $$;

create function private.audit_automation_rule() returns trigger language plpgsql security definer set search_path='' as $$
declare v_action text;
begin
  if tg_op='UPDATE' then
    if new.workspace_id<>old.workspace_id or new.rule_key<>old.rule_key or new.trigger_type<>old.trigger_type
      or new.condition_type<>old.condition_type or new.action_type<>old.action_type then
      raise exception 'automation_identity_immutable'; end if;
    new.updated_at:=now(); new.updated_by:=auth.uid();
    if new.enabled is distinct from old.enabled then
      new.enabled_at:=case when new.enabled then now() else null end;
      v_action:=case when new.enabled then 'automation_rule_enabled' else 'automation_rule_disabled' end;
    else v_action:='automation_rule_updated'; end if;
  else v_action:='automation_rule_created'; end if;
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
    values(new.workspace_id,auth.uid(),v_action,'automation_rule',new.id);
  return new;
end $$;
revoke all on function private.audit_automation_rule() from public,anon,authenticated;
create trigger automation_rule_audit before insert or update on public.automation_rules
  for each row execute function private.audit_automation_rule();

-- Event triggers enqueue only; failures in the asynchronous worker cannot break booking or payments.
create function private.enqueue_appointment_automations() returns trigger language plpgsql security definer set search_path='' as $$
declare v_event timestamptz;
begin
  if new.status='completed' and (tg_op='INSERT' or old.status is distinct from new.status) then
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
revoke all on function private.enqueue_appointment_automations() from public,anon,authenticated;
create trigger appointment_automation_enqueue after insert or update of status on public.appointments
  for each row execute function private.enqueue_appointment_automations();

create function private.enqueue_payment_automations() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='pending' and (tg_op='INSERT' or old.status is distinct from new.status) then
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
revoke all on function private.enqueue_payment_automations() from public,anon,authenticated;
create trigger payment_automation_enqueue after insert or update of status on public.payments
  for each row execute function private.enqueue_payment_automations();

-- Set-based recovery sweep catches missed events without querying once per patient.
create function private.enqueue_automation_candidates() returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.automation_runs(workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
    select a.workspace_id,r.id,a.patient_id,a.professional_id,'appointment',a.id,
      coalesce(a.status_changed_at,a.starts_at),coalesce(a.status_changed_at,a.starts_at)+make_interval(mins=>r.delay_minutes)
    from public.appointments a join public.automation_rules r on r.workspace_id=a.workspace_id
    where a.status='completed' and r.enabled and r.trigger_type='appointment_completed'
      and coalesce(a.status_changed_at,a.starts_at)>=r.enabled_at
    on conflict(automation_rule_id,reference_id) do nothing;
  insert into public.automation_runs(workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
    select pm.workspace_id,r.id,i.patient_id,i.professional_id,'payment',pm.id,pm.created_at,
      pm.created_at+make_interval(mins=>r.delay_minutes)
    from public.payments pm join public.booking_intents i on i.id=pm.booking_intent_id and i.workspace_id=pm.workspace_id
    join public.automation_rules r on r.workspace_id=pm.workspace_id
    where pm.status='pending' and r.enabled and r.trigger_type='payment_pending' and pm.created_at>=r.enabled_at
    on conflict(automation_rule_id,reference_id) do nothing;
end $$;
revoke all on function private.enqueue_automation_candidates() from public,anon,authenticated;

create function private.process_due_automation_runs(p_limit integer default 100) returns integer
language plpgsql security definer set search_path='' as $$
declare v_run public.automation_runs%rowtype; v_rule public.automation_rules%rowtype;
  v_valid boolean; v_reason text; v_follow_up uuid; v_actor uuid; v_processed integer:=0;
begin
  for v_run in select * from public.automation_runs where status='scheduled' and scheduled_for<=now()
    order by scheduled_for,id for update skip locked limit least(greatest(p_limit,1),500) loop
    v_processed:=v_processed+1;
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
revoke all on function private.process_due_automation_runs(integer) from public,anon,authenticated;
create function private.run_automation_cycle() returns integer language plpgsql security definer set search_path='' as $$
begin perform private.enqueue_automation_candidates(); return private.process_due_automation_runs(100); end $$;
revoke all on function private.run_automation_cycle() from public,anon,authenticated;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('bellis-crm-automations-hourly','5 * * * *','select private.run_automation_cycle()');
