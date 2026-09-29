-- Bellis CRM phase 2. Turnos, pagos y notas siguen siendo la fuente de verdad.
create table public.patient_activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  patient_id uuid not null,
  professional_id uuid not null,
  type text not null check (type in ('call','email','whatsapp','other')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null check (char_length(btrim(description)) between 1 and 3000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 2048),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (workspace_id,patient_id) references public.patients(workspace_id,id) on delete cascade,
  foreign key (workspace_id,professional_id) references public.professionals(workspace_id,id)
);
create index patient_activities_patient_time on public.patient_activities(workspace_id,patient_id,created_at desc);
alter table public.patient_activities enable row level security;
grant select,insert on public.patient_activities to authenticated;
grant all on public.patient_activities to service_role;
create policy patient_activities_read on public.patient_activities for select to authenticated using (
  exists(select 1 from public.patients p where p.workspace_id=patient_activities.workspace_id
    and p.id=patient_activities.patient_id and p.deleted_at is null)
);
create policy patient_activities_insert on public.patient_activities for insert to authenticated with check (
  created_by=(select auth.uid()) and metadata='{}'::jsonb
  and exists(select 1 from public.patients p where p.workspace_id=patient_activities.workspace_id
    and p.id=patient_activities.patient_id and p.deleted_at is null)
  and (exists(select 1 from public.professionals pr where pr.workspace_id=patient_activities.workspace_id
    and pr.id=patient_activities.professional_id and pr.user_id=(select auth.uid()))
    or private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]))
);

create table public.patient_follow_ups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  patient_id uuid not null,
  professional_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 3000),
  due_date date not null,
  due_time time without time zone,
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  status text not null default 'pending' check (status in ('pending','completed','cancelled')),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id,patient_id) references public.patients(workspace_id,id) on delete cascade,
  foreign key (workspace_id,professional_id) references public.professionals(workspace_id,id),
  check ((status='completed') = (completed_at is not null)),
  check ((status='cancelled') = (cancelled_at is not null))
);
create index patient_follow_ups_patient_date on public.patient_follow_ups(workspace_id,patient_id,due_date) where status='pending';
create index patient_follow_ups_workspace_status_date on public.patient_follow_ups(workspace_id,status,due_date,due_time);
alter table public.patient_follow_ups enable row level security;
grant select,insert on public.patient_follow_ups to authenticated;
grant update(title,description,due_date,due_time,priority,status) on public.patient_follow_ups to authenticated;
grant all on public.patient_follow_ups to service_role;
create policy patient_follow_ups_read on public.patient_follow_ups for select to authenticated using (
  exists(select 1 from public.patients p where p.workspace_id=patient_follow_ups.workspace_id
    and p.id=patient_follow_ups.patient_id and p.deleted_at is null)
);
create policy patient_follow_ups_insert on public.patient_follow_ups for insert to authenticated with check (
  created_by=(select auth.uid()) and status='pending' and completed_at is null and cancelled_at is null
  and exists(select 1 from public.patients p where p.workspace_id=patient_follow_ups.workspace_id
    and p.id=patient_follow_ups.patient_id and p.deleted_at is null)
  and (exists(select 1 from public.professionals pr where pr.workspace_id=patient_follow_ups.workspace_id
    and pr.id=patient_follow_ups.professional_id and pr.user_id=(select auth.uid()))
    or private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]))
);
create policy patient_follow_ups_update on public.patient_follow_ups for update to authenticated using (
  status='pending' and exists(select 1 from public.patients p where p.workspace_id=patient_follow_ups.workspace_id
    and p.id=patient_follow_ups.patient_id and p.deleted_at is null)
  and (created_by=(select auth.uid()) or private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]))
) with check (
  exists(select 1 from public.patients p where p.workspace_id=patient_follow_ups.workspace_id
    and p.id=patient_follow_ups.patient_id and p.deleted_at is null)
  and (created_by=(select auth.uid()) or private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]))
);
create function private.stamp_patient_follow_up() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.status <> 'pending' then raise exception 'new follow-up must be pending'; end if;
    new.completed_at:=null; new.cancelled_at:=null;
  else
    if old.status <> 'pending' then raise exception 'closed follow-up cannot be changed'; end if;
    if new.status='completed' then new.completed_at:=now(); new.cancelled_at:=null;
    elsif new.status='cancelled' then new.cancelled_at:=now(); new.completed_at:=null;
    else new.completed_at:=null; new.cancelled_at:=null; end if;
    new.updated_at:=now();
  end if;
  return new;
end $$;
revoke all on function private.stamp_patient_follow_up() from public,anon,authenticated;
create trigger patient_follow_up_stamp before insert or update on public.patient_follow_ups
  for each row execute function private.stamp_patient_follow_up();

-- Future appointment transitions get an exact timestamp. Older rows have no historical transition time.
alter table public.appointments add column status_changed_at timestamptz;
create function private.stamp_appointment_status() returns trigger language plpgsql set search_path='' as $$
begin
  if new.status is distinct from old.status then new.status_changed_at:=now(); end if;
  return new;
end $$;
revoke all on function private.stamp_appointment_status() from public,anon,authenticated;
create trigger appointment_status_stamp before update on public.appointments
  for each row execute function private.stamp_appointment_status();

-- Append a derived pending-follow-up date without replacing stored patient data.
create or replace view public.patient_crm_overview with (security_invoker=true) as
select p.id,p.workspace_id,p.first_name,p.last_name,p.email,p.phone,p.date_of_birth,
  p.status,p.created_at,
  concat_ws(' ',p.first_name,p.last_name) as full_name,
  a.last_turn,a.next_turn,coalesce(a.turn_count,0)::integer as turn_count,
  coalesce(pay.approved_total_minor,0)::bigint as approved_total_minor,
  w.currency_code,
  follow_up.due_date as follow_up_due_date
from public.patients p
join public.workspaces w on w.id=p.workspace_id
left join lateral (
  select max(starts_at) filter (where starts_at < now() and status <> 'cancelled') as last_turn,
    min(starts_at) filter (where starts_at >= now() and status='scheduled') as next_turn,
    count(*) as turn_count
  from public.appointments a where a.patient_id=p.id and a.workspace_id=p.workspace_id
) a on true
left join lateral (
  select sum(pm.amount_minor) as approved_total_minor
  from public.booking_intents i join public.payments pm
    on pm.booking_intent_id=i.id and pm.workspace_id=i.workspace_id
  where i.patient_id=p.id and i.workspace_id=p.workspace_id and pm.status='approved'
    and pm.currency_code=w.currency_code
) pay on true
left join lateral (
  select min(f.due_date) as due_date from public.patient_follow_ups f
  where f.patient_id=p.id and f.workspace_id=p.workspace_id and f.status='pending'
) follow_up on true
where p.deleted_at is null;
revoke all on public.patient_crm_overview from public,anon;
grant select on public.patient_crm_overview to authenticated;
