-- CRM phase 5: an in-app inbox, separate from the outbound appointment notification_outbox.
create table public.internal_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  recipient_id uuid not null,
  type text not null check (type in ('automation_follow_up_created','automation_failed','automation_skipped','automation_completed')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  message text not null check (char_length(btrim(message)) between 1 and 500),
  entity_type text not null check (entity_type in ('follow_up','automation_run')),
  entity_id uuid not null,
  automation_run_id uuid not null,
  patient_id uuid not null,
  follow_up_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(workspace_id,recipient_id) references public.workspace_members(workspace_id,user_id) on delete cascade,
  foreign key(workspace_id,automation_run_id) references public.automation_runs(workspace_id,id) on delete cascade,
  foreign key(workspace_id,patient_id) references public.patients(workspace_id,id) on delete cascade,
  foreign key(workspace_id,follow_up_id) references public.patient_follow_ups(workspace_id,id) on delete cascade,
  unique(recipient_id,automation_run_id,type),
  check ((entity_type='follow_up' and follow_up_id is not null and entity_id=follow_up_id)
    or (entity_type='automation_run' and follow_up_id is null and entity_id=automation_run_id))
);
create index internal_notifications_recent on public.internal_notifications(recipient_id,workspace_id,created_at desc);
create index internal_notifications_unread on public.internal_notifications(recipient_id,workspace_id,created_at desc) where read_at is null;
create index internal_notifications_run on public.internal_notifications(workspace_id,automation_run_id);
alter table public.internal_notifications enable row level security;
grant select on public.internal_notifications to authenticated;
grant update(read_at) on public.internal_notifications to authenticated;
grant all on public.internal_notifications to service_role;
create policy internal_notifications_read on public.internal_notifications for select to authenticated using (
  recipient_id=(select auth.uid())
  and private.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[])
);
create policy internal_notifications_mark_read on public.internal_notifications for update to authenticated using (
  recipient_id=(select auth.uid())
  and private.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[])
) with check (
  recipient_id=(select auth.uid())
  and private.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[])
);

-- Technical failures remain in the database for operators, but are not exposed by the Data API to users.
revoke select on public.automation_runs from authenticated;
grant select(id,workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,
  triggered_at,scheduled_for,executed_at,status,action_type,result,attempt_count,follow_up_id,created_at)
  on public.automation_runs to authenticated;

create function private.notify_automation_result() returns trigger language plpgsql security definer set search_path='' as $$
declare v_recipient uuid; v_rule public.automation_rules%rowtype;
  v_type text; v_title text; v_message text; v_entity_type text; v_entity_id uuid; v_follow_up uuid;
begin
  if new.status is not distinct from old.status or new.status not in ('completed','failed') then return new; end if;
  if new.status='completed' and new.follow_up_id is null then return new; end if;
  select * into v_rule from public.automation_rules where id=new.automation_rule_id and workspace_id=new.workspace_id;
  -- Prefer the professional responsible for this patient's action.
  select p.user_id into v_recipient from public.professionals p
    join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
    where p.workspace_id=new.workspace_id and p.id=new.professional_id limit 1;
  if v_recipient is null then
    select m.user_id into v_recipient from public.workspace_members m
      where m.workspace_id=new.workspace_id and m.user_id in (v_rule.updated_by,v_rule.created_by)
      order by case when m.user_id=v_rule.updated_by then 0 else 1 end limit 1;
  end if;
  if v_recipient is null then
    select m.user_id into v_recipient from public.workspace_members m
      where m.workspace_id=new.workspace_id and m.role in ('owner','admin')
      order by case when m.role='owner' then 0 else 1 end,m.created_at limit 1;
  end if;
  if v_recipient is null then return new; end if;
  if new.status='completed' then
    v_type:='automation_follow_up_created'; v_title:='Nuevo seguimiento automático';
    v_message:='Bellis creó un seguimiento para que revises la próxima acción.';
    v_entity_type:='follow_up'; v_entity_id:=new.follow_up_id; v_follow_up:=new.follow_up_id;
  else
    v_type:='automation_failed'; v_title:='Automatización fallida';
    v_message:='Una regla de seguimiento no pudo ejecutarse. Revisá la ejecución.';
    v_entity_type:='automation_run'; v_entity_id:=new.id; v_follow_up:=null;
  end if;
  insert into public.internal_notifications(workspace_id,recipient_id,type,title,message,entity_type,entity_id,
    automation_run_id,patient_id,follow_up_id)
    values(new.workspace_id,v_recipient,v_type,v_title,v_message,v_entity_type,v_entity_id,
      new.id,new.patient_id,v_follow_up)
    on conflict(recipient_id,automation_run_id,type) do nothing;
  if found then
    insert into public.audit_events(workspace_id,action,object_type,object_id)
      values(new.workspace_id,'internal_notification_created','automation_run',new.id);
  end if;
  return new;
end $$;
revoke all on function private.notify_automation_result() from public,anon,authenticated;
create trigger automation_result_notification after update of status on public.automation_runs
  for each row execute function private.notify_automation_result();

create function private.stamp_internal_notification_read() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.id<>old.id or new.workspace_id<>old.workspace_id or new.recipient_id<>old.recipient_id
    or new.type<>old.type or new.entity_type<>old.entity_type or new.entity_id<>old.entity_id
    or new.automation_run_id<>old.automation_run_id or new.patient_id<>old.patient_id
    or new.follow_up_id is distinct from old.follow_up_id then raise exception 'notification_identity_immutable'; end if;
  if old.read_at is not null and new.read_at is distinct from old.read_at then raise exception 'notification_already_read'; end if;
  if old.read_at is null and new.read_at is not null then
    new.read_at:=now();
    insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
      values(new.workspace_id,auth.uid(),'internal_notification_read','internal_notification',new.id);
  end if;
  return new;
end $$;
revoke all on function private.stamp_internal_notification_read() from public,anon,authenticated;
create trigger internal_notification_read_stamp before update on public.internal_notifications
  for each row execute function private.stamp_internal_notification_read();

-- Manual retry reuses the same run and the Phase 4 worker's re-evaluation and idempotency checks.
create function public.retry_failed_automation_run(p_run uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_run public.automation_runs%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authorized'; end if;
  select * into v_run from public.automation_runs where id=p_run for update;
  if v_run.id is null or not (
    private.has_workspace_role(v_run.workspace_id,array['owner','admin']::public.workspace_role[])
    or exists(select 1 from public.professionals p where p.id=v_run.professional_id
      and p.workspace_id=v_run.workspace_id and p.user_id=auth.uid())) then raise exception 'not_authorized'; end if;
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
revoke all on function public.retry_failed_automation_run(uuid) from public,anon;
grant execute on function public.retry_failed_automation_run(uuid) to authenticated;
