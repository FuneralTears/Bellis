-- Google Calendar, H3.1A: connecting a professional's Google account, nothing else.
-- What this adds:
--   1. private.workspace_features: a minimal rollout switch per workspace. It is not an entitlement: what a plan
--      includes is still private.workspace_has_capability. A feature is turned on by hand, with SQL run by a person
--      on the database (docs/google-calendar.md); there is no RPC to change it.
--   2. The 'google_calendar_sync' capability for Pro and the trial.
--   3. The connection of one professional to one Google account and one calendar ("Turnos Bellis"), tokens in Vault.
-- What it does not add: events, sync state, busy blocks or jobs (H3.1B onwards).
-- Google Calendar is available to a workspace only when it has BOTH the capability and the 'google_calendar_beta'
-- feature. Disconnecting is always possible.

-- 1. Rollout flags ---------------------------------------------------------------------------------------------
create table private.workspace_features (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feature text not null check (feature ~ '^[a-z][a-z0-9_]{2,62}$'),
  enabled_at timestamptz not null default now(),
  -- Operational note of who turned it on (free text). Not an audit trail.
  enabled_by text check (enabled_by is null or length(enabled_by) between 1 and 200),
  primary key (workspace_id, feature)
);
alter table private.workspace_features enable row level security;
-- No policy and no grant: no session reads or writes it. service_role is privileged and does not need it either.
revoke all on private.workspace_features from public, anon, authenticated, service_role;

create function private.workspace_has_feature(p_workspace uuid,p_feature text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_feature is null or p_feature !~ '^[a-z][a-z0-9_]{2,62}$' then raise exception 'invalid_feature'; end if;
  if p_workspace is null then return false; end if;
  return exists(select 1 from private.workspace_features f where f.workspace_id=p_workspace and f.feature=p_feature);
end $$;
revoke all on function private.workspace_has_feature(uuid,text) from public, anon, authenticated, service_role;

-- 2. Capability ------------------------------------------------------------------------------------------------
-- Same list as 20261016110000_free_pro_boundary, plus google_calendar_sync for Pro and the trial.
create or replace function private.plan_capabilities(p_tier text) returns text[]
language sql immutable set search_path = '' as $$
  select array['manual_patients','manual_appointments','manual_payments','patient_notes','public_booking','external_payment_link']
    || case when p_tier in ('pro','pro_trial') then array['followups','crm','smart_followups','automations','mercado_pago',
      'google_calendar_sync','patient_origin','advanced_tags','insurance_management','weekly_metrics','advanced_insights','reports','marketing_tools']
      else array[]::text[] end;
$$;

-- Entitlement AND rollout. The only place that combines them; the panel reads the answer, never the rule.
create function private.google_calendar_available(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.workspace_has_capability(p_workspace,'google_calendar_sync')
    and private.workspace_has_feature(p_workspace,'google_calendar_beta'),false);
$$;
revoke all on function private.google_calendar_available(uuid) from public, anon, authenticated, service_role;
-- Why it is not available, for the start of a connection: 'pro_access_required' or 'feature_not_enabled'.
create function private.require_google_calendar_available(p_workspace uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.workspace_has_capability(p_workspace,'google_calendar_sync') then raise exception 'pro_access_required'; end if;
  if not private.workspace_has_feature(p_workspace,'google_calendar_beta') then raise exception 'feature_not_enabled'; end if;
end $$;
revoke all on function private.require_google_calendar_available(uuid) from public, anon, authenticated, service_role;

-- 3. Connection ------------------------------------------------------------------------------------------------
-- One row per professional, kept after a disconnection: google_subject and calendar_id let a later reconnection
-- of the same Google account reuse the same "Turnos Bellis" calendar instead of creating another one.
create table private.google_calendar_accounts (
  professional_id uuid primary key,
  workspace_id uuid not null,
  google_subject text not null check (google_subject ~ '^[A-Za-z0-9_-]{1,255}$'),
  email text check (email is null or (length(email) between 3 and 320 and email like '%@%')),
  access_token_secret_id uuid,
  refresh_token_secret_id uuid,
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  status text not null check (status in ('connected','needs_reconnect','paused','disconnected')),
  calendar_id text check (calendar_id is null or length(calendar_id) between 1 and 1024),
  calendar_timezone text check (calendar_timezone is null or length(calendar_timezone) between 1 and 64),
  connected_at timestamptz,
  disconnected_at timestamptz,
  refresh_locked_until timestamptz,
  last_refresh_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, professional_id) references public.professionals(workspace_id, id) on delete cascade,
  constraint google_calendar_connected_complete check (status<>'connected'
    or (access_token_secret_id is not null and refresh_token_secret_id is not null and calendar_id is not null)),
  constraint google_calendar_disconnected_has_no_tokens check (status<>'disconnected'
    or (access_token_secret_id is null and refresh_token_secret_id is null))
);
create index google_calendar_accounts_workspace on private.google_calendar_accounts(workspace_id);
alter table private.google_calendar_accounts enable row level security;
revoke all on private.google_calendar_accounts from public, anon, authenticated;

-- One row per authorization attempt. Only the SHA-256 of the state is stored. The PKCE verifier has to be kept
-- between the start and the return; it lives here for at most 10 minutes and is erased when the state is used.
create table private.google_calendar_oauth_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null,
  professional_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text check (code_verifier is null or code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (workspace_id, professional_id) references public.professionals(workspace_id, id) on delete cascade
);
create index google_calendar_oauth_states_professional on private.google_calendar_oauth_states(professional_id);
alter table private.google_calendar_oauth_states enable row level security;
revoke all on private.google_calendar_oauth_states from public, anon, authenticated;

create function private.put_google_calendar_secret(p_id uuid,p_value text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if p_id is not null and exists(select 1 from vault.secrets s where s.id=p_id) then
    perform vault.update_secret(p_id,p_value);
    return p_id;
  end if;
  return vault.create_secret(p_value,null,'Bellis Google Calendar');
end $$;
revoke all on function private.put_google_calendar_secret(uuid,text) from public, anon, authenticated;

-- The professional profile of a person: their own, in a workspace they belong to. Never taken from a request.
create function private.google_calendar_professional(p_user uuid,p_workspace uuid default null)
returns table(professional_id uuid,workspace_id uuid)
language sql stable security definer set search_path = '' as $$
  select p.id,p.workspace_id from public.professionals p
  join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p_user
  where p_user is not null and p.user_id=p_user and (p_workspace is null or p.workspace_id=p_workspace)
  order by m.created_at,p.created_at limit 1;
$$;
revoke all on function private.google_calendar_professional(uuid,uuid) from public, anon, authenticated;
-- The same, for the Edge Function (disconnecting has to know whose tokens to revoke).
create function public.google_calendar_professional_id(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select g.professional_id from private.google_calendar_professional(p_user) g;
$$;
revoke all on function public.google_calendar_professional_id(uuid) from public, anon, authenticated;
grant execute on function public.google_calendar_professional_id(uuid) to service_role;

-- Starts an attempt for the caller's own professional profile (the Edge Function has verified the session).
-- `has_refresh_token`: Bellis already holds a working refresh token for this professional, so Google does not have
-- to be asked for consent again; without one the authorization asks for it (prompt=consent).
create function public.start_google_calendar_oauth(p_user uuid,p_state_hash text,p_code_verifier text)
returns table(workspace_id uuid,professional_id uuid,has_refresh_token boolean)
language plpgsql security definer set search_path = '' as $$
declare v_professional uuid; v_workspace uuid;
begin
  if p_state_hash is null or p_state_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_oauth_state'; end if;
  if p_code_verifier is null or p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then raise exception 'invalid_oauth_state'; end if;
  select g.professional_id,g.workspace_id into v_professional,v_workspace from private.google_calendar_professional(p_user) g;
  if v_professional is null then raise exception 'not_authorized'; end if;
  perform private.require_google_calendar_available(v_workspace);
  -- Only the latest attempt of a professional stays valid; old rows are cleaned up on the way.
  delete from private.google_calendar_oauth_states s
    where s.expires_at < now() - interval '1 day' or (s.professional_id=v_professional and s.consumed_at is null);
  insert into private.google_calendar_oauth_states(state_hash,workspace_id,professional_id,user_id,code_verifier,expires_at)
  values(p_state_hash,v_workspace,v_professional,p_user,p_code_verifier,now()+interval '10 minutes');
  return query select v_workspace,v_professional,exists(select 1 from private.google_calendar_accounts a
    where a.professional_id=v_professional and a.status='connected' and a.refresh_token_secret_id is not null);
end $$;
revoke all on function public.start_google_calendar_oauth(uuid,text,text) from public, anon, authenticated;
grant execute on function public.start_google_calendar_oauth(uuid,text,text) to service_role;

-- Single use, under one row lock. Returns the attempt only to the person who started it, while it is live and
-- they still are that professional in that workspace. Presented by anyone else, the state is burned.
create function public.consume_google_calendar_oauth_state(p_state_hash text,p_user uuid)
returns table(workspace_id uuid,professional_id uuid,code_verifier text)
language plpgsql security definer set search_path = '' as $$
declare v_state private.google_calendar_oauth_states%rowtype;
begin
  select * into v_state from private.google_calendar_oauth_states s where s.state_hash=p_state_hash for update;
  if not found or v_state.consumed_at is not null or v_state.expires_at<=now() then return; end if;
  update private.google_calendar_oauth_states s set consumed_at=now(),code_verifier=null where s.state_hash=p_state_hash;
  if p_user is null or v_state.user_id<>p_user or not exists(select 1 from private.google_calendar_professional(p_user,v_state.workspace_id) g
    where g.professional_id=v_state.professional_id) then return; end if;
  return query select v_state.workspace_id,v_state.professional_id,v_state.code_verifier;
end $$;
revoke all on function public.consume_google_calendar_oauth_state(text,uuid) from public, anon, authenticated;
grant execute on function public.consume_google_calendar_oauth_state(text,uuid) to service_role;

-- What a new authorization needs to know about the previous one. No token.
create function public.google_calendar_previous_connection(p_professional uuid)
returns table(google_subject text,calendar_id text,status text,has_refresh_token boolean)
language sql stable security definer set search_path = '' as $$
  select a.google_subject,a.calendar_id,a.status,a.refresh_token_secret_id is not null
  from private.google_calendar_accounts a where a.professional_id=p_professional;
$$;
revoke all on function public.google_calendar_previous_connection(uuid) from public, anon, authenticated;
grant execute on function public.google_calendar_previous_connection(uuid) to service_role;

-- Saves a completed authorization. Without a new refresh token, the stored one is kept only for the same Google
-- account; otherwise the connection is refused ('google_refresh_token_missing') and nothing changes.
create function public.store_google_calendar_connection(
  p_professional uuid,p_user uuid,p_subject text,p_email text,p_access_token text,p_refresh_token text,
  p_expires_at timestamptz,p_scopes text[],p_calendar_id text,p_calendar_timezone text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_account private.google_calendar_accounts%rowtype; v_workspace uuid; v_access uuid; v_refresh uuid;
begin
  if p_subject is null or p_subject !~ '^[A-Za-z0-9_-]{1,255}$'
    or (p_email is not null and (length(p_email) not between 3 and 320 or p_email not like '%@%'))
    or p_access_token is null or length(p_access_token) not between 10 and 4096
    or (p_refresh_token is not null and length(p_refresh_token) not between 10 and 4096)
    or p_expires_at is null or p_expires_at <= now()
    or p_calendar_id is null or length(p_calendar_id) not between 1 and 1024
    or (p_calendar_timezone is not null and length(p_calendar_timezone) not between 1 and 64)
    then raise exception 'invalid_google_calendar_connection'; end if;
  if p_scopes is null or not (p_scopes @> array['https://www.googleapis.com/auth/calendar.app.created',
    'https://www.googleapis.com/auth/calendar.freebusy']) then raise exception 'google_scopes_missing'; end if;
  select g.workspace_id into v_workspace from private.google_calendar_professional(p_user) g where g.professional_id=p_professional;
  if v_workspace is null then raise exception 'not_authorized'; end if;
  perform private.require_google_calendar_available(v_workspace);
  select * into v_account from private.google_calendar_accounts a where a.professional_id=p_professional for update;
  if p_refresh_token is null and not (found and v_account.google_subject=p_subject and v_account.refresh_token_secret_id is not null)
    then raise exception 'google_refresh_token_missing'; end if;
  v_access := private.put_google_calendar_secret(v_account.access_token_secret_id,p_access_token);
  v_refresh := v_account.refresh_token_secret_id;
  if p_refresh_token is not null then v_refresh := private.put_google_calendar_secret(v_refresh,p_refresh_token); end if;
  insert into private.google_calendar_accounts as a(professional_id,workspace_id,google_subject,email,access_token_secret_id,
    refresh_token_secret_id,token_expires_at,granted_scopes,status,calendar_id,calendar_timezone,connected_at)
  values(p_professional,v_workspace,p_subject,p_email,v_access,v_refresh,p_expires_at,p_scopes,'connected',
    p_calendar_id,p_calendar_timezone,now())
  on conflict(professional_id) do update set workspace_id=excluded.workspace_id,google_subject=excluded.google_subject,
    email=excluded.email,access_token_secret_id=excluded.access_token_secret_id,refresh_token_secret_id=excluded.refresh_token_secret_id,
    token_expires_at=excluded.token_expires_at,granted_scopes=excluded.granted_scopes,status='connected',
    calendar_id=excluded.calendar_id,calendar_timezone=excluded.calendar_timezone,connected_at=now(),disconnected_at=null,
    refresh_locked_until=null,last_error_code=null,last_error_at=null,updated_at=now();
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_workspace,p_user,'google_calendar_connected','professional',p_professional);
end $$;
revoke all on function public.store_google_calendar_connection(uuid,uuid,text,text,text,text,timestamptz,text[],text,text) from public, anon, authenticated;
grant execute on function public.store_google_calendar_connection(uuid,uuid,text,text,text,text,timestamptz,text[],text,text) to service_role;

-- Callable only with the Edge Functions' service key. Never expose its result to a browser.
-- Any professional whose tokens Bellis still holds, whatever the status: disconnecting needs them to revoke.
create function public.google_calendar_credentials(p_professional uuid)
returns table(workspace_id uuid,google_subject text,status text,access_token text,refresh_token text,
  token_expires_at timestamptz,calendar_id text)
language sql security definer set search_path = '' as $$
  select a.workspace_id,a.google_subject,a.status,s.decrypted_secret,r.decrypted_secret,a.token_expires_at,a.calendar_id
  from private.google_calendar_accounts a
  join vault.decrypted_secrets s on s.id=a.access_token_secret_id
  left join vault.decrypted_secrets r on r.id=a.refresh_token_secret_id
  where a.professional_id=p_professional;
$$;
revoke all on function public.google_calendar_credentials(uuid) from public, anon, authenticated;
grant execute on function public.google_calendar_credentials(uuid) to service_role;

-- Short lease so two requests do not spend the same refresh token at once.
create function public.claim_google_calendar_refresh(p_professional uuid)
returns boolean language sql security definer set search_path = '' as $$
  with claimed as (
    update private.google_calendar_accounts a set refresh_locked_until=now()+interval '30 seconds'
    where a.professional_id=p_professional and a.status='connected' and a.refresh_token_secret_id is not null
      and (a.refresh_locked_until is null or a.refresh_locked_until<now())
    returning 1)
  select exists(select 1 from claimed);
$$;
revoke all on function public.claim_google_calendar_refresh(uuid) from public, anon, authenticated;
grant execute on function public.claim_google_calendar_refresh(uuid) to service_role;

create function public.rotate_google_calendar_tokens(
  p_professional uuid,p_access_token text,p_refresh_token text,p_expires_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare v_account private.google_calendar_accounts%rowtype; v_refresh uuid;
begin
  if p_access_token is null or length(p_access_token) not between 10 and 4096
    or (p_refresh_token is not null and length(p_refresh_token) not between 10 and 4096)
    or p_expires_at is null or p_expires_at <= now() then raise exception 'invalid_google_calendar_connection'; end if;
  select * into v_account from private.google_calendar_accounts a
    where a.professional_id=p_professional and a.status='connected' for update;
  if not found then raise exception 'google_calendar_not_connected'; end if;
  perform private.put_google_calendar_secret(v_account.access_token_secret_id,p_access_token);
  v_refresh := v_account.refresh_token_secret_id;
  -- Google rarely sends a new refresh token on a renewal; the stored one is kept when it does not.
  if p_refresh_token is not null then v_refresh := private.put_google_calendar_secret(v_refresh,p_refresh_token); end if;
  update private.google_calendar_accounts a set refresh_token_secret_id=v_refresh,token_expires_at=p_expires_at,
    refresh_locked_until=null,last_refresh_at=now(),last_error_code=null,last_error_at=null,updated_at=now()
  where a.professional_id=p_professional;
end $$;
revoke all on function public.rotate_google_calendar_tokens(uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.rotate_google_calendar_tokens(uuid,text,text,timestamptz) to service_role;

-- A renewal that failed. Permanent (Google answered invalid_grant: revoked, expired, password changed): the tokens
-- are useless, they are erased and the professional has to reconnect. Otherwise only the error is noted.
create function public.fail_google_calendar_refresh(p_professional uuid,p_permanent boolean,p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_account private.google_calendar_accounts%rowtype; v_code text;
begin
  v_code := case when p_error_code ~ '^[a-z0-9_]{1,64}$' then p_error_code else 'google_refresh_failed' end;
  select * into v_account from private.google_calendar_accounts a
    where a.professional_id=p_professional and a.status='connected' for update;
  if not found then return; end if;
  if coalesce(p_permanent,false) then
    update private.google_calendar_accounts a set status='needs_reconnect',access_token_secret_id=null,refresh_token_secret_id=null,
      token_expires_at=null,refresh_locked_until=null,last_error_code=v_code,last_error_at=now(),updated_at=now()
    where a.professional_id=p_professional;
    delete from vault.secrets s where s.id in (v_account.access_token_secret_id,v_account.refresh_token_secret_id);
    insert into public.audit_events(workspace_id,action,object_type,object_id)
    values(v_account.workspace_id,'google_calendar_needs_reconnect','professional',p_professional);
  else
    update private.google_calendar_accounts a set refresh_locked_until=null,last_error_code=v_code,last_error_at=now(),updated_at=now()
    where a.professional_id=p_professional;
  end if;
end $$;
revoke all on function public.fail_google_calendar_refresh(uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.fail_google_calendar_refresh(uuid,boolean,text) to service_role;

-- Disconnecting: after the Edge Function asked Google to revoke the authorization, Bellis forgets the tokens.
-- google_subject and calendar_id stay, so reconnecting the same account reuses the same calendar; the calendar is
-- not deleted in Google. Needs neither the plan nor the feature. Returns the professional, or null if none.
create function public.disconnect_google_calendar(p_user uuid,p_revoked boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_professional uuid; v_account private.google_calendar_accounts%rowtype;
begin
  select g.professional_id into v_professional from private.google_calendar_professional(p_user) g;
  if v_professional is null then raise exception 'not_authorized'; end if;
  delete from private.google_calendar_oauth_states s where s.professional_id=v_professional;
  select * into v_account from private.google_calendar_accounts a where a.professional_id=v_professional for update;
  if not found or v_account.status='disconnected' then return v_professional; end if;
  update private.google_calendar_accounts a set status='disconnected',access_token_secret_id=null,refresh_token_secret_id=null,
    token_expires_at=null,refresh_locked_until=null,disconnected_at=now(),updated_at=now(),
    last_error_code=case when coalesce(p_revoked,false) then null else 'google_revoke_failed' end,
    last_error_at=case when coalesce(p_revoked,false) then null else now() end
  where a.professional_id=v_professional;
  delete from vault.secrets s where s.id in (v_account.access_token_secret_id,v_account.refresh_token_secret_id);
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_account.workspace_id,p_user,'google_calendar_disconnected','professional',v_professional);
  return v_professional;
end $$;
revoke all on function public.disconnect_google_calendar(uuid,boolean) from public, anon, authenticated;
grant execute on function public.disconnect_google_calendar(uuid,boolean) to service_role;

-- What the panel may know, for the signed-in person's own professional profile in this workspace. No token, no
-- calendar id, no Google subject. `available` is the whole rule (plan AND rollout); the panel never rebuilds it.
-- `unavailable_reason` only picks the wording when it is not available: 'not_enabled' (the rollout does not include
-- this workspace: nothing is shown), 'plan_required' (shown as part of Bellis Pro) or 'no_professional'.
-- A connection that is still stored while the workspace is no longer entitled reads as 'paused'.
create function private.google_calendar_status(p_workspace uuid)
returns table(available boolean,unavailable_reason text,connected boolean,status text,email text,calendar_label text,
  connected_at timestamptz,last_refresh_at timestamptz,last_error_code text)
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_professional uuid; v_available boolean; v_reason text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not exists(select 1 from public.workspace_members m where m.workspace_id=p_workspace and m.user_id=v_user)
    then raise exception 'not_authorized'; end if;
  select g.professional_id into v_professional from private.google_calendar_professional(v_user,p_workspace) g;
  v_reason := case
    when not private.workspace_has_feature(p_workspace,'google_calendar_beta') then 'not_enabled'
    when not private.workspace_has_capability(p_workspace,'google_calendar_sync') then 'plan_required'
    when v_professional is null then 'no_professional' end;
  v_available := v_reason is null and private.google_calendar_available(p_workspace);
  return query
  select v_available,v_reason,v.status='connected',v.status,
    case when v.status<>'disconnected' then a.email end,
    case when v.status<>'disconnected' and a.calendar_id is not null then 'Turnos Bellis' end,
    case when v.status<>'disconnected' then a.connected_at end,
    case when v.status<>'disconnected' then a.last_refresh_at end,
    case when v.status<>'disconnected' then a.last_error_code end
  from (select 1) one
  left join private.google_calendar_accounts a on a.professional_id=v_professional
  cross join lateral (select case
    when a.professional_id is null then 'disconnected'
    when a.status='connected' and not v_available then 'paused'
    else a.status end as status) v;
end $$;
revoke all on function private.google_calendar_status(uuid) from public, anon;
grant execute on function private.google_calendar_status(uuid) to authenticated;

create function public.google_calendar_status(p_workspace uuid)
returns table(available boolean,unavailable_reason text,connected boolean,status text,email text,calendar_label text,
  connected_at timestamptz,last_refresh_at timestamptz,last_error_code text)
language sql stable security invoker set search_path = '' as $$
  select * from private.google_calendar_status(p_workspace);
$$;
revoke all on function public.google_calendar_status(uuid) from public, anon;
grant execute on function public.google_calendar_status(uuid) to authenticated;
