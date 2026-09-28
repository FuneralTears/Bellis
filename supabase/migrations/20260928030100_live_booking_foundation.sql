-- Live booking foundation. Every public write is performed by a trusted Edge Function.
alter table public.workspaces
  add column trial_started_at timestamptz not null default now(),
  add column external_payment_url text;
alter table public.booking_intents
  add column access_token_hash text unique;
alter table public.payments add column manual_reference text;
create unique index professionals_public_slug_global on public.professionals(public_slug);
create index booking_intents_token_lookup on public.booking_intents(access_token_hash) where access_token_hash is not null;

grant update(name,timezone,payment_provider,external_payment_url) on public.workspaces to authenticated;
create policy workspace_owner_update on public.workspaces for update to authenticated
  using (private.has_workspace_role(id,array['owner']::public.workspace_role[]))
  with check (private.has_workspace_role(id,array['owner']::public.workspace_role[]));

create function private.validate_payment_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.payment_provider not in ('external_link','mercado_pago_ar') then raise exception 'invalid_payment_provider'; end if;
  if new.external_payment_url is not null and
    (length(new.external_payment_url) > 1000 or new.external_payment_url !~ '^https://[^[:space:]]+$')
    then raise exception 'invalid_payment_link'; end if;
  return new;
end $$;
revoke all on function private.validate_payment_settings() from public,anon,authenticated;
create trigger workspace_payment_settings_guard before insert or update on public.workspaces
for each row execute function private.validate_payment_settings();

-- The token hash is generated from an opaque browser-held token by the trusted function.
-- Creating the preconsultation and pending order in one database transaction avoids orphans.
create function public.create_checkout_intent(
  p_service uuid,p_first_name text,p_last_name text,p_email text,p_phone text,
  p_answers jsonb,p_token_hash text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_intent uuid; v_workspace public.workspaces%rowtype; v_booking public.booking_intents%rowtype;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token_hash'; end if;
  v_intent := public.create_preconsultation_intent(p_service,p_first_name,p_last_name,p_email,p_phone,p_answers);
  select * into v_booking from public.booking_intents where id=v_intent;
  select * into v_workspace from public.workspaces where id=v_booking.workspace_id;
  if v_workspace.status='suspended' or (v_workspace.status='trial' and v_workspace.trial_ends_at < now())
    then raise exception 'workspace_unavailable'; end if;
  if v_workspace.payment_provider <> 'external_link' or v_workspace.external_payment_url is null
    then raise exception 'payment_not_configured'; end if;
  update public.booking_intents set access_token_hash=p_token_hash where id=v_intent;
  insert into public.payments(workspace_id,booking_intent_id,provider,provider_order_id,amount_minor,currency_code,status)
  values(v_booking.workspace_id,v_intent,'external_link',v_intent::text,v_booking.price_minor,v_booking.currency_code,'pending');
  return v_intent;
end $$;
revoke all on function public.create_checkout_intent(uuid,text,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_checkout_intent(uuid,text,text,text,text,jsonb,text) to service_role;

-- A professional records a payment only after independently checking their own provider.
-- The database verifies tenancy, role, order amount and state before unlocking scheduling.
create function private.confirm_external_payment(p_intent uuid,p_reference text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_payment public.payments%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required'; end if;
  if length(trim(coalesce(p_reference,''))) not between 4 and 120 then raise exception 'payment_reference_required'; end if;
  select * into v_intent from public.booking_intents where id=p_intent for update;
  if not found or v_intent.status <> 'pending_payment' or v_intent.expires_at < now()
    then raise exception 'intent_not_pending'; end if;
  if not (private.has_workspace_role(v_intent.workspace_id,array['owner','admin']::public.workspace_role[])
    or exists(select 1 from public.professionals p where p.id=v_intent.professional_id and p.user_id=(select auth.uid())))
    then raise exception 'not_authorized'; end if;
  select * into v_payment from public.payments where booking_intent_id=p_intent for update;
  if not found or v_payment.provider <> 'external_link' or v_payment.status <> 'pending'
    or v_payment.amount_minor <> v_intent.price_minor or v_payment.currency_code <> v_intent.currency_code
    then raise exception 'payment_not_pending'; end if;
  update public.payments set status='approved',approved_at=now(),manual_reference=trim(p_reference),
    provider_event_id='manual:' || v_payment.id::text
    where id=v_payment.id;
  update public.booking_intents set status='awaiting_schedule' where id=p_intent;
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_intent.workspace_id,(select auth.uid()),'external_payment_confirmed','booking_intent',p_intent);
end $$;
revoke all on function private.confirm_external_payment(uuid,text) from public,anon,authenticated;
grant execute on function private.confirm_external_payment(uuid,text) to authenticated;

create function public.confirm_external_payment(p_intent uuid,p_reference text)
returns void language sql security invoker set search_path = '' as $$
  select private.confirm_external_payment(p_intent,p_reference);
$$;
revoke all on function public.confirm_external_payment(uuid,text) from public,anon;
grant execute on function public.confirm_external_payment(uuid,text) to authenticated;

create function public.available_slots_for_intent(p_intent uuid,p_day date)
returns table(starts_at timestamptz) language plpgsql security invoker set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_rule public.availability_rules%rowtype;
  v_timezone text; v_notice integer; v_candidate timestamptz; v_end timestamptz; v_local timestamp;
begin
  select * into v_intent from public.booking_intents where id=p_intent;
  if not found or v_intent.status not in ('awaiting_schedule','payment_confirmed') or v_intent.expires_at < now()
    or not exists(select 1 from public.payments p where p.booking_intent_id=p_intent
      and p.status='approved' and p.amount_minor=v_intent.price_minor and p.currency_code=v_intent.currency_code)
    then return; end if;
  if p_day < (now() at time zone (select timezone from public.workspaces where id=v_intent.workspace_id))::date
    or p_day > (now() + interval '60 days')::date then return; end if;
  select w.timezone,s.min_notice_minutes into v_timezone,v_notice
  from public.workspaces w join public.services s on s.workspace_id=w.id
  where w.id=v_intent.workspace_id and s.id=v_intent.service_id and s.active;
  if v_timezone is null then return; end if;
  for v_rule in select * from public.availability_rules r
    where r.professional_id=v_intent.professional_id and r.workspace_id=v_intent.workspace_id
      and r.weekday=extract(dow from p_day)::integer loop
    for v_local in select gs from pg_catalog.generate_series(
      p_day + v_rule.starts_at,p_day + v_rule.ends_at - make_interval(mins=>v_intent.duration_minutes),
      interval '15 minutes') gs loop
      v_candidate := v_local at time zone v_timezone;
      v_end := v_candidate + make_interval(mins=>v_intent.duration_minutes);
      if v_candidate < now() + make_interval(mins=>v_notice) then continue; end if;
      if (v_end at time zone v_timezone)::date <> p_day then continue; end if;
      if exists(select 1 from public.availability_blocks b where b.professional_id=v_intent.professional_id
        and b.workspace_id=v_intent.workspace_id and tstzrange(b.starts_at,b.ends_at,'[)')
          && tstzrange(v_candidate,v_end,'[)')) then continue; end if;
      if exists(select 1 from public.appointments a where a.professional_id=v_intent.professional_id
        and a.workspace_id=v_intent.workspace_id and a.status in ('scheduled','completed')
        and tstzrange(a.starts_at - make_interval(mins=>v_rule.buffer_minutes),
          a.ends_at + make_interval(mins=>v_rule.buffer_minutes),'[)')
          && tstzrange(v_candidate,v_end,'[)')) then continue; end if;
      starts_at := v_candidate;
      return next;
    end loop;
  end loop;
end $$;
revoke all on function public.available_slots_for_intent(uuid,date) from public,anon,authenticated;
grant execute on function public.available_slots_for_intent(uuid,date) to service_role;

create or replace function public.schedule_paid_intent(p_intent uuid,p_starts_at timestamptz)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_id uuid; v_end timestamptz; v_local_day date;
begin
  select * into v_intent from public.booking_intents where id=p_intent for update;
  if not found or v_intent.status not in ('payment_confirmed','awaiting_schedule')
    then raise exception 'payment_not_confirmed'; end if;
  v_local_day := (p_starts_at at time zone (select timezone from public.workspaces where id=v_intent.workspace_id))::date;
  if not exists(select 1 from public.available_slots_for_intent(p_intent,v_local_day) s where s.starts_at=p_starts_at)
    then raise exception 'slot_unavailable'; end if;
  v_end := p_starts_at + make_interval(mins=>v_intent.duration_minutes);
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  values(v_intent.workspace_id,p_intent,v_intent.professional_id,v_intent.patient_id,p_starts_at,v_end)
  returning id into v_id;
  update public.booking_intents set status='scheduled' where id=p_intent;
  insert into public.notification_outbox(workspace_id,appointment_id,channel,template_key,deliver_after)
  values(v_intent.workspace_id,v_id,'email','patient_confirmed',now()),
    (v_intent.workspace_id,v_id,'email','professional_new',now()),
    (v_intent.workspace_id,v_id,'email','patient_reminder_24h',greatest(now(),p_starts_at - interval '24 hours')),
    (v_intent.workspace_id,v_id,'email','patient_reminder_2h',greatest(now(),p_starts_at - interval '2 hours'));
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(v_intent.workspace_id,'appointment_scheduled','appointment',v_id);
  return v_id;
end $$;
revoke all on function public.schedule_paid_intent(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.schedule_paid_intent(uuid,timestamptz) to service_role;
