-- Mercado Pago OAuth: each workspace connects its own seller account.
-- Tokens stay in Vault. The browser can read the connection status, never a token.

alter table private.mercado_pago_accounts
  alter column access_token_secret_id drop not null,
  add column refresh_token_secret_id uuid,
  add column token_expires_at timestamptz,
  add column status text not null default 'connected' check (status in ('connected','disconnected','error')),
  add column connected_by uuid references auth.users(id) on delete set null,
  add column disconnected_at timestamptz,
  add column refresh_locked_until timestamptz,
  add column updated_at timestamptz not null default now();
update private.mercado_pago_accounts set status='disconnected' where not active;
-- `active` is what the existing checkout reads; it can never disagree with the connection status.
alter table private.mercado_pago_accounts
  add constraint mercado_pago_accounts_active_matches_status check (active = (status='connected')),
  add constraint mercado_pago_accounts_connected_has_token
    check (status<>'connected' or access_token_secret_id is not null);

-- One row per authorization attempt. Only the SHA-256 of the state is stored.
create table private.mercado_pago_oauth_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index mercado_pago_oauth_states_workspace on private.mercado_pago_oauth_states(workspace_id);
alter table private.mercado_pago_oauth_states enable row level security;
revoke all on private.mercado_pago_oauth_states from public, anon, authenticated;

create function private.put_mercado_pago_secret(p_id uuid,p_value text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if p_id is not null and exists(select 1 from vault.secrets s where s.id=p_id) then
    perform vault.update_secret(p_id,p_value);
    return p_id;
  end if;
  return vault.create_secret(p_value,null,'Bellis Mercado Pago');
end $$;
revoke all on function private.put_mercado_pago_secret(uuid,text) from public, anon, authenticated;

-- The Edge Function has already verified the caller's session; the workspace comes from membership, never from the request.
create function public.start_mercado_pago_oauth(p_user uuid,p_state_hash text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_workspace uuid; v_role public.workspace_role;
begin
  if p_state_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_oauth_state'; end if;
  select m.workspace_id,m.role into v_workspace,v_role from public.workspace_members m
    where m.user_id=p_user order by m.created_at limit 1;
  if v_workspace is null or v_role<>'owner' then raise exception 'not_authorized'; end if;
  -- Only the latest attempt of a workspace stays valid.
  delete from private.mercado_pago_oauth_states s
    where s.expires_at < now() - interval '1 day' or (s.workspace_id=v_workspace and s.consumed_at is null);
  insert into private.mercado_pago_oauth_states(state_hash,workspace_id,user_id,expires_at)
  values(p_state_hash,v_workspace,p_user,now()+interval '10 minutes');
  return v_workspace;
end $$;
revoke all on function public.start_mercado_pago_oauth(uuid,text) from public, anon, authenticated;
grant execute on function public.start_mercado_pago_oauth(uuid,text) to service_role;

-- Completing needs the state AND the session of the person who started it: holding the link is not enough.
-- `p_user` is the verified session of whoever came back from Mercado Pago. Returns the workspace only when the
-- state is live, was started by that same person, and they still own that workspace. Single use: checked and
-- consumed under one row lock. A state presented by anyone else is burned, so it cannot be completed afterwards.
create function public.consume_mercado_pago_oauth_state(p_state_hash text,p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_state private.mercado_pago_oauth_states%rowtype;
begin
  select * into v_state from private.mercado_pago_oauth_states s where s.state_hash=p_state_hash for update;
  if not found or v_state.consumed_at is not null or v_state.expires_at<=now() then return null; end if;
  update private.mercado_pago_oauth_states s set consumed_at=now() where s.state_hash=p_state_hash;
  if p_user is null or v_state.user_id<>p_user or not exists(select 1 from public.workspace_members m
    where m.workspace_id=v_state.workspace_id and m.user_id=p_user and m.role='owner') then return null; end if;
  return v_state.workspace_id;
end $$;
revoke all on function public.consume_mercado_pago_oauth_state(text,uuid) from public, anon, authenticated;
grant execute on function public.consume_mercado_pago_oauth_state(text,uuid) to service_role;

create function public.store_mercado_pago_connection(
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
revoke all on function public.store_mercado_pago_connection(uuid,uuid,text,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.store_mercado_pago_connection(uuid,uuid,text,text,text,timestamptz,text) to service_role;

-- Callable only with the Edge Function's service key. Never expose its result to a browser.
create function public.mercado_pago_credentials(p_workspace uuid)
returns table(seller_user_id text,access_token text,refresh_token text,token_expires_at timestamptz,environment text)
language sql security definer set search_path = '' as $$
  select a.seller_user_id,s.decrypted_secret,r.decrypted_secret,a.token_expires_at,a.environment
  from private.mercado_pago_accounts a
  join vault.decrypted_secrets s on s.id=a.access_token_secret_id
  left join vault.decrypted_secrets r on r.id=a.refresh_token_secret_id
  where a.workspace_id=p_workspace and a.status='connected';
$$;
revoke all on function public.mercado_pago_credentials(uuid) from public, anon, authenticated;
grant execute on function public.mercado_pago_credentials(uuid) to service_role;

-- Short lease so two requests do not spend the same refresh token at once.
create function public.claim_mercado_pago_refresh(p_workspace uuid)
returns boolean language sql security definer set search_path = '' as $$
  with claimed as (
    update private.mercado_pago_accounts a set refresh_locked_until=now()+interval '30 seconds'
    where a.workspace_id=p_workspace and a.status='connected' and a.refresh_token_secret_id is not null
      and (a.refresh_locked_until is null or a.refresh_locked_until<now())
    returning 1)
  select exists(select 1 from claimed);
$$;
revoke all on function public.claim_mercado_pago_refresh(uuid) from public, anon, authenticated;
grant execute on function public.claim_mercado_pago_refresh(uuid) to service_role;

create function public.rotate_mercado_pago_tokens(
  p_workspace uuid,p_access_token text,p_refresh_token text,p_expires_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare v_account private.mercado_pago_accounts%rowtype; v_refresh uuid;
begin
  if length(p_access_token) not between 10 and 2000
    or (p_refresh_token is not null and length(p_refresh_token) not between 10 and 2000)
    or (p_expires_at is not null and p_expires_at <= now()) then raise exception 'invalid_mercado_pago_connection'; end if;
  select * into v_account from private.mercado_pago_accounts a
    where a.workspace_id=p_workspace and a.status='connected' for update;
  if not found then raise exception 'mercado_pago_not_connected'; end if;
  perform private.put_mercado_pago_secret(v_account.access_token_secret_id,p_access_token);
  v_refresh := v_account.refresh_token_secret_id;
  -- Mercado Pago may rotate the refresh token; keep the stored one when it does not send a new one.
  if p_refresh_token is not null then v_refresh := private.put_mercado_pago_secret(v_refresh,p_refresh_token); end if;
  update private.mercado_pago_accounts a set refresh_token_secret_id=v_refresh,token_expires_at=p_expires_at,
    refresh_locked_until=null,updated_at=now() where a.workspace_id=p_workspace;
end $$;
revoke all on function public.rotate_mercado_pago_tokens(uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.rotate_mercado_pago_tokens(uuid,text,text,timestamptz) to service_role;

-- A refresh Mercado Pago rejected for good leaves the account in 'error' until the owner reconnects.
create function public.fail_mercado_pago_refresh(p_workspace uuid,p_permanent boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.mercado_pago_accounts a set refresh_locked_until=null,updated_at=now(),
    status=case when p_permanent then 'error' else a.status end,
    active=case when p_permanent then false else a.active end
  where a.workspace_id=p_workspace and a.status='connected';
  if found and p_permanent then
    insert into public.audit_events(workspace_id,action,object_type,object_id)
    values(p_workspace,'mercado_pago_connection_error','workspace',p_workspace);
  end if;
end $$;
revoke all on function public.fail_mercado_pago_refresh(uuid,boolean) from public, anon, authenticated;
grant execute on function public.fail_mercado_pago_refresh(uuid,boolean) to service_role;

-- What the panel may know about the connection. 'expired' is derived: connected, past its expiry and with no refresh token.
create function private.mercado_pago_connection_status(p_workspace uuid)
returns table(connected boolean,provider text,status text,account_hint text,environment text,
  connected_at timestamptz,token_expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_workspace_role(p_workspace,array['owner','admin']::public.workspace_role[])
    then raise exception 'not_authorized'; end if;
  return query
  select v.status='connected','mercado_pago_ar'::text,v.status,
    case when v.status<>'disconnected' then '••••' || right(a.seller_user_id,4) end,
    case when v.status<>'disconnected' then a.environment end,
    case when v.status<>'disconnected' then a.connected_at end,
    case when v.status<>'disconnected' then a.token_expires_at end
  from (select 1) one
  left join private.mercado_pago_accounts a on a.workspace_id=p_workspace
  cross join lateral (select case
    when a.workspace_id is null then 'disconnected'
    when a.status='connected' and a.token_expires_at<now() and a.refresh_token_secret_id is null then 'expired'
    else a.status end as status) v;
end $$;
revoke all on function private.mercado_pago_connection_status(uuid) from public, anon;
grant execute on function private.mercado_pago_connection_status(uuid) to authenticated;

create function public.mercado_pago_connection_status(p_workspace uuid)
returns table(connected boolean,provider text,status text,account_hint text,environment text,
  connected_at timestamptz,token_expires_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select * from private.mercado_pago_connection_status(p_workspace);
$$;
revoke all on function public.mercado_pago_connection_status(uuid) from public, anon;
grant execute on function public.mercado_pago_connection_status(uuid) to authenticated;

-- Forgets the tokens Bellis holds. It does not revoke the authorization inside Mercado Pago.
-- A workspace is never left with Mercado Pago as its method and no account: it goes back to the external link.
-- With a saved link patients keep paying through it; without one the workspace has no usable method until the owner sets one.
create function private.disconnect_mercado_pago(p_workspace uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_account private.mercado_pago_accounts%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required'; end if;
  if not private.has_workspace_role(p_workspace,array['owner']::public.workspace_role[])
    then raise exception 'not_authorized'; end if;
  delete from private.mercado_pago_oauth_states s where s.workspace_id=p_workspace;
  select * into v_account from private.mercado_pago_accounts a where a.workspace_id=p_workspace for update;
  if not found or v_account.status='disconnected' then return; end if;
  update private.mercado_pago_accounts a set status='disconnected',active=false,access_token_secret_id=null,
    refresh_token_secret_id=null,token_expires_at=null,refresh_locked_until=null,disconnected_at=now(),updated_at=now()
  where a.workspace_id=p_workspace;
  delete from vault.secrets s where s.id in (v_account.access_token_secret_id,v_account.refresh_token_secret_id);
  update public.workspaces w set payment_provider='external_link'
    where w.id=p_workspace and w.payment_provider='mercado_pago_ar';
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(p_workspace,(select auth.uid()),'mercado_pago_disconnected','workspace',p_workspace);
end $$;
revoke all on function private.disconnect_mercado_pago(uuid) from public, anon;
grant execute on function private.disconnect_mercado_pago(uuid) to authenticated;

create function public.disconnect_mercado_pago(p_workspace uuid)
returns void language sql security invoker set search_path = '' as $$
  select private.disconnect_mercado_pago(p_workspace);
$$;
revoke all on function public.disconnect_mercado_pago(uuid) from public, anon;
grant execute on function public.disconnect_mercado_pago(uuid) to authenticated;

-- Mercado Pago can only become a workspace's payment method while its account is connected.
-- The panel checks this too, but the rule lives here: it holds for any client that can update the workspace.
create function private.require_mercado_pago_connection()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.payment_provider='mercado_pago_ar' and old.payment_provider is distinct from new.payment_provider
    and not exists(select 1 from private.mercado_pago_accounts a where a.workspace_id=new.id and a.status='connected'
      -- Same rule as the status the panel shows: past its expiry with nothing to renew it is not connected.
      and not (a.token_expires_at<now() and a.refresh_token_secret_id is null))
    then raise exception 'mercado_pago_not_connected'; end if;
  return new;
end $$;
revoke all on function private.require_mercado_pago_connection() from public, anon, authenticated;
create trigger workspace_mercado_pago_guard before update of payment_provider on public.workspaces
for each row execute function private.require_mercado_pago_connection();
