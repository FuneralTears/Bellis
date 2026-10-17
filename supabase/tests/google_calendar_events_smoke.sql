-- H3.1B database contract. Synthetic rows only; the transaction is rolled back and never calls Google.
begin;

insert into public.workspaces(id,name,slug) values
  ('e3100000-0000-4000-8000-00000000000a','Sync Pro','gc-sync-pro'),
  ('e3100000-0000-4000-8000-00000000000b','Sync Free','gc-sync-free'),
  ('e3100000-0000-4000-8000-00000000000c','Sync No Beta','gc-sync-no-beta'),
  ('e3100000-0000-4000-8000-00000000000d','Sync Trial','gc-sync-trial'),
  ('e3100000-0000-4000-8000-00000000000e','Sync Disconnected','gc-sync-disconnected');
update public.workspaces set plan_code='pro',pro_started_at='2020-01-01'
  where id in ('e3100000-0000-4000-8000-00000000000a','e3100000-0000-4000-8000-00000000000c','e3100000-0000-4000-8000-00000000000e');
select private.start_workspace_trial('e3100000-0000-4000-8000-00000000000d');

insert into public.professionals(id,workspace_id,display_name,specialty,public_slug) values
  ('e3100000-0000-4000-8000-0000000000aa','e3100000-0000-4000-8000-00000000000a','Sync Pro','Test','gc-sync-a'),
  ('e3100000-0000-4000-8000-0000000000bb','e3100000-0000-4000-8000-00000000000b','Sync Free','Test','gc-sync-b'),
  ('e3100000-0000-4000-8000-0000000000cc','e3100000-0000-4000-8000-00000000000c','Sync No Beta','Test','gc-sync-c'),
  ('e3100000-0000-4000-8000-0000000000dd','e3100000-0000-4000-8000-00000000000d','Sync Trial','Test','gc-sync-d'),
  ('e3100000-0000-4000-8000-0000000000ee','e3100000-0000-4000-8000-00000000000e','Sync Off','Test','gc-sync-e');
insert into private.workspace_features(workspace_id,feature,enabled_by) values
  ('e3100000-0000-4000-8000-00000000000a','google_calendar_beta','smoke'),
  ('e3100000-0000-4000-8000-00000000000b','google_calendar_beta','smoke'),
  ('e3100000-0000-4000-8000-00000000000d','google_calendar_beta','smoke'),
  ('e3100000-0000-4000-8000-00000000000e','google_calendar_beta','smoke');

-- Fake token references are enough here: this smoke tests the queue, never the credentials RPC or Google.
insert into private.google_calendar_accounts(professional_id,workspace_id,google_subject,access_token_secret_id,
  refresh_token_secret_id,token_expires_at,granted_scopes,status,calendar_id,calendar_timezone,connected_at) values
  ('e3100000-0000-4000-8000-0000000000aa','e3100000-0000-4000-8000-00000000000a','sync-a',gen_random_uuid(),gen_random_uuid(),now()+interval '1 hour','{}','connected','cal-a@example.invalid','America/Argentina/Buenos_Aires',now()),
  ('e3100000-0000-4000-8000-0000000000bb','e3100000-0000-4000-8000-00000000000b','sync-b',gen_random_uuid(),gen_random_uuid(),now()+interval '1 hour','{}','connected','cal-b@example.invalid','America/Argentina/Buenos_Aires',now()),
  ('e3100000-0000-4000-8000-0000000000cc','e3100000-0000-4000-8000-00000000000c','sync-c',gen_random_uuid(),gen_random_uuid(),now()+interval '1 hour','{}','connected','cal-c@example.invalid','America/Argentina/Buenos_Aires',now()),
  ('e3100000-0000-4000-8000-0000000000dd','e3100000-0000-4000-8000-00000000000d','sync-d',gen_random_uuid(),gen_random_uuid(),now()+interval '1 hour','{}','connected','cal-d@example.invalid','America/Argentina/Buenos_Aires',now()),
  ('e3100000-0000-4000-8000-0000000000ee','e3100000-0000-4000-8000-00000000000e','sync-e',null,null,null,'{}','disconnected','cal-e@example.invalid','America/Argentina/Buenos_Aires',null);

insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality) values
  ('e3100000-0000-4000-8000-0000000001aa','e3100000-0000-4000-8000-00000000000a','e3100000-0000-4000-8000-0000000000aa','Test',0,60,'online'),
  ('e3100000-0000-4000-8000-0000000001bb','e3100000-0000-4000-8000-00000000000b','e3100000-0000-4000-8000-0000000000bb','Test',0,60,'online'),
  ('e3100000-0000-4000-8000-0000000001cc','e3100000-0000-4000-8000-00000000000c','e3100000-0000-4000-8000-0000000000cc','Test',0,60,'online'),
  ('e3100000-0000-4000-8000-0000000001dd','e3100000-0000-4000-8000-00000000000d','e3100000-0000-4000-8000-0000000000dd','Test',0,60,'online'),
  ('e3100000-0000-4000-8000-0000000001ee','e3100000-0000-4000-8000-00000000000e','e3100000-0000-4000-8000-0000000000ee','Test',0,60,'online');
insert into public.patients(id,workspace_id,first_name,last_name,email) values
  ('e3100000-0000-4000-8000-0000000002aa','e3100000-0000-4000-8000-00000000000a','Synthetic','A','sync-a@example.invalid'),
  ('e3100000-0000-4000-8000-0000000002bb','e3100000-0000-4000-8000-00000000000b','Synthetic','B','sync-b@example.invalid'),
  ('e3100000-0000-4000-8000-0000000002cc','e3100000-0000-4000-8000-00000000000c','Synthetic','C','sync-c@example.invalid'),
  ('e3100000-0000-4000-8000-0000000002dd','e3100000-0000-4000-8000-00000000000d','Synthetic','D','sync-d@example.invalid'),
  ('e3100000-0000-4000-8000-0000000002ee','e3100000-0000-4000-8000-00000000000e','Synthetic','E','sync-e@example.invalid');
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes) values
  ('e3100000-0000-4000-8000-0000000003aa','e3100000-0000-4000-8000-00000000000a','e3100000-0000-4000-8000-0000000000aa','e3100000-0000-4000-8000-0000000001aa','e3100000-0000-4000-8000-0000000002aa','scheduled',0,60),
  ('e3100000-0000-4000-8000-0000000003bb','e3100000-0000-4000-8000-00000000000b','e3100000-0000-4000-8000-0000000000bb','e3100000-0000-4000-8000-0000000001bb','e3100000-0000-4000-8000-0000000002bb','scheduled',0,60),
  ('e3100000-0000-4000-8000-0000000003cc','e3100000-0000-4000-8000-00000000000c','e3100000-0000-4000-8000-0000000000cc','e3100000-0000-4000-8000-0000000001cc','e3100000-0000-4000-8000-0000000002cc','scheduled',0,60),
  ('e3100000-0000-4000-8000-0000000003dd','e3100000-0000-4000-8000-00000000000d','e3100000-0000-4000-8000-0000000000dd','e3100000-0000-4000-8000-0000000001dd','e3100000-0000-4000-8000-0000000002dd','scheduled',0,60),
  ('e3100000-0000-4000-8000-0000000003ee','e3100000-0000-4000-8000-00000000000e','e3100000-0000-4000-8000-0000000000ee','e3100000-0000-4000-8000-0000000001ee','e3100000-0000-4000-8000-0000000002ee','scheduled',0,60);
insert into public.appointments(id,workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status) values
  ('e3100000-0000-4000-8000-0000000004aa','e3100000-0000-4000-8000-00000000000a','e3100000-0000-4000-8000-0000000003aa','e3100000-0000-4000-8000-0000000000aa','e3100000-0000-4000-8000-0000000002aa',now()+interval '10 days',now()+interval '10 days 1 hour','scheduled'),
  ('e3100000-0000-4000-8000-0000000004bb','e3100000-0000-4000-8000-00000000000b','e3100000-0000-4000-8000-0000000003bb','e3100000-0000-4000-8000-0000000000bb','e3100000-0000-4000-8000-0000000002bb',now()+interval '11 days',now()+interval '11 days 1 hour','scheduled'),
  ('e3100000-0000-4000-8000-0000000004cc','e3100000-0000-4000-8000-00000000000c','e3100000-0000-4000-8000-0000000003cc','e3100000-0000-4000-8000-0000000000cc','e3100000-0000-4000-8000-0000000002cc',now()+interval '12 days',now()+interval '12 days 1 hour','scheduled'),
  ('e3100000-0000-4000-8000-0000000004dd','e3100000-0000-4000-8000-00000000000d','e3100000-0000-4000-8000-0000000003dd','e3100000-0000-4000-8000-0000000000dd','e3100000-0000-4000-8000-0000000002dd',now()+interval '13 days',now()+interval '13 days 1 hour','scheduled'),
  ('e3100000-0000-4000-8000-0000000004ee','e3100000-0000-4000-8000-00000000000e','e3100000-0000-4000-8000-0000000003ee','e3100000-0000-4000-8000-0000000000ee','e3100000-0000-4000-8000-0000000002ee',now()+interval '14 days',now()+interval '14 days 1 hour','scheduled');

do $$ begin
  if (select count(*) from private.google_calendar_event_sync)<>2 then raise exception 'gate_did_not_limit_initial_queue'; end if;
  if not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004aa' and desired_timezone='America/Argentina/Buenos_Aires' and state='pending')
    or not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004dd')
    then raise exception 'pro_or_trial_not_queued'; end if;
  if exists(select 1 from private.google_calendar_event_sync where appointment_id in ('e3100000-0000-4000-8000-0000000004bb','e3100000-0000-4000-8000-0000000004cc','e3100000-0000-4000-8000-0000000004ee'))
    then raise exception 'free_beta_off_or_disconnected_queued'; end if;
end $$;

-- One lease owns each row. Editing during the Google call increments the revision without destroying that lease;
-- completion records the external result and immediately requeues the newer desired state.
set local role service_role;
create temp table first_claim as select * from public.claim_google_calendar_event_sync('e3100000-0000-4000-8000-000000000501',10);
do $$ begin
  if (select count(*) from first_claim)<>2 then raise exception 'claim_wrong'; end if;
  if exists(select 1 from public.claim_google_calendar_event_sync('e3100000-0000-4000-8000-000000000502',10)) then raise exception 'double_claim'; end if;
end $$;
reset role;
update public.appointments set starts_at=starts_at+interval '30 minutes',ends_at=ends_at+interval '30 minutes'
  where id='e3100000-0000-4000-8000-0000000004aa';
do $$ begin
  if not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004aa'
    and state='processing' and desired_revision=2 and lease_token='e3100000-0000-4000-8000-000000000501') then raise exception 'edit_destroyed_lease'; end if;
end $$;
set local role service_role;
do $$ declare v first_claim%rowtype; begin
  select * into v from first_claim where appointment_id='e3100000-0000-4000-8000-0000000004aa';
  if not public.complete_google_calendar_event_sync(v.id,'e3100000-0000-4000-8000-000000000501',v.desired_revision,'created',
    'bellis'||replace(v.appointment_id::text,'-','')||'g0',0) then raise exception 'old_revision_result_lost'; end if;
end $$;
reset role;
do $$ begin
  if not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004aa'
    and state='pending' and event_id='bellise31000000000400080000000000004aag0') then raise exception 'edit_not_requeued'; end if;
end $$;

-- Cancel while the row is durable, delete, then recreate. The old event id stays as a tombstone reference and the
-- worker may persist generation 1; duplicate completion cannot alter the settled row.
update public.appointments set status='cancelled' where id='e3100000-0000-4000-8000-0000000004aa';
set local role service_role;
create temp table delete_claim as select * from public.claim_google_calendar_event_sync('e3100000-0000-4000-8000-000000000503',10)
  where appointment_id='e3100000-0000-4000-8000-0000000004aa';
do $$ declare v delete_claim%rowtype; begin
  select * into v from delete_claim;
  if v.desired_action<>'delete' then raise exception 'cancel_not_delete'; end if;
  if not public.complete_google_calendar_event_sync(v.id,'e3100000-0000-4000-8000-000000000503',v.desired_revision,'deleted',v.event_id,v.generation)
    then raise exception 'delete_not_completed'; end if;
  if public.complete_google_calendar_event_sync(v.id,'e3100000-0000-4000-8000-000000000503',v.desired_revision,'deleted',v.event_id,v.generation)
    then raise exception 'duplicate_completion_accepted'; end if;
end $$;
reset role;
update public.appointments set status='scheduled' where id='e3100000-0000-4000-8000-0000000004aa';
set local role service_role;
create temp table recreate_claim as select * from public.claim_google_calendar_event_sync('e3100000-0000-4000-8000-000000000504',10)
  where appointment_id='e3100000-0000-4000-8000-0000000004aa';
do $$ declare v recreate_claim%rowtype; begin
  select * into v from recreate_claim;
  if not public.complete_google_calendar_event_sync(v.id,'e3100000-0000-4000-8000-000000000504',v.desired_revision,'created',
    'bellis'||replace(v.appointment_id::text,'-','')||'g1',1) then raise exception 'recreate_not_completed'; end if;
end $$;
reset role;

-- Downgrade pauses without deleting or disconnecting; re-enable resumes. Recovery also discovers Free/no-beta rows
-- once each workspace independently gains both conditions, and a disconnected workspace stays absent.
update public.workspaces set plan_code='free',pro_started_at=null where id='e3100000-0000-4000-8000-00000000000a';
select private.prepare_google_calendar_event_sync();
do $$ begin if not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004aa' and state='blocked' and event_id is not null)
  then raise exception 'downgrade_did_not_pause'; end if; end $$;
update public.workspaces set plan_code='pro',pro_started_at=now() where id in ('e3100000-0000-4000-8000-00000000000a','e3100000-0000-4000-8000-00000000000b');
insert into private.workspace_features(workspace_id,feature,enabled_by) values('e3100000-0000-4000-8000-00000000000c','google_calendar_beta','smoke');
select private.prepare_google_calendar_event_sync();
do $$ begin
  if not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004aa' and state='pending')
    or not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004bb')
    or not exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004cc')
    or exists(select 1 from private.google_calendar_event_sync where appointment_id='e3100000-0000-4000-8000-0000000004ee')
    then raise exception 'recovery_gate_wrong'; end if;
end $$;

-- Retry state, attempt persistence and bounded terminal failure.
set local role service_role;
create temp table retry_claim as select * from public.claim_google_calendar_event_sync('e3100000-0000-4000-8000-000000000505',10) limit 1;
do $$ declare v retry_claim%rowtype; begin
  select * into v from retry_claim;
  if not public.fail_google_calendar_event_sync(v.id,'e3100000-0000-4000-8000-000000000505',v.desired_revision,'google_calendar_http_503',true)
    then raise exception 'retry_not_recorded'; end if;
end $$;
reset role;
do $$ begin
  if not exists(select 1 from private.google_calendar_event_sync where state='retry' and attempt_count=1 and last_error_code='google_calendar_http_503')
    then raise exception 'retry_state_lost'; end if;
end $$;

-- No browser role can read or mutate internals, nor invoke worker RPCs.
do $$ declare q text; begin
  foreach q in array array[
    $q$select * from private.google_calendar_event_sync$q$,
    $q$update private.google_calendar_event_sync set state='synced'$q$,
    $q$select * from public.claim_google_calendar_event_sync(gen_random_uuid(),1)$q$,
    $q$select public.complete_google_calendar_event_sync(gen_random_uuid(),gen_random_uuid(),1,'deleted',null,0)$q$
  ] loop
    begin execute 'set local role authenticated'; execute q; reset role; raise exception 'browser_reached_sync_internal';
    exception when insufficient_privilege or invalid_schema_name or undefined_table or undefined_function then reset role; end;
  end loop;
end $$;

do $$ begin
  if not exists(select 1 from cron.job where jobname='bellis-google-calendar-events' and schedule='* * * * *'
    and command='select private.invoke_google_calendar_event_sync()') then raise exception 'sync_cron_missing'; end if;
  if not exists(select 1 from pg_extension where extname='pg_net') then raise exception 'pg_net_missing'; end if;
  if exists(select 1 from private.google_calendar_event_sync s join public.patients p on p.id=s.appointment_id) then raise exception 'pii_join_shape_wrong'; end if;
  if not exists(select 1 from public.audit_events where action='sync_requested')
    or not exists(select 1 from public.audit_events where action='sync_created')
    or not exists(select 1 from public.audit_events where action='sync_deleted')
    or not exists(select 1 from public.audit_events where action='sync_retry') then raise exception 'sync_audit_missing'; end if;
end $$;

rollback;
