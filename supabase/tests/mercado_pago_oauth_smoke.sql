-- Run only on the development project or a local database. Synthetic records are rolled back.
begin;
insert into public.workspaces(id,name,slug) values
  ('f4000000-0000-4000-8000-00000000000a','OAuth A','oauth-smoke-a'),
  ('f4000000-0000-4000-8000-00000000000b','OAuth B','oauth-smoke-b');
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',id::uuid,'authenticated','authenticated',email,'',now(),'{}','{}',now(),now()
from (values ('f4000000-0000-4000-8000-0000000000a1','oauth-owner-a@example.invalid'),
  ('f4000000-0000-4000-8000-0000000000a2','oauth-admin-a@example.invalid'),
  ('f4000000-0000-4000-8000-0000000000b1','oauth-owner-b@example.invalid')) u(id,email);
-- The sign-up trigger may already have created workspaces for these users: keep only the ones under test.
delete from public.workspace_members where user_id in ('f4000000-0000-4000-8000-0000000000a1',
  'f4000000-0000-4000-8000-0000000000a2','f4000000-0000-4000-8000-0000000000b1');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('f4000000-0000-4000-8000-00000000000a','f4000000-0000-4000-8000-0000000000a1','owner'),
  ('f4000000-0000-4000-8000-00000000000a','f4000000-0000-4000-8000-0000000000a2','admin'),
  ('f4000000-0000-4000-8000-00000000000b','f4000000-0000-4000-8000-0000000000b1','owner');

-- State: owner only, latest attempt only, single use, short lived, and bound to the person who started it.
set local role service_role;
do $$
begin
  begin
    perform public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a2',repeat('1',64));
    raise exception 'admin_started_oauth';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  if public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('1',64))
    <> 'f4000000-0000-4000-8000-00000000000a' then raise exception 'state_bound_to_wrong_workspace'; end if;
  -- A new attempt replaces the previous one.
  perform public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('2',64));
  if public.consume_mercado_pago_oauth_state(repeat('1',64),'f4000000-0000-4000-8000-0000000000a1') is not null
    then raise exception 'superseded_state_accepted'; end if;
  if public.consume_mercado_pago_oauth_state(repeat('9',64),'f4000000-0000-4000-8000-0000000000a1') is not null
    then raise exception 'unknown_state_accepted'; end if;
  -- A. The person who started completes.
  if public.consume_mercado_pago_oauth_state(repeat('2',64),'f4000000-0000-4000-8000-0000000000a1')
    is distinct from 'f4000000-0000-4000-8000-00000000000a' then raise exception 'a_initiator_rejected'; end if;
  -- F. Reused.
  if public.consume_mercado_pago_oauth_state(repeat('2',64),'f4000000-0000-4000-8000-0000000000a1') is not null
    then raise exception 'f_state_used_twice'; end if;
  -- B / D. Another signed-in person presents A's state: refused, and the state is burned even for A.
  perform public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('3',64));
  if public.consume_mercado_pago_oauth_state(repeat('3',64),'f4000000-0000-4000-8000-0000000000b1') is not null
    then raise exception 'b_other_user_completed'; end if;
  if public.consume_mercado_pago_oauth_state(repeat('3',64),'f4000000-0000-4000-8000-0000000000a1') is not null
    then raise exception 'd_shared_state_still_usable'; end if;
  -- C. No session.
  perform public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('4',64));
  if public.consume_mercado_pago_oauth_state(repeat('4',64),null) is not null
    then raise exception 'c_completed_without_session'; end if;
  perform public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('5',64));
end $$;
reset role;
-- E. Expired.
update private.mercado_pago_oauth_states set expires_at=now()-interval '1 second' where state_hash=repeat('5',64);
set local role service_role;
do $$ begin
  if public.consume_mercado_pago_oauth_state(repeat('5',64),'f4000000-0000-4000-8000-0000000000a1') is not null
    then raise exception 'e_expired_state_accepted'; end if;
  perform public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('6',64));
end $$;
reset role;
-- G. The person stopped being owner between start and completion.
update public.workspace_members set role='admin' where user_id='f4000000-0000-4000-8000-0000000000a1';
set local role service_role;
do $$ begin
  if public.consume_mercado_pago_oauth_state(repeat('6',64),'f4000000-0000-4000-8000-0000000000a1') is not null
    then raise exception 'g_former_owner_completed'; end if;
end $$;
reset role;
update public.workspace_members set role='owner' where user_id='f4000000-0000-4000-8000-0000000000a1';
set local role service_role;
do $$ begin perform public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('7',64)); end $$;
reset role;
-- H. A state pointing at a workspace the person does not own.
update private.mercado_pago_oauth_states set workspace_id='f4000000-0000-4000-8000-00000000000b' where state_hash=repeat('7',64);
set local role service_role;
do $$
declare v_secrets integer;
begin
  if public.consume_mercado_pago_oauth_state(repeat('7',64),'f4000000-0000-4000-8000-0000000000a1') is not null
    then raise exception 'h_completed_for_another_workspace'; end if;

  -- Tokens: only for the owner's own workspace, stored in Vault, renewed under a lease.
  begin
    perform public.store_mercado_pago_connection('f4000000-0000-4000-8000-00000000000b',
      'f4000000-0000-4000-8000-0000000000a1','12345','access-token-b','refresh-token-b',now()+interval '180 days','test');
    raise exception 'connected_another_workspace';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  perform public.store_mercado_pago_connection('f4000000-0000-4000-8000-00000000000a',
    'f4000000-0000-4000-8000-0000000000a1','99912345','access-token-a1','refresh-token-a1',now()+interval '180 days','test');
  perform public.store_mercado_pago_connection('f4000000-0000-4000-8000-00000000000b',
    'f4000000-0000-4000-8000-0000000000b1','77754321','access-token-b1',null,now()+interval '1 hour','production');
  if (select access_token || '/' || refresh_token from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000a'))
    <> 'access-token-a1/refresh-token-a1' then raise exception 'credentials_not_stored'; end if;
  -- The checkout's existing reader sees the same account.
  if (select access_token from public.mercado_pago_account('f4000000-0000-4000-8000-00000000000a'))
    <> 'access-token-a1' then raise exception 'checkout_reader_out_of_sync'; end if;
  if not public.claim_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a') then raise exception 'lease_not_granted'; end if;
  if public.claim_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a') then raise exception 'lease_granted_twice'; end if;
  if public.claim_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000b') then raise exception 'lease_without_refresh_token'; end if;
  perform public.rotate_mercado_pago_tokens('f4000000-0000-4000-8000-00000000000a','access-token-a2',null,now()+interval '180 days');
  if (select access_token || '/' || refresh_token from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000a'))
    <> 'access-token-a2/refresh-token-a1' then raise exception 'rotation_lost_refresh_token'; end if;
  if not public.claim_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a') then raise exception 'lease_not_released_by_rotation'; end if;
  perform public.fail_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a',false);
  if not public.claim_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a') then raise exception 'lease_not_released_by_failure'; end if;
  perform public.fail_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a',true);
  if exists(select 1 from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000a'))
    or exists(select 1 from public.mercado_pago_account('f4000000-0000-4000-8000-00000000000a'))
    then raise exception 'failed_connection_still_usable'; end if;
  -- Trigger: an account in error cannot be made the payment method.
  update public.workspaces set payment_provider='external_link' where id='f4000000-0000-4000-8000-00000000000a';
  begin
    update public.workspaces set payment_provider='mercado_pago_ar' where id='f4000000-0000-4000-8000-00000000000a';
    raise exception 'trigger_accepted_error_state';
  exception when others then if sqlerrm <> 'mercado_pago_not_connected' then raise; end if; end;
  if (select access_token from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000b'))
    <> 'access-token-b1' then raise exception 'other_workspace_affected'; end if;
  -- Reconnecting reuses the workspace's Vault entries instead of piling up new ones.
  perform public.store_mercado_pago_connection('f4000000-0000-4000-8000-00000000000a',
    'f4000000-0000-4000-8000-0000000000a1','99912345','access-token-a3','refresh-token-a3',now()+interval '180 days','test');
  if (select access_token || '/' || refresh_token from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000a'))
    <> 'access-token-a3/refresh-token-a3' then raise exception 'reconnect_failed'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from vault.secrets where description='Bellis Mercado Pago') <> 3 then raise exception 'vault_entries_leaked'; end if;
end $$;
update private.mercado_pago_accounts set token_expires_at=now()-interval '1 minute'
  where workspace_id='f4000000-0000-4000-8000-00000000000b';
-- Trigger: an expired account with nothing to renew it cannot be made the payment method either.
update public.workspaces set payment_provider='external_link' where id='f4000000-0000-4000-8000-00000000000b';
do $$ begin
  begin
    update public.workspaces set payment_provider='mercado_pago_ar' where id='f4000000-0000-4000-8000-00000000000b';
    raise exception 'trigger_accepted_expired_state';
  exception when others then if sqlerrm <> 'mercado_pago_not_connected' then raise; end if; end;
end $$;

-- What a signed-in person can see and do.
set local role authenticated;
select set_config('request.jwt.claim.sub','f4000000-0000-4000-8000-0000000000a1',true);
select set_config('request.jwt.claims','{"sub":"f4000000-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
-- The payment method: Mercado Pago only while the workspace's own account is connected.
update public.workspaces set payment_provider='external_link',external_payment_url='https://pagos.example/a'
  where id='f4000000-0000-4000-8000-00000000000a';
do $$ begin
  if (select payment_provider from public.workspaces where id='f4000000-0000-4000-8000-00000000000a') <> 'external_link'
    then raise exception 'owner_could_not_choose_link'; end if;
  update public.workspaces set payment_provider='mercado_pago_ar' where id='f4000000-0000-4000-8000-00000000000a';
  if (select payment_provider from public.workspaces where id='f4000000-0000-4000-8000-00000000000a') <> 'mercado_pago_ar'
    then raise exception 'connected_owner_could_not_choose_mercado_pago'; end if;
  -- Another workspace's method is out of reach.
  update public.workspaces set external_payment_url='https://intruso.example/b' where id='f4000000-0000-4000-8000-00000000000b';
end $$;
do $$
declare v_status record; v_name text;
begin
  select * into v_status from public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000a');
  if not v_status.connected or v_status.status <> 'connected' or v_status.account_hint <> '••••2345'
    or v_status.environment <> 'test' then raise exception 'status_wrong'; end if;
  if to_jsonb(v_status)::text like '%token-a%' then raise exception 'status_leaks_token'; end if;
  begin
    perform public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000b');
    raise exception 'read_another_workspace_status';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin
    perform public.disconnect_mercado_pago('f4000000-0000-4000-8000-00000000000b');
    raise exception 'disconnected_another_workspace';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  -- Nothing that touches a token or a state is reachable with a session.
  foreach v_name in array array[
    $q$select * from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000a')$q$,
    $q$select * from public.mercado_pago_account('f4000000-0000-4000-8000-00000000000a')$q$,
    $q$select public.start_mercado_pago_oauth('f4000000-0000-4000-8000-0000000000a1',repeat('8',64))$q$,
    $q$select public.consume_mercado_pago_oauth_state(repeat('8',64),'f4000000-0000-4000-8000-0000000000a1')$q$,
    $q$select public.store_mercado_pago_connection('f4000000-0000-4000-8000-00000000000a','f4000000-0000-4000-8000-0000000000a1','1','access-token-x',null,null,'test')$q$,
    $q$select public.rotate_mercado_pago_tokens('f4000000-0000-4000-8000-00000000000a','access-token-x',null,null)$q$,
    $q$select public.claim_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a')$q$,
    $q$select public.fail_mercado_pago_refresh('f4000000-0000-4000-8000-00000000000a',true)$q$,
    $q$select private.put_mercado_pago_secret(null,'access-token-x')$q$,
    $q$select * from private.mercado_pago_accounts$q$,
    $q$select * from private.mercado_pago_oauth_states$q$,
    $q$select * from vault.decrypted_secrets$q$] loop
    begin
      execute v_name;
      raise exception 'reachable_with_session: %', v_name;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','f4000000-0000-4000-8000-0000000000a2',true);
select set_config('request.jwt.claims','{"sub":"f4000000-0000-4000-8000-0000000000a2","role":"authenticated"}',true);
do $$ begin
  if not (select connected from public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000a'))
    then raise exception 'admin_cannot_read_status'; end if;
  begin
    perform public.disconnect_mercado_pago('f4000000-0000-4000-8000-00000000000a');
    raise exception 'admin_disconnected';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','f4000000-0000-4000-8000-0000000000b1',true);
select set_config('request.jwt.claims','{"sub":"f4000000-0000-4000-8000-0000000000b1","role":"authenticated"}',true);
do $$ begin
  -- Past its expiry with no refresh token: reported as expired, not connected.
  if (select status from public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000b')) <> 'expired'
    or (select connected from public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000b'))
    then raise exception 'expired_not_reported'; end if;
end $$;
select set_config('request.jwt.claim.sub','f4000000-0000-4000-8000-0000000000a1',true);
select set_config('request.jwt.claims','{"sub":"f4000000-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
do $$ begin
  -- Disconnecting while Mercado Pago is the method: the workspace goes back to its saved link.
  perform public.disconnect_mercado_pago('f4000000-0000-4000-8000-00000000000a');
  if (select payment_provider || ' ' || coalesce(external_payment_url,'none') from public.workspaces
    where id='f4000000-0000-4000-8000-00000000000a') <> 'external_link https://pagos.example/a'
    then raise exception 'disconnect_did_not_fall_back_to_link'; end if;
  -- Once disconnected, Mercado Pago cannot be chosen again, whatever the client sends.
  begin
    update public.workspaces set payment_provider='mercado_pago_ar' where id='f4000000-0000-4000-8000-00000000000a';
    raise exception 'mercado_pago_chosen_without_connection';
  exception when others then if sqlerrm <> 'mercado_pago_not_connected' then raise; end if; end;
  if (select status from public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000a')) <> 'disconnected'
    or (select account_hint from public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000a')) is not null
    then raise exception 'disconnect_not_reported'; end if;
end $$;
-- The same without a saved link: no usable method is left, and it is not Mercado Pago.
set local role service_role;
do $$ begin
  perform public.store_mercado_pago_connection('f4000000-0000-4000-8000-00000000000a',
    'f4000000-0000-4000-8000-0000000000a1','99912345','access-token-a4','refresh-token-a4',now()+interval '180 days','test');
end $$;
set local role authenticated;
do $$ begin
  update public.workspaces set payment_provider='mercado_pago_ar',external_payment_url=null
    where id='f4000000-0000-4000-8000-00000000000a';
  if (select payment_provider from public.workspaces where id='f4000000-0000-4000-8000-00000000000a') <> 'mercado_pago_ar'
    then raise exception 'reconnected_owner_could_not_choose_mercado_pago'; end if;
  perform public.disconnect_mercado_pago('f4000000-0000-4000-8000-00000000000a');
  if (select payment_provider || ' ' || coalesce(external_payment_url,'none') from public.workspaces
    where id='f4000000-0000-4000-8000-00000000000a') <> 'external_link none'
    then raise exception 'disconnect_left_mercado_pago_without_account'; end if;
end $$;
set local role anon;
do $$ begin
  begin
    perform public.mercado_pago_connection_status('f4000000-0000-4000-8000-00000000000a');
    raise exception 'anonymous_read_status';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  -- Disconnecting removed A's tokens from Vault and left B's alone.
  if (select count(*) from vault.secrets where description='Bellis Mercado Pago') <> 1 then raise exception 'tokens_not_deleted'; end if;
  if exists(select 1 from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000a'))
    or not exists(select 1 from public.mercado_pago_credentials('f4000000-0000-4000-8000-00000000000b'))
    then raise exception 'disconnect_crossed_workspaces'; end if;
  if (select external_payment_url from public.workspaces where id='f4000000-0000-4000-8000-00000000000b') is not null
    then raise exception 'changed_another_workspace_method'; end if;
  if (select count(*) from public.audit_events where workspace_id='f4000000-0000-4000-8000-00000000000a'
    and action like 'mercado_pago_%') <> 6 then raise exception 'audit_trail_incomplete'; end if;
end $$;
rollback;
