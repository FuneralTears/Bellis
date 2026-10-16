-- Run only on the development project or a local database. Synthetic records are rolled back.
-- H3.1A.1 sign-in with Google: the email sign-up still creates its account through the trigger, and a Google account
-- (no sign-up form in its metadata) completes it once, through complete_bellis_account, only with a confirmed email.
begin;
-- e1: signs up with the email form. g1: signs up with Google (confirmed email, no form). g2: an unconfirmed email.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
  ('00000000-0000-0000-0000-000000000000','c4000000-0000-4000-8000-0000000000e1','authenticated','authenticated','gl-email@example.invalid','',now(),
   '{"provider":"email","providers":["email"]}','{"bellis_signup":"1","name":"Ana Email","business":"Consultorio Email","specialty":"Psicología","province":"Córdoba","city":"Córdoba","timezone":"America/Argentina/Buenos_Aires"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','c4000000-0000-4000-8000-0000000000a1','authenticated','authenticated','gl-google@example.invalid','',now(),
   '{"provider":"google","providers":["google"]}','{"full_name":"Gina Google","email_verified":true}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','c4000000-0000-4000-8000-0000000000b2','authenticated','authenticated','gl-unverified@example.invalid','',null,
   '{"provider":"google","providers":["google"]}','{"full_name":"Uma Unverified"}',now(),now());

create function pg_temp.owned(p_user uuid) returns text language sql security definer as $$
  select (select count(*) from public.workspace_members m where m.user_id=p_user)::text || '/' ||
    (select count(*) from public.professionals p where p.user_id=p_user)::text || '/' ||
    (select count(*) from public.workspaces w join public.workspace_members m on m.workspace_id=w.id where m.user_id=p_user and m.role='owner')::text $$;

do $$ begin
  -- The email sign-up: one workspace, one owner membership, one professional profile, from the form, as before.
  if pg_temp.owned('c4000000-0000-4000-8000-0000000000e1') <> '1/1/1' then raise exception 'email_signup_changed: %', pg_temp.owned('c4000000-0000-4000-8000-0000000000e1'); end if;
  if (select w.name || '|' || w.timezone || '|' || p.specialty || '|' || p.city from public.professionals p join public.workspaces w on w.id=p.workspace_id
    where p.user_id='c4000000-0000-4000-8000-0000000000e1') <> 'Consultorio Email|America/Argentina/Buenos_Aires|Psicología|Córdoba' then raise exception 'email_signup_data_changed'; end if;
  -- A Google sign-up carries no form: nothing is created for it by the trigger.
  if pg_temp.owned('c4000000-0000-4000-8000-0000000000a1') <> '0/0/0' or pg_temp.owned('c4000000-0000-4000-8000-0000000000b2') <> '0/0/0'
    then raise exception 'google_signup_created_something'; end if;
  -- The trigger still refuses a broken form, as before.
  begin
    insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_user_meta_data,created_at,updated_at)
    values('00000000-0000-0000-0000-000000000000','c4000000-0000-4000-8000-0000000000e9','authenticated','authenticated','gl-bad@example.invalid','','{"bellis_signup":"1","name":"A","business":"x"}',now(),now());
    raise exception 'broken_form_accepted';
  exception when others then if sqlerrm <> 'business_required' then raise; end if; end;
end $$;

-- g1 completes its account: once, whatever happens.
set local role authenticated;
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-0000000000a1',true);
select set_config('request.jwt.claims','{"sub":"c4000000-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
do $$
declare v_doc jsonb := '{"name":"Gina Google","business":"Consultorio Gina","specialty":"Nutrición","province":"Mendoza","city":"Godoy Cruz","timezone":"America/Argentina/Buenos_Aires"}';
  v_first uuid; v_second uuid;
begin
  begin perform public.complete_bellis_account('"not an object"'::jsonb); raise exception 'non_object_accepted';
  exception when others then if sqlerrm <> 'invalid_account' then raise; end if; end;
  begin perform public.complete_bellis_account(null); raise exception 'null_accepted';
  exception when others then if sqlerrm <> 'invalid_account' then raise; end if; end;
  begin perform public.complete_bellis_account(v_doc || '{"business":"x"}'); raise exception 'short_business_accepted';
  exception when others then if sqlerrm <> 'business_required' then raise; end if; end;
  begin perform public.complete_bellis_account(v_doc || '{"timezone":"Mars/Base"}'); raise exception 'bad_timezone_accepted';
  exception when others then if sqlerrm <> 'invalid_timezone' then raise; end if; end;
  v_first := public.complete_bellis_account(v_doc);
  -- A second submit, a refresh, another tab: the same workspace, nothing new.
  v_second := public.complete_bellis_account(v_doc || '{"business":"Otro nombre"}');
  if v_first is null or v_first <> v_second then raise exception 'not_idempotent'; end if;
  -- Only its own: a workspace or user id in the document is ignored.
  if public.complete_bellis_account(v_doc || '{"user_id":"c4000000-0000-4000-8000-0000000000e1","workspace_id":"c4000000-0000-4000-8000-000000000000"}') <> v_first
    then raise exception 'document_chose_the_account'; end if;
  -- Nothing that creates accounts directly is reachable with a session.
  begin perform private.create_bellis_account('c4000000-0000-4000-8000-0000000000a1','x@example.invalid',v_doc); raise exception 'private_reachable';
  exception when insufficient_privilege then null; end;
end $$;
-- The email account calling it gets its own workspace back, nothing more.
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-0000000000e1',true);
select set_config('request.jwt.claims','{"sub":"c4000000-0000-4000-8000-0000000000e1","role":"authenticated"}',true);
do $$ begin
  if public.complete_bellis_account('{"name":"Ana Email","business":"Otro Consultorio","specialty":"Psicología","province":"Córdoba","city":"Córdoba","timezone":"America/Argentina/Buenos_Aires"}')
    is distinct from (select m.workspace_id from public.workspace_members m where m.user_id='c4000000-0000-4000-8000-0000000000e1')
    then raise exception 'existing_account_not_returned'; end if;
end $$;
-- An email Google did not verify gets no Bellis account.
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-0000000000b2',true);
select set_config('request.jwt.claims','{"sub":"c4000000-0000-4000-8000-0000000000b2","role":"authenticated"}',true);
do $$ begin
  perform public.complete_bellis_account('{"name":"Uma","business":"Consultorio Uma","specialty":"Otro","province":"Salta","city":"Salta","timezone":"America/Argentina/Buenos_Aires"}');
  raise exception 'unverified_email_got_an_account';
exception when others then if sqlerrm <> 'email_not_verified' then raise; end if;
end $$;
set local role anon;
do $$ begin
  begin perform public.complete_bellis_account('{}'); raise exception 'anonymous_created_account';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ begin
  if pg_temp.owned('c4000000-0000-4000-8000-0000000000a1') <> '1/1/1' then raise exception 'google_account_not_exactly_one: %', pg_temp.owned('c4000000-0000-4000-8000-0000000000a1'); end if;
  if pg_temp.owned('c4000000-0000-4000-8000-0000000000e1') <> '1/1/1' then raise exception 'email_account_duplicated'; end if;
  if pg_temp.owned('c4000000-0000-4000-8000-0000000000b2') <> '0/0/0' then raise exception 'unverified_account_created'; end if;
  -- The Google account looks like any other: the form's data, a professional profile, onboarding still ahead.
  if (select w.name || '|' || p.specialty || '|' || p.province || '|' || coalesce(w.onboarding_completed_at::text,'pending') from public.professionals p
    join public.workspaces w on w.id=p.workspace_id where p.user_id='c4000000-0000-4000-8000-0000000000a1') <> 'Consultorio Gina|Nutrición|Mendoza|pending'
    then raise exception 'google_account_data_wrong'; end if;
  -- Registered once, like an email sign-up.
  if (select count(*) from public.product_events e where e.event_name='user_registered' and e.user_id='c4000000-0000-4000-8000-0000000000a1') <> 1
    then raise exception 'registration_event_not_once'; end if;
  -- Created under a per-person lock.
  if position('pg_advisory_xact_lock' in pg_get_functiondef('public.complete_bellis_account(jsonb)'::regprocedure)) = 0 then raise exception 'no_lock'; end if;
end $$;
rollback;
