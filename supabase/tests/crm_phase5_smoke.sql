-- Synthetic fixture, executed as postgres in development. No data persists.
begin;
create temp table crm_phase5_fixture as
select gen_random_uuid() w1,gen_random_uuid() w2,
  (select id from auth.users order by created_at limit 1) u1,
  (select id from auth.users order by created_at offset 1 limit 1) u2,
  gen_random_uuid() pr1,gen_random_uuid() pr2,gen_random_uuid() p1,gen_random_uuid() p2,
  gen_random_uuid() completed_run,gen_random_uuid() failed_run,gen_random_uuid() skipped_run,
  gen_random_uuid() foreign_run,gen_random_uuid() follow_up;
grant select on crm_phase5_fixture to authenticated;
do $$ begin if (select count(*) from crm_phase5_fixture where u1 is not null and u2 is not null)<>1
  then raise exception 'Need two existing test users'; end if; end $$;
insert into public.workspaces(id,name,slug)
select w1,'CRM Phase 5 A','crm-phase5-'||w1 from crm_phase5_fixture
union all select w2,'CRM Phase 5 B','crm-phase5-'||w2 from crm_phase5_fixture;
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u1,'owner'::public.workspace_role from crm_phase5_fixture
union all select w2,u2,'owner'::public.workspace_role from crm_phase5_fixture;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u1,'Prueba A','Psicología','phase5-a' from crm_phase5_fixture
union all select pr2,w2,u2,'Prueba B','Psicología','phase5-b' from crm_phase5_fixture;
insert into public.patients(id,workspace_id,first_name,last_name,email)
select p1,w1,'Prueba','Uno','crm5-'||p1||'@example.invalid' from crm_phase5_fixture
union all select p2,w2,'Prueba','Dos','crm5-'||p2||'@example.invalid' from crm_phase5_fixture;
update public.automation_rules set enabled=true where workspace_id=(select w1 from crm_phase5_fixture);
insert into public.automation_runs(id,workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
select completed_run,w1,r.id,p1,pr1,'appointment',gen_random_uuid(),now(),now() from crm_phase5_fixture f
join public.automation_rules r on r.workspace_id=f.w1 and r.rule_key='first_consultation'
union all select failed_run,w1,r.id,p1,pr1,'appointment',gen_random_uuid(),now(),now() from crm_phase5_fixture f
join public.automation_rules r on r.workspace_id=f.w1 and r.rule_key='inactive_patient'
union all select skipped_run,w1,r.id,p1,pr1,'payment',gen_random_uuid(),now(),now() from crm_phase5_fixture f
join public.automation_rules r on r.workspace_id=f.w1 and r.rule_key='pending_payment'
union all select foreign_run,w2,r.id,p2,pr2,'payment',gen_random_uuid(),now(),now() from crm_phase5_fixture f
join public.automation_rules r on r.workspace_id=f.w2 and r.rule_key='pending_payment';
insert into public.patient_follow_ups(id,workspace_id,patient_id,professional_id,title,due_date,created_by,source,automation_run_id)
select follow_up,w1,p1,pr1,'Seguimiento sintético',current_date,u1,'automation',completed_run from crm_phase5_fixture;
update public.automation_runs set status='completed',follow_up_id=(select follow_up from crm_phase5_fixture),executed_at=now()
  where id=(select completed_run from crm_phase5_fixture);
update public.automation_runs set status='failed',attempt_count=2,executed_at=now(),error_message='Internal SQL example'
  where id=(select failed_run from crm_phase5_fixture);
update public.automation_runs set status='skipped',executed_at=now(),result='{"reason":"Ya tiene un próximo turno"}'::jsonb
  where id=(select skipped_run from crm_phase5_fixture);
update public.automation_runs set status='failed',attempt_count=2,executed_at=now()
  where id=(select foreign_run from crm_phase5_fixture);
do $$ declare f record; begin
  select * into f from crm_phase5_fixture;
  if (select count(*) from public.internal_notifications where workspace_id=f.w1)<>2 then raise exception 'Expected created and failed notifications'; end if;
  if (select count(*) from public.internal_notifications where workspace_id=f.w1 and type='automation_follow_up_created')<>1 then raise exception 'Follow-up notification missing'; end if;
  if (select count(*) from public.internal_notifications where workspace_id=f.w1 and type='automation_failed')<>1 then raise exception 'Failure notification missing'; end if;
  if exists(select 1 from public.internal_notifications where automation_run_id=f.skipped_run) then raise exception 'Skipped notification spam'; end if;
  if (select count(*) from public.internal_notifications where workspace_id=f.w2 and recipient_id=f.u2)<>1 then raise exception 'Foreign recipient resolution failed'; end if;
end $$;
select set_config('request.jwt.claim.sub',u1::text,true) from crm_phase5_fixture;
set local role authenticated;
do $$ declare f record; n integer; denied boolean:=false; begin
  select * into f from crm_phase5_fixture;
  if (select count(*) from public.internal_notifications where workspace_id=f.w1)<>2 then raise exception 'Own notifications hidden'; end if;
  if (select count(*) from public.internal_notifications where workspace_id=f.w2)<>0 then raise exception 'Foreign notifications exposed'; end if;
  if (select count(*) from public.automation_runs where workspace_id=f.w2)<>0 then raise exception 'Foreign runs exposed'; end if;
  update public.internal_notifications set read_at=now() where workspace_id=f.w2;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Foreign notification changed'; end if;
  update public.internal_notifications set read_at=now() where workspace_id=f.w1 and read_at is null;
  if (select count(*) from public.internal_notifications where workspace_id=f.w1 and read_at is null)<>0 then raise exception 'Mark all read failed'; end if;
  begin
    execute 'select error_message from public.automation_runs where id=$1' using f.failed_run;
  exception when insufficient_privilege then denied:=true;
  end;
  if not denied then raise exception 'Technical error exposed to authenticated user'; end if;
  if not public.retry_failed_automation_run(f.failed_run) then raise exception 'Manual retry did not succeed'; end if;
  if not exists(select 1 from public.automation_runs where id=f.failed_run and status='scheduled' and attempt_count=0) then raise exception 'Manual retry did not reuse the run'; end if;
end $$;
reset role;
do $$ declare f record; begin
  select * into f from crm_phase5_fixture;
  if (select count(*) from public.internal_notifications where workspace_id=f.w1 and type='automation_failed')<>1 then raise exception 'Retry duplicated notification'; end if;
  if (select count(*) from public.audit_events where workspace_id=f.w1 and action='internal_notification_read')<>2 then raise exception 'Read audit missing'; end if;
  if (select count(*) from public.audit_events where workspace_id=f.w1 and action='automation_run_manual_retry')<>1 then raise exception 'Retry audit missing'; end if;
end $$;
rollback;
