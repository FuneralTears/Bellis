-- H3.1B: Bellis appointments -> the app-created "Turnos Bellis" Google calendar.
-- Booking only writes this private outbox. The network worker is independent, bounded and idempotent.

create extension if not exists pg_net;

create table private.google_calendar_event_sync (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  workspace_id uuid not null,
  professional_id uuid not null,
  connection_professional_id uuid references private.google_calendar_accounts(professional_id) on delete set null,
  calendar_id text check (calendar_id is null or length(calendar_id) between 1 and 1024),
  event_id text check (event_id is null or event_id ~ '^bellis[0-9a-f]{32}g[0-9]+$'),
  generation integer not null default 0 check (generation between 0 and 8),
  desired_action text not null check (desired_action in ('upsert','delete')),
  desired_revision bigint not null default 1 check (desired_revision > 0),
  desired_starts_at timestamptz not null,
  desired_ends_at timestamptz not null,
  desired_timezone text not null check (length(desired_timezone) between 1 and 64),
  state text not null default 'pending' check (state in ('pending','processing','retry','synced','deleted','blocked','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id,professional_id) references public.professionals(workspace_id,id) on delete cascade,
  check (desired_ends_at > desired_starts_at),
  check ((state='processing') = (lease_token is not null and lease_until is not null))
);
create index google_calendar_event_sync_due on private.google_calendar_event_sync(next_attempt_at,id)
  where state in ('pending','retry','processing');
create index google_calendar_event_sync_workspace on private.google_calendar_event_sync(workspace_id,professional_id);
alter table private.google_calendar_event_sync enable row level security;
revoke all on private.google_calendar_event_sync from public,anon,authenticated,service_role;

-- An appointment mutation never calls Google. It updates one durable desired state and returns with the same booking
-- transaction. Rows are initially created only for an entitled, connected profile in the 90-day future window;
-- the recovery sweep catches appointments which enter that window or become eligible after a reconnect/upgrade.
create function private.request_google_calendar_event_sync() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_timezone text; v_existing private.google_calendar_event_sync%rowtype; v_action text; v_ready boolean;
  v_semantic_change boolean; v_state text;
begin
  select w.timezone into v_timezone from public.workspaces w where w.id=new.workspace_id;
  if v_timezone is null then return new; end if;
  select * into v_existing from private.google_calendar_event_sync s where s.appointment_id=new.id for update;
  v_ready := private.google_calendar_available(new.workspace_id) and exists(
    select 1 from private.google_calendar_accounts a where a.professional_id=new.professional_id
      and a.workspace_id=new.workspace_id and a.status='connected' and a.calendar_id is not null);

  if new.status in ('scheduled','completed') then
    -- No historic mass sync. Existing links are still maintained; moving one beyond the horizon removes it until it
    -- enters the window again, while a past event is left as calendar history.
    if v_existing.id is null and not (new.ends_at>=now() and new.starts_at<=now()+interval '90 days' and v_ready) then return new; end if;
    if new.starts_at>now()+interval '90 days' then v_action:='delete'; else v_action:='upsert'; end if;
  else
    -- Appointments are actually scheduled/completed/cancelled. Any other enum value fails closed.
    if v_existing.id is null then return new; end if;
    v_action:='delete';
  end if;

  if v_existing.id is null then
    insert into private.google_calendar_event_sync(appointment_id,workspace_id,professional_id,connection_professional_id,
      calendar_id,desired_action,desired_starts_at,desired_ends_at,desired_timezone,state)
    select new.id,new.workspace_id,new.professional_id,a.professional_id,a.calendar_id,v_action,new.starts_at,new.ends_at,
      v_timezone,case when v_ready then 'pending' else 'blocked' end
    from private.google_calendar_accounts a where a.professional_id=new.professional_id and a.workspace_id=new.workspace_id;
    if found then
      insert into public.audit_events(workspace_id,action,object_type,object_id)
      values(new.workspace_id,'sync_requested','appointment',new.id);
    end if;
    return new;
  end if;

  v_semantic_change := v_existing.desired_action<>v_action or v_existing.desired_starts_at<>new.starts_at
    or v_existing.desired_ends_at<>new.ends_at or v_existing.desired_timezone<>v_timezone
    or v_existing.workspace_id<>new.workspace_id or v_existing.professional_id<>new.professional_id;
  if not v_semantic_change then return new; end if;
  v_state := case when v_ready then 'pending' else 'blocked' end;
  update private.google_calendar_event_sync set workspace_id=new.workspace_id,professional_id=new.professional_id,
    connection_professional_id=case when v_ready then new.professional_id else connection_professional_id end,
    calendar_id=case when v_ready then (select a.calendar_id from private.google_calendar_accounts a
      where a.professional_id=new.professional_id and a.workspace_id=new.workspace_id) else calendar_id end,
    desired_action=v_action,desired_revision=desired_revision+1,desired_starts_at=new.starts_at,
    desired_ends_at=new.ends_at,desired_timezone=v_timezone,
    state=case when v_existing.state='processing' then 'processing' else v_state end,
    attempt_count=case when v_existing.state='processing' then attempt_count else 0 end,next_attempt_at=now(),
    lease_token=case when v_existing.state='processing' then lease_token else null end,
    lease_until=case when v_existing.state='processing' then lease_until else null end,
    last_error_code=null,last_error_at=null,updated_at=now()
  where id=v_existing.id;
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(new.workspace_id,'sync_requested','appointment',new.id);
  return new;
end $$;
revoke all on function private.request_google_calendar_event_sync() from public,anon,authenticated,service_role;
create trigger appointment_google_calendar_sync after insert or update of status,starts_at,ends_at,workspace_id,professional_id
  on public.appointments for each row execute function private.request_google_calendar_event_sync();

-- Recovery polling: release dead leases, pause rows whose gate/connection disappeared, reactivate them without
-- deleting the Google calendar, and discover future appointments that became eligible. Limited per invocation.
create function private.prepare_google_calendar_event_sync(p_limit integer default 500) returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer:=0; v_row record;
begin
  for v_row in
    update private.google_calendar_event_sync s set state='retry',lease_token=null,lease_until=null,
      next_attempt_at=now(),last_error_code='worker_lease_expired',last_error_at=now(),updated_at=now()
    where s.state='processing' and s.lease_until<now()
    returning s.id,s.workspace_id,s.appointment_id
  loop
    insert into public.audit_events(workspace_id,action,object_type,object_id)
    values(v_row.workspace_id,'sync_retry','appointment',v_row.appointment_id);
  end loop;

  update private.google_calendar_event_sync s set state='blocked',lease_token=null,lease_until=null,updated_at=now()
  where s.state in ('pending','retry') and (not private.google_calendar_available(s.workspace_id) or not exists(
    select 1 from private.google_calendar_accounts a where a.professional_id=s.professional_id
      and a.workspace_id=s.workspace_id and a.status='connected' and a.calendar_id is not null));

  update private.google_calendar_event_sync s set state='pending',attempt_count=0,next_attempt_at=now(),
    connection_professional_id=a.professional_id,calendar_id=a.calendar_id,last_error_code=null,last_error_at=null,updated_at=now()
  from private.google_calendar_accounts a
  where s.state='blocked' and a.professional_id=s.professional_id and a.workspace_id=s.workspace_id
    and a.status='connected' and a.calendar_id is not null and private.google_calendar_available(s.workspace_id);

  for v_row in
    select ap.id,ap.workspace_id,ap.professional_id,ap.starts_at,ap.ends_at,w.timezone,a.calendar_id
    from public.appointments ap join public.workspaces w on w.id=ap.workspace_id
    join private.google_calendar_accounts a on a.professional_id=ap.professional_id and a.workspace_id=ap.workspace_id
    left join private.google_calendar_event_sync s on s.appointment_id=ap.id
    where s.id is null and ap.status in ('scheduled','completed') and ap.ends_at>=now()
      and ap.starts_at<=now()+interval '90 days' and a.status='connected' and a.calendar_id is not null
      and private.google_calendar_available(ap.workspace_id)
    order by ap.starts_at,ap.id limit least(greatest(coalesce(p_limit,500),1),500)
  loop
    insert into private.google_calendar_event_sync(appointment_id,workspace_id,professional_id,
      connection_professional_id,calendar_id,desired_action,desired_starts_at,desired_ends_at,desired_timezone)
    values(v_row.id,v_row.workspace_id,v_row.professional_id,v_row.professional_id,v_row.calendar_id,'upsert',
      v_row.starts_at,v_row.ends_at,v_row.timezone) on conflict(appointment_id) do nothing;
    if found then
      v_count:=v_count+1;
      insert into public.audit_events(workspace_id,action,object_type,object_id)
      values(v_row.workspace_id,'sync_requested','appointment',v_row.id);
    end if;
  end loop;
  return v_count;
end $$;
revoke all on function private.prepare_google_calendar_event_sync(integer) from public,anon,authenticated,service_role;

create function public.claim_google_calendar_event_sync(p_lease_token uuid,p_limit integer default 25)
returns table(id uuid,appointment_id uuid,professional_id uuid,calendar_id text,event_id text,generation integer,
  desired_action text,desired_revision bigint,starts_at timestamptz,ends_at timestamptz,time_zone text)
language plpgsql security definer set search_path='' as $$
begin
  if p_lease_token is null then raise exception 'invalid_sync_lease'; end if;
  perform private.prepare_google_calendar_event_sync(500);
  return query with due as (
    select s.id from private.google_calendar_event_sync s
    join private.google_calendar_accounts a on a.professional_id=s.professional_id and a.workspace_id=s.workspace_id
    where s.state in ('pending','retry') and s.next_attempt_at<=now() and a.status='connected'
      and a.calendar_id is not null and private.google_calendar_available(s.workspace_id)
    order by s.next_attempt_at,s.id for update of s skip locked limit least(greatest(coalesce(p_limit,25),1),50)
  ), claimed as (
    update private.google_calendar_event_sync s set state='processing',lease_token=p_lease_token,
      lease_until=now()+interval '90 seconds',attempt_count=s.attempt_count+1,last_attempt_at=now(),
      connection_professional_id=a.professional_id,calendar_id=a.calendar_id,last_error_code=null,updated_at=now()
    from due d,private.google_calendar_accounts a where s.id=d.id and a.professional_id=s.professional_id
      and a.workspace_id=s.workspace_id returning s.*
  )
  select c.id,c.appointment_id,c.professional_id,c.calendar_id,c.event_id,c.generation,c.desired_action,
    c.desired_revision,c.desired_starts_at,c.desired_ends_at,c.desired_timezone from claimed c;
end $$;
revoke all on function public.claim_google_calendar_event_sync(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_google_calendar_event_sync(uuid,integer) to service_role;

create function public.complete_google_calendar_event_sync(p_id uuid,p_lease_token uuid,p_revision bigint,
  p_outcome text,p_event_id text,p_generation integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_row private.google_calendar_event_sync%rowtype; v_action text; v_state text;
begin
  if p_outcome not in ('created','updated','deleted','reconciled') or p_generation not between 0 and 8
    or (p_event_id is not null and p_event_id !~ '^bellis[0-9a-f]{32}g[0-9]+$') then raise exception 'invalid_sync_result'; end if;
  select * into v_row from private.google_calendar_event_sync s where s.id=p_id for update;
  if not found or v_row.state<>'processing' or v_row.lease_token is distinct from p_lease_token then return false; end if;
  v_action := case p_outcome when 'created' then 'sync_created' when 'updated' then 'sync_updated'
    when 'deleted' then 'sync_deleted' else 'sync_reconciled' end;
  v_state := case when v_row.desired_revision<>p_revision then 'pending'
    when p_outcome='deleted' then 'deleted' else 'synced' end;
  update private.google_calendar_event_sync set event_id=coalesce(p_event_id,event_id),generation=p_generation,
    state=v_state,next_attempt_at=case when v_state='pending' then now() else next_attempt_at end,
    lease_token=null,lease_until=null,last_success_at=now(),last_error_code=null,last_error_at=null,updated_at=now()
  where id=p_id;
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(v_row.workspace_id,v_action,'appointment',v_row.appointment_id);
  return true;
end $$;
revoke all on function public.complete_google_calendar_event_sync(uuid,uuid,bigint,text,text,integer) from public,anon,authenticated;
grant execute on function public.complete_google_calendar_event_sync(uuid,uuid,bigint,text,text,integer) to service_role;

create function public.fail_google_calendar_event_sync(p_id uuid,p_lease_token uuid,p_revision bigint,
  p_error_code text,p_retryable boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_row private.google_calendar_event_sync%rowtype; v_code text; v_retry boolean; v_state text;
begin
  v_code:=case when p_error_code ~ '^[a-z0-9_]{1,64}$' then p_error_code else 'google_calendar_sync_failed' end;
  select * into v_row from private.google_calendar_event_sync s where s.id=p_id for update;
  if not found or v_row.state<>'processing' or v_row.lease_token is distinct from p_lease_token then return false; end if;
  if v_row.desired_revision<>p_revision then
    update private.google_calendar_event_sync set state='pending',next_attempt_at=now(),lease_token=null,lease_until=null,
      last_error_code=v_code,last_error_at=now(),updated_at=now() where id=p_id;
    v_state:='retry';
  elsif v_code='google_needs_reconnect' or not private.google_calendar_available(v_row.workspace_id)
    or not exists(select 1 from private.google_calendar_accounts a where a.professional_id=v_row.professional_id
      and a.workspace_id=v_row.workspace_id and a.status='connected') then
    update private.google_calendar_event_sync set state='blocked',lease_token=null,lease_until=null,
      last_error_code=v_code,last_error_at=now(),updated_at=now() where id=p_id;
    v_state:='failed';
  else
    v_retry:=coalesce(p_retryable,false) and v_row.attempt_count<8;
    update private.google_calendar_event_sync set state=case when v_retry then 'retry' else 'failed' end,
      next_attempt_at=case when v_retry then now()+make_interval(mins=>least(60,power(2,least(v_row.attempt_count,6))::integer)) else next_attempt_at end,
      lease_token=null,lease_until=null,last_error_code=v_code,last_error_at=now(),updated_at=now() where id=p_id;
    v_state:=case when v_retry then 'retry' else 'failed' end;
  end if;
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(v_row.workspace_id,case when v_state='retry' then 'sync_retry' else 'sync_failed' end,'appointment',v_row.appointment_id);
  return true;
end $$;
revoke all on function public.fail_google_calendar_event_sync(uuid,uuid,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.fail_google_calendar_event_sync(uuid,uuid,bigint,text,boolean) to service_role;

-- The URL and secret are environment-specific and are deliberately not in source. Staging/prod setup stores them
-- under these Vault names. Until configured this function is a no-op, so applying the migration cannot call a wrong
-- environment. pg_net starts the request only after the cron transaction commits.
create function private.invoke_google_calendar_event_sync() returns bigint
language plpgsql security definer set search_path='' as $$
declare v_url text; v_secret text; v_request bigint;
begin
  select d.decrypted_secret into v_url from vault.decrypted_secrets d where d.name='bellis_google_calendar_sync_url';
  select d.decrypted_secret into v_secret from vault.decrypted_secrets d where d.name='bellis_google_calendar_sync_secret';
  if v_url is null or v_secret is null then return null; end if;
  select net.http_post(url=>v_url,headers=>jsonb_build_object('Content-Type','application/json','X-Bellis-Sync-Secret',v_secret),
    body=>'{}'::jsonb,timeout_milliseconds=>5000) into v_request;
  return v_request;
end $$;
revoke all on function private.invoke_google_calendar_event_sync() from public,anon,authenticated,service_role;

select cron.schedule('bellis-google-calendar-events','* * * * *','select private.invoke_google_calendar_event_sync()');
