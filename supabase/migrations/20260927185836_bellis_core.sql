-- Bellis core schema for Supabase/PostgreSQL. Apply in a dedicated Supabase project.
create extension if not exists btree_gist;

create type public.workspace_role as enum ('owner','admin','professional','reception');
create type public.booking_status as enum ('pending_payment','payment_confirmed','awaiting_schedule','scheduled','completed','cancelled','refunded');
create type public.payment_status as enum ('pending','approved','rejected','refunded','cancelled','expired');
create type public.question_kind as enum ('short_text','long_text','single_choice','multi_choice','yes_no','scale','date','number');

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  country_code char(2) not null default 'AR',
  timezone text not null default 'America/Argentina/Buenos_Aires',
  currency_code char(3) not null default 'ARS',
  locale text not null default 'es-AR',
  payment_provider text not null default 'mercado_pago_ar',
  status text not null default 'trial' check (status in ('trial','active','suspended')),
  plan_code text not null default 'trial',
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now()
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);
create table public.professionals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  specialty text not null,
  biography text,
  photo_path text,
  location_text text,
  province text,
  city text,
  address text,
  practice_name text,
  offers_online boolean not null default true,
  offers_in_person boolean not null default false,
  public_slug text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id,public_slug)
);
create table public.services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  professional_id uuid not null references public.professionals(id) on delete cascade,
  name text not null,
  description text,
  price_minor integer not null check (price_minor >= 0),
  currency_code char(3) not null default 'ARS',
  duration_minutes integer not null check (duration_minutes between 15 and 480),
  modality text not null check (modality in ('online','in_person','both')),
  min_notice_minutes integer not null default 1440 check (min_notice_minutes >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  professional_id uuid references public.professionals(id) on delete cascade,
  service_id uuid references public.services(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint form_scope check (professional_id is not null or service_id is not null)
);
create table public.form_questions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.forms(id) on delete cascade,
  position integer not null,
  prompt text not null,
  kind public.question_kind not null,
  required boolean not null default false,
  options jsonb not null default '[]'::jsonb,
  unique (form_id,position)
);
create table public.patients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  dni text,
  date_of_birth date,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id,email)
);
create table public.booking_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  professional_id uuid not null references public.professionals(id),
  service_id uuid not null references public.services(id),
  patient_id uuid not null references public.patients(id),
  status public.booking_status not null default 'pending_payment',
  price_minor integer not null check (price_minor >= 0),
  currency_code char(3) not null default 'ARS',
  duration_minutes integer not null check (duration_minutes > 0),
  expires_at timestamptz not null default (now() + interval '48 hours'),
  created_at timestamptz not null default now()
);
create table public.form_answers (
  id uuid primary key default gen_random_uuid(),
  booking_intent_id uuid not null references public.booking_intents(id) on delete cascade,
  question_id uuid not null references public.form_questions(id),
  answer jsonb not null,
  created_at timestamptz not null default now(),
  unique (booking_intent_id,question_id)
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  booking_intent_id uuid not null references public.booking_intents(id),
  provider text not null,
  provider_order_id text,
  provider_event_id text,
  amount_minor integer not null check (amount_minor >= 0),
  currency_code char(3) not null default 'ARS',
  status public.payment_status not null default 'pending',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider,provider_order_id),
  unique (provider,provider_event_id)
);
create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  professional_id uuid not null references public.professionals(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  starts_at time not null,
  ends_at time not null,
  buffer_minutes integer not null default 0 check (buffer_minutes >= 0),
  check (ends_at > starts_at)
);
create table public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  professional_id uuid not null references public.professionals(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  check (ends_at > starts_at)
);
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  booking_intent_id uuid not null unique references public.booking_intents(id),
  professional_id uuid not null references public.professionals(id),
  patient_id uuid not null references public.patients(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.booking_status not null default 'scheduled',
  notes text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
alter table public.appointments add constraint appointments_no_overlap exclude using gist
  (professional_id with =, tstzrange(starts_at,ends_at,'[)') with &&)
  where (status in ('scheduled','completed'));
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp','sms')),
  template_key text not null,
  deliver_after timestamptz not null,
  delivered_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  unique (appointment_id,channel,template_key)
);
create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  object_type text not null,
  object_id uuid,
  occurred_at timestamptz not null default now()
);

create index on public.workspace_members(user_id);
create index on public.professionals(workspace_id);
create index on public.services(workspace_id,active);
create index on public.patients(workspace_id,email);
create index on public.booking_intents(workspace_id,status);
create index on public.appointments(workspace_id,starts_at);
create index on public.notification_outbox(deliver_after) where delivered_at is null;

create function public.has_workspace_role(target_workspace uuid, allowed public.workspace_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspace_members m where m.workspace_id=target_workspace and m.user_id=(select auth.uid()) and m.role=any(allowed));
$$;
revoke all on function public.has_workspace_role(uuid,public.workspace_role[]) from public;
grant execute on function public.has_workspace_role(uuid,public.workspace_role[]) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.professionals enable row level security;
alter table public.services enable row level security;
alter table public.forms enable row level security;
alter table public.form_questions enable row level security;
alter table public.patients enable row level security;
alter table public.booking_intents enable row level security;
alter table public.form_answers enable row level security;
alter table public.payments enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.appointments enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.audit_events enable row level security;

-- Data API defaults vary by project. The later explicit_api_grants migration
-- removes any broad defaults and retains only these permitted operations.
grant select on public.workspaces, public.workspace_members, public.professionals,
  public.services, public.forms, public.form_questions, public.patients,
  public.booking_intents, public.payments, public.availability_rules,
  public.availability_blocks, public.appointments to authenticated;
grant insert, update, delete on public.professionals, public.services, public.forms,
  public.availability_rules, public.availability_blocks to authenticated;
grant all on public.workspaces, public.workspace_members, public.professionals,
  public.services, public.forms, public.form_questions, public.patients,
  public.booking_intents, public.form_answers, public.payments,
  public.availability_rules, public.availability_blocks, public.appointments,
  public.notification_outbox, public.audit_events to service_role;

create policy workspace_read on public.workspaces for select to authenticated using (public.has_workspace_role(id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy member_read on public.workspace_members for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]) or user_id=(select auth.uid()));
create policy professional_read on public.professionals for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy professional_write on public.professionals for all to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
create policy service_read on public.services for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy service_write on public.services for all to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
create policy form_read on public.forms for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy form_write on public.forms for all to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
create policy patient_read on public.patients for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]) or exists(select 1 from public.appointments a join public.professionals p on p.id=a.professional_id where a.patient_id=patients.id and p.user_id=(select auth.uid())));
create policy intent_read on public.booking_intents for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]) or exists(select 1 from public.professionals p where p.id=booking_intents.professional_id and p.user_id=(select auth.uid())));
create policy payment_read on public.payments for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
create policy availability_read on public.availability_rules for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy availability_write on public.availability_rules for all to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
create policy block_read on public.availability_blocks for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy block_write on public.availability_blocks for all to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[])) with check (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy appointment_read on public.appointments for select to authenticated using (public.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]) or exists(select 1 from public.professionals p where p.id=appointments.professional_id and p.user_id=(select auth.uid())));

-- No anonymous direct policies. Public profile, questionnaire and checkout must go through
-- rate-limited Edge Functions with explicit field allowlists. Writes to patients, intents,
-- answers, payments, appointments and the notification outbox are service-side only.
-- Super Admin uses a separate server-side allowlist; never infer that role from client data.

create function public.schedule_paid_intent(p_intent uuid,p_starts_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_id uuid; v_end timestamptz;
begin
  -- Revoke direct access below; invoke only from a trusted Edge Function after verifying
  -- a signed, short-lived scheduling token bound to this specific paid intent.
  select * into v_intent from public.booking_intents where id=p_intent for update;
  if not found or v_intent.status not in ('payment_confirmed','awaiting_schedule') then
    raise exception 'payment_not_confirmed';
  end if;
  if not exists(select 1 from public.payments where booking_intent_id=p_intent and status='approved' and amount_minor=v_intent.price_minor and currency_code=v_intent.currency_code) then
    raise exception 'payment_not_confirmed';
  end if;
  if p_starts_at < now() or v_intent.expires_at < now() then raise exception 'intent_expired'; end if;
  v_end := p_starts_at + make_interval(mins => v_intent.duration_minutes);
  if exists(select 1 from public.availability_blocks where professional_id=v_intent.professional_id and tstzrange(starts_at,ends_at,'[)') && tstzrange(p_starts_at,v_end,'[)')) then raise exception 'slot_unavailable'; end if;
  -- The exclusion constraint is the final race-safe guard against double booking.
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  values(v_intent.workspace_id,v_intent.id,v_intent.professional_id,v_intent.patient_id,p_starts_at,v_end)
  returning id into v_id;
  update public.booking_intents set status='scheduled' where id=p_intent;
  return v_id;
end $$;
revoke all on function public.schedule_paid_intent(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.schedule_paid_intent(uuid,timestamptz) to service_role;
