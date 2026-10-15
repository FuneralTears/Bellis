-- Run only on the development project or a local database. Synthetic records are rolled back.
-- Google Calendar H3.1A: the rollout flag, the capability, the OAuth state, the connection in Vault, renewal,
-- disconnection and what a session can see. Nothing here talks to Google.
begin;
-- Google Calendar secrets that existed before this smoke (real connections): counted apart, never read or touched.
create temp table gc_baseline as select count(*) n from vault.secrets where description='Bellis Google Calendar';
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',id::uuid,'authenticated','authenticated',email,'',now(),'{}','{}',now(),now()
from (values ('c3000000-0000-4000-8000-0000000000a1','gc-pro@example.invalid'),
  ('c3000000-0000-4000-8000-0000000000b1','gc-free@example.invalid'),
  ('c3000000-0000-4000-8000-0000000000c1','gc-nobeta@example.invalid'),
  ('c3000000-0000-4000-8000-0000000000a4','gc-admin@example.invalid'),
  ('c3000000-0000-4000-8000-0000000000d1','gc-trial@example.invalid')) u(id,email);
-- The sign-up trigger may already have created workspaces for these users: keep only the ones under test.
delete from public.workspace_members where user_id in ('c3000000-0000-4000-8000-0000000000a1','c3000000-0000-4000-8000-0000000000b1',
  'c3000000-0000-4000-8000-0000000000c1','c3000000-0000-4000-8000-0000000000a4','c3000000-0000-4000-8000-0000000000d1');
insert into public.workspaces(id,name,slug) values
  ('c3000000-0000-4000-8000-00000000000a','GC Pro','gc-smoke-pro'),
  ('c3000000-0000-4000-8000-00000000000b','GC Free','gc-smoke-free'),
  ('c3000000-0000-4000-8000-00000000000c','GC Pro sin beta','gc-smoke-nobeta'),
  ('c3000000-0000-4000-8000-00000000000d','GC Prueba','gc-smoke-trial');
update public.workspaces set plan_code='pro',pro_started_at='2020-01-01'
  where id in ('c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-00000000000c');
select private.start_workspace_trial('c3000000-0000-4000-8000-00000000000d');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000a1','owner'),
  ('c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000a4','admin'),
  ('c3000000-0000-4000-8000-00000000000b','c3000000-0000-4000-8000-0000000000b1','owner'),
  ('c3000000-0000-4000-8000-00000000000c','c3000000-0000-4000-8000-0000000000c1','owner'),
  ('c3000000-0000-4000-8000-00000000000d','c3000000-0000-4000-8000-0000000000d1','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug) values
  ('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000a1','GC Pro','Psicología','gc-smoke-a'),
  ('c3000000-0000-4000-8000-0000000000bb','c3000000-0000-4000-8000-00000000000b','c3000000-0000-4000-8000-0000000000b1','GC Free','Psicología','gc-smoke-b'),
  ('c3000000-0000-4000-8000-0000000000cc','c3000000-0000-4000-8000-00000000000c','c3000000-0000-4000-8000-0000000000c1','GC Sin beta','Psicología','gc-smoke-c'),
  ('c3000000-0000-4000-8000-0000000000dd','c3000000-0000-4000-8000-00000000000d','c3000000-0000-4000-8000-0000000000d1','GC Prueba','Psicología','gc-smoke-d');
-- The rollout: the Pro workspace, the Free one and the trial. Not the "Pro sin beta" one.
insert into private.workspace_features(workspace_id,feature,enabled_by) values
  ('c3000000-0000-4000-8000-00000000000a','google_calendar_beta','smoke'),
  ('c3000000-0000-4000-8000-00000000000b','google_calendar_beta','smoke'),
  ('c3000000-0000-4000-8000-00000000000d','google_calendar_beta','smoke');

-- Capability = entitlement; feature = rollout. Each answers only its own question.
do $$ begin
  if not private.workspace_has_capability('c3000000-0000-4000-8000-00000000000a','google_calendar_sync')
    or private.workspace_has_capability('c3000000-0000-4000-8000-00000000000b','google_calendar_sync')
    or not private.workspace_has_capability('c3000000-0000-4000-8000-00000000000d','google_calendar_sync')
    or 'google_calendar_sync' = any(private.plan_capabilities('free')) then raise exception 'capability_wrong'; end if;
  if not private.workspace_has_feature('c3000000-0000-4000-8000-00000000000b','google_calendar_beta')
    or private.workspace_has_feature('c3000000-0000-4000-8000-00000000000c','google_calendar_beta')
    or private.workspace_has_feature(null,'google_calendar_beta') then raise exception 'feature_wrong'; end if;
  if not private.google_calendar_available('c3000000-0000-4000-8000-00000000000a')
    or private.google_calendar_available('c3000000-0000-4000-8000-00000000000b')
    or private.google_calendar_available('c3000000-0000-4000-8000-00000000000c') then raise exception 'available_is_not_both'; end if;
  begin perform private.workspace_has_feature('c3000000-0000-4000-8000-00000000000a','Bad Name'); raise exception 'malformed_feature_accepted';
  exception when others then if sqlerrm <> 'invalid_feature' then raise; end if; end;
  begin perform private.workspace_has_feature('c3000000-0000-4000-8000-00000000000a',null); raise exception 'null_feature_accepted';
  exception when others then if sqlerrm <> 'invalid_feature' then raise; end if; end;
  begin insert into private.workspace_features(workspace_id,feature) values('c3000000-0000-4000-8000-00000000000c','x'); raise exception 'short_feature_stored';
  exception when check_violation then null; end;
end $$;

-- State: own professional profile only, plan AND rollout, latest attempt only, single use, short lived, bound to the person.
set local role service_role;
do $$
declare v record;
begin
  begin perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a4',repeat('1',64),repeat('v',43)); raise exception 'started_without_professional';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000b1',repeat('1',64),repeat('v',43)); raise exception 'free_started';
  exception when others then if sqlerrm <> 'pro_access_required' then raise; end if; end;
  begin perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000c1',repeat('1',64),repeat('v',43)); raise exception 'started_outside_rollout';
  exception when others then if sqlerrm <> 'feature_not_enabled' then raise; end if; end;
  begin perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('1',64),'short'); raise exception 'weak_verifier_accepted';
  exception when others then if sqlerrm <> 'invalid_oauth_state' then raise; end if; end;
  begin perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1','not-a-hash',repeat('v',43)); raise exception 'bad_state_accepted';
  exception when others then if sqlerrm <> 'invalid_oauth_state' then raise; end if; end;
  select * into v from public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000d1',repeat('d',64),repeat('v',43));
  if v.professional_id <> 'c3000000-0000-4000-8000-0000000000dd' then raise exception 'trial_could_not_start'; end if;
  select * into v from public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('1',64),repeat('v',43));
  if v.workspace_id <> 'c3000000-0000-4000-8000-00000000000a' or v.professional_id <> 'c3000000-0000-4000-8000-0000000000aa'
    or v.has_refresh_token then raise exception 'state_bound_wrong: %', to_jsonb(v); end if;
  -- A new attempt replaces the previous one.
  perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('2',64),repeat('w',43));
  if exists(select 1 from public.consume_google_calendar_oauth_state(repeat('1',64),'c3000000-0000-4000-8000-0000000000a1'))
    then raise exception 'superseded_state_accepted'; end if;
  -- Another signed-in person presents it: refused, and burned even for its owner.
  if exists(select 1 from public.consume_google_calendar_oauth_state(repeat('2',64),'c3000000-0000-4000-8000-0000000000b1'))
    then raise exception 'other_user_completed'; end if;
  if exists(select 1 from public.consume_google_calendar_oauth_state(repeat('2',64),'c3000000-0000-4000-8000-0000000000a1'))
    then raise exception 'shared_state_still_usable'; end if;
  perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('3',64),repeat('x',64));
  if exists(select 1 from public.consume_google_calendar_oauth_state(repeat('3',64),null)) then raise exception 'completed_without_session'; end if;
  perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('4',64),repeat('x',64));
  select * into v from public.consume_google_calendar_oauth_state(repeat('4',64),'c3000000-0000-4000-8000-0000000000a1');
  if v.professional_id is distinct from 'c3000000-0000-4000-8000-0000000000aa' or v.code_verifier is distinct from repeat('x',64)
    then raise exception 'initiator_rejected'; end if;
  if exists(select 1 from public.consume_google_calendar_oauth_state(repeat('4',64),'c3000000-0000-4000-8000-0000000000a1'))
    then raise exception 'state_used_twice'; end if;
  perform public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('5',64),repeat('x',64));
end $$;
reset role;
do $$ begin
  -- Only hashes are stored, and a used state keeps no verifier.
  if exists(select 1 from private.google_calendar_oauth_states where consumed_at is not null and code_verifier is not null)
    then raise exception 'verifier_kept_after_use'; end if;
  if (select expires_at from private.google_calendar_oauth_states where state_hash=repeat('5',64)) > now()+interval '10 minutes'
    then raise exception 'state_lives_too_long'; end if;
end $$;
update private.google_calendar_oauth_states set expires_at=now()-interval '1 second' where state_hash=repeat('5',64);

-- The connection: own profile only, both calendar scopes, tokens in Vault, renewal under a lease.
set local role service_role;
do $$
declare v_scopes text[] := array['openid','email','https://www.googleapis.com/auth/calendar.app.created','https://www.googleapis.com/auth/calendar.freebusy'];
  v record;
begin
  if exists(select 1 from public.consume_google_calendar_oauth_state(repeat('5',64),'c3000000-0000-4000-8000-0000000000a1'))
    then raise exception 'expired_state_accepted'; end if;
  if exists(select 1 from public.google_calendar_previous_connection('c3000000-0000-4000-8000-0000000000aa')) then raise exception 'phantom_previous'; end if;
  begin
    perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','sub-1',
      'qa@example.test','access-token-1','refresh-token-1',now()+interval '1 hour',array['openid','https://www.googleapis.com/auth/calendar.app.created'],'cal-1@group.calendar.google.com',null);
    raise exception 'stored_without_freebusy';
  exception when others then if sqlerrm <> 'google_scopes_missing' then raise; end if; end;
  begin
    perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','sub-1',
      'qa@example.test','access-token-1',null,now()+interval '1 hour',v_scopes,'cal-1@group.calendar.google.com',null);
    raise exception 'stored_without_refresh_token';
  exception when others then if sqlerrm <> 'google_refresh_token_missing' then raise; end if; end;
  begin
    perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000b1','sub-1',
      'qa@example.test','access-token-1','refresh-token-1',now()+interval '1 hour',v_scopes,'cal-1@group.calendar.google.com',null);
    raise exception 'stored_for_someone_else';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  begin
    perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','sub 1',
      'qa@example.test','access-token-1','refresh-token-1',now()+interval '1 hour',v_scopes,'cal-1@group.calendar.google.com',null);
    raise exception 'bad_subject_stored';
  exception when others then if sqlerrm <> 'invalid_google_calendar_connection' then raise; end if; end;
  perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','sub-1',
    'qa@example.test','access-token-1','refresh-token-1',now()+interval '1 hour',v_scopes,'cal-1@group.calendar.google.com','America/Argentina/Buenos_Aires');
  select * into v from public.google_calendar_credentials('c3000000-0000-4000-8000-0000000000aa');
  if v.access_token <> 'access-token-1' or v.refresh_token <> 'refresh-token-1' or v.calendar_id <> 'cal-1@group.calendar.google.com'
    or v.status <> 'connected' or v.google_subject <> 'sub-1' then raise exception 'credentials_not_stored'; end if;
  if not (select has_refresh_token from public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('6',64),repeat('x',64)))
    then raise exception 'consent_asked_again_needlessly'; end if;
  -- Same Google account, Google sent no new refresh token: the stored one stays.
  perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','sub-1',
    'qa@example.test','access-token-2',null,now()+interval '1 hour',v_scopes,'cal-1@group.calendar.google.com','America/Argentina/Buenos_Aires');
  if (select access_token || '/' || refresh_token from public.google_calendar_credentials('c3000000-0000-4000-8000-0000000000aa'))
    <> 'access-token-2/refresh-token-1' then raise exception 'reconnect_lost_refresh_token'; end if;
  -- Another Google account must bring its own.
  begin
    perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','sub-2',
      'otra@example.test','access-token-x',null,now()+interval '1 hour',v_scopes,'cal-2@group.calendar.google.com',null);
    raise exception 'other_account_used_old_refresh_token';
  exception when others then if sqlerrm <> 'google_refresh_token_missing' then raise; end if; end;
  -- Renewal.
  if not public.claim_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa') then raise exception 'lease_not_granted'; end if;
  if public.claim_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa') then raise exception 'lease_granted_twice'; end if;
  perform public.rotate_google_calendar_tokens('c3000000-0000-4000-8000-0000000000aa','access-token-3',null,now()+interval '1 hour');
  if (select access_token || '/' || refresh_token from public.google_calendar_credentials('c3000000-0000-4000-8000-0000000000aa'))
    <> 'access-token-3/refresh-token-1' then raise exception 'rotation_lost_refresh_token'; end if;
  if not public.claim_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa') then raise exception 'lease_not_released_by_rotation'; end if;
  perform public.fail_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa',false,'google_oauth_http_503');
  if (select status from public.google_calendar_credentials('c3000000-0000-4000-8000-0000000000aa')) <> 'connected'
    then raise exception 'transient_failure_disconnected'; end if;
  if not public.claim_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa') then raise exception 'lease_not_released_by_failure'; end if;
  perform public.fail_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa',true,'google_invalid_grant');
  if exists(select 1 from public.google_calendar_credentials('c3000000-0000-4000-8000-0000000000aa'))
    or public.claim_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa') then raise exception 'rejected_grant_still_usable'; end if;
  select * into v from public.google_calendar_previous_connection('c3000000-0000-4000-8000-0000000000aa');
  if v.status <> 'needs_reconnect' or v.has_refresh_token or v.google_subject <> 'sub-1' or v.calendar_id <> 'cal-1@group.calendar.google.com'
    then raise exception 'needs_reconnect_wrong: %', to_jsonb(v); end if;
  if (select has_refresh_token from public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('7',64),repeat('x',64)))
    then raise exception 'consent_not_asked_after_rejection'; end if;
  -- Reconnecting reuses the profile's Vault entries.
  perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','sub-1',
    'qa@example.test','access-token-4','refresh-token-4',now()+interval '1 hour',v_scopes,'cal-1@group.calendar.google.com','America/Argentina/Buenos_Aires');
  perform public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000dd','c3000000-0000-4000-8000-0000000000d1','sub-d',
    null,'access-token-d','refresh-token-d',now()+interval '1 hour',v_scopes,'cal-d@group.calendar.google.com',null);
end $$;
reset role;
do $$ begin
  if (select count(*) from vault.secrets where description='Bellis Google Calendar') <> (select n from gc_baseline)+4 then raise exception 'vault_entries_leaked'; end if;
  if (select last_error_code from private.google_calendar_accounts where professional_id='c3000000-0000-4000-8000-0000000000aa') is not null
    or (select last_refresh_at from private.google_calendar_accounts where professional_id='c3000000-0000-4000-8000-0000000000aa') is null
    then raise exception 'refresh_bookkeeping_wrong'; end if;
end $$;

-- What a signed-in person can see and do.
set local role authenticated;
select set_config('request.jwt.claim.sub','c3000000-0000-4000-8000-0000000000a1',true);
select set_config('request.jwt.claims','{"sub":"c3000000-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
do $$
declare v record; v_name text;
begin
  select * into v from public.google_calendar_status('c3000000-0000-4000-8000-00000000000a');
  if not v.available or v.unavailable_reason is not null or not v.connected or v.status <> 'connected' or v.email <> 'qa@example.test'
    or v.calendar_label <> 'Turnos Bellis' or v.connected_at is null or v.last_refresh_at is null then raise exception 'status_wrong: %', to_jsonb(v); end if;
  if to_jsonb(v)::text ~ '(token|cal-1|sub-1|group\.calendar)' then raise exception 'status_leaks: %', to_jsonb(v); end if;
  if (select array_agg(key order by key) from jsonb_object_keys(to_jsonb(v)) key) <> array['available','calendar_label','connected','connected_at',
    'email','last_error_code','last_refresh_at','status','unavailable_reason'] then raise exception 'status_columns_changed'; end if;
  begin perform public.google_calendar_status('c3000000-0000-4000-8000-00000000000b'); raise exception 'read_another_workspace';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  -- Nothing that touches a flag, a token or a state is reachable with a session.
  foreach v_name in array array[
    $q$select * from private.workspace_features$q$,
    $q$insert into private.workspace_features(workspace_id,feature) values('c3000000-0000-4000-8000-00000000000c','google_calendar_beta')$q$,
    $q$delete from private.workspace_features$q$,
    $q$select private.workspace_has_feature('c3000000-0000-4000-8000-00000000000a','google_calendar_beta')$q$,
    $q$select private.google_calendar_available('c3000000-0000-4000-8000-00000000000a')$q$,
    $q$select * from private.google_calendar_accounts$q$,
    $q$select * from private.google_calendar_oauth_states$q$,
    $q$select * from public.google_calendar_credentials('c3000000-0000-4000-8000-0000000000aa')$q$,
    $q$select * from public.start_google_calendar_oauth('c3000000-0000-4000-8000-0000000000a1',repeat('8',64),repeat('x',64))$q$,
    $q$select * from public.consume_google_calendar_oauth_state(repeat('7',64),'c3000000-0000-4000-8000-0000000000a1')$q$,
    $q$select * from public.google_calendar_previous_connection('c3000000-0000-4000-8000-0000000000aa')$q$,
    $q$select public.google_calendar_professional_id('c3000000-0000-4000-8000-0000000000a1')$q$,
    $q$select public.store_google_calendar_connection('c3000000-0000-4000-8000-0000000000aa','c3000000-0000-4000-8000-0000000000a1','s','a@b.c','access-token-x','refresh-token-x',now()+interval '1 hour',array[]::text[],'c',null)$q$,
    $q$select public.rotate_google_calendar_tokens('c3000000-0000-4000-8000-0000000000aa','access-token-x',null,now()+interval '1 hour')$q$,
    $q$select public.claim_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa')$q$,
    $q$select public.fail_google_calendar_refresh('c3000000-0000-4000-8000-0000000000aa',true,'x')$q$,
    $q$select public.disconnect_google_calendar('c3000000-0000-4000-8000-0000000000a1',true)$q$,
    $q$select private.put_google_calendar_secret(null,'access-token-x')$q$,
    $q$select * from vault.decrypted_secrets$q$] loop
    begin
      execute v_name;
      raise exception 'reachable_with_session: %', v_name;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
-- The panel's wording when it is not available, from the server's answer only.
select set_config('request.jwt.claim.sub','c3000000-0000-4000-8000-0000000000a4',true);
select set_config('request.jwt.claims','{"sub":"c3000000-0000-4000-8000-0000000000a4","role":"authenticated"}',true);
do $$ declare v record; begin
  select * into v from public.google_calendar_status('c3000000-0000-4000-8000-00000000000a');
  if v.available or v.unavailable_reason <> 'no_professional' or v.status <> 'disconnected' or v.email is not null then raise exception 'admin_status_wrong: %', to_jsonb(v); end if;
end $$;
select set_config('request.jwt.claim.sub','c3000000-0000-4000-8000-0000000000b1',true);
select set_config('request.jwt.claims','{"sub":"c3000000-0000-4000-8000-0000000000b1","role":"authenticated"}',true);
do $$ declare v record; begin
  select * into v from public.google_calendar_status('c3000000-0000-4000-8000-00000000000b');
  if v.available or v.unavailable_reason <> 'plan_required' or v.connected then raise exception 'free_status_wrong: %', to_jsonb(v); end if;
end $$;
select set_config('request.jwt.claim.sub','c3000000-0000-4000-8000-0000000000c1',true);
select set_config('request.jwt.claims','{"sub":"c3000000-0000-4000-8000-0000000000c1","role":"authenticated"}',true);
do $$ declare v record; begin
  select * into v from public.google_calendar_status('c3000000-0000-4000-8000-00000000000c');
  if v.available or v.unavailable_reason <> 'not_enabled' or v.connected then raise exception 'nobeta_status_wrong: %', to_jsonb(v); end if;
end $$;
reset role;

-- The rollout is taken back while A is connected: the connection reads as paused, and can still be disconnected.
delete from private.workspace_features where workspace_id='c3000000-0000-4000-8000-00000000000a';
set local role authenticated;
select set_config('request.jwt.claim.sub','c3000000-0000-4000-8000-0000000000a1',true);
select set_config('request.jwt.claims','{"sub":"c3000000-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
do $$ declare v record; begin
  select * into v from public.google_calendar_status('c3000000-0000-4000-8000-00000000000a');
  if v.available or v.unavailable_reason <> 'not_enabled' or v.connected or v.status <> 'paused' or v.email <> 'qa@example.test'
    then raise exception 'paused_wrong: %', to_jsonb(v); end if;
end $$;
reset role;
set local role service_role;
do $$
declare v_professional uuid;
begin
  begin perform public.disconnect_google_calendar('c3000000-0000-4000-8000-0000000000a4',true); raise exception 'disconnected_without_professional';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  -- Neither the plan nor the rollout is needed to disconnect.
  v_professional := public.disconnect_google_calendar('c3000000-0000-4000-8000-0000000000a1',true);
  if v_professional <> 'c3000000-0000-4000-8000-0000000000aa' then raise exception 'disconnected_wrong_profile'; end if;
  if exists(select 1 from public.google_calendar_credentials('c3000000-0000-4000-8000-0000000000aa')) then raise exception 'tokens_survived_disconnect'; end if;
  if public.disconnect_google_calendar('c3000000-0000-4000-8000-0000000000a1',true) <> 'c3000000-0000-4000-8000-0000000000aa' then raise exception 'second_disconnect_failed'; end if;
  -- Google could not be reached to revoke: Bellis forgets the tokens anyway and notes it.
  perform public.disconnect_google_calendar('c3000000-0000-4000-8000-0000000000d1',false);
end $$;
reset role;
do $$
declare a private.google_calendar_accounts%rowtype;
begin
  select * into a from private.google_calendar_accounts where professional_id='c3000000-0000-4000-8000-0000000000aa';
  if a.status <> 'disconnected' or a.google_subject <> 'sub-1' or a.calendar_id <> 'cal-1@group.calendar.google.com' or a.disconnected_at is null
    or a.access_token_secret_id is not null or a.refresh_token_secret_id is not null or a.last_error_code is not null then raise exception 'disconnect_wrong: %', to_jsonb(a); end if;
  if (select last_error_code from private.google_calendar_accounts where professional_id='c3000000-0000-4000-8000-0000000000dd') <> 'google_revoke_failed'
    then raise exception 'failed_revoke_not_noted'; end if;
  if exists(select 1 from private.google_calendar_oauth_states where professional_id='c3000000-0000-4000-8000-0000000000aa') then raise exception 'states_survived_disconnect'; end if;
  if (select count(*) from vault.secrets where description='Bellis Google Calendar') <> (select n from gc_baseline) then raise exception 'vault_entries_left'; end if;
  if (select string_agg(action,',' order by id) from public.audit_events where object_id='c3000000-0000-4000-8000-0000000000aa' and action like 'google_calendar_%')
    <> 'google_calendar_connected,google_calendar_connected,google_calendar_needs_reconnect,google_calendar_connected,google_calendar_disconnected'
    then raise exception 'audit_trail_wrong'; end if;
end $$;
set local role authenticated;
do $$ declare v record; begin
  select * into v from public.google_calendar_status('c3000000-0000-4000-8000-00000000000a');
  if v.status <> 'disconnected' or v.email is not null or v.calendar_label is not null or v.connected_at is not null then raise exception 'disconnected_status_leaks'; end if;
end $$;
set local role anon;
do $$ begin
  begin perform public.google_calendar_status('c3000000-0000-4000-8000-00000000000a'); raise exception 'anonymous_read_status';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
