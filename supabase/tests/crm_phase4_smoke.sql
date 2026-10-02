-- Synthetic, reversible smoke test. Execute as postgres in Bellis development Supabase.
begin;
create temp table crm_phase4_fixture as
select gen_random_uuid() w1,gen_random_uuid() w2,
  (select id from auth.users order by created_at limit 1) u1,
  (select id from auth.users order by created_at offset 1 limit 1) u2,
  gen_random_uuid() pr1,gen_random_uuid() pr2,gen_random_uuid() s1,
  gen_random_uuid() p1,gen_random_uuid() p2,gen_random_uuid() p3,
  gen_random_uuid() p4,gen_random_uuid() p5,gen_random_uuid() p6,gen_random_uuid() p_foreign,
  gen_random_uuid() i1,gen_random_uuid() i2,gen_random_uuid() i3,
  gen_random_uuid() i4,gen_random_uuid() i5,gen_random_uuid() i6,gen_random_uuid() i_future;
grant select on crm_phase4_fixture to authenticated;
do $$ begin
  if (select count(*) from crm_phase4_fixture where u1 is not null and u2 is not null)<>1 then
    raise exception 'Need two existing test users'; end if;
end $$;
insert into public.workspaces(id,name,slug)
select w1,'CRM Phase 4 A','crm-phase4-'||w1 from crm_phase4_fixture
union all select w2,'CRM Phase 4 B','crm-phase4-'||w2 from crm_phase4_fixture;
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u1,'owner'::public.workspace_role from crm_phase4_fixture
union all select w2,u2,'owner'::public.workspace_role from crm_phase4_fixture;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u1,'Prueba Uno','Psicología','prueba-uno' from crm_phase4_fixture
union all select pr2,w2,u2,'Prueba Dos','Psicología','prueba-dos' from crm_phase4_fixture;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality)
select s1,w1,pr1,'Consulta sintética',1000000,60,'online' from crm_phase4_fixture;
insert into public.patients(id,workspace_id,first_name,last_name,email)
select p1,w1,'Prueba','Primera','crm4-'||p1||'@example.invalid' from crm_phase4_fixture
union all select p2,w1,'Prueba','Turno futuro','crm4-'||p2||'@example.invalid' from crm_phase4_fixture
union all select p3,w1,'Prueba','Inactiva','crm4-'||p3||'@example.invalid' from crm_phase4_fixture
union all select p4,w1,'Prueba','Pago pendiente','crm4-'||p4||'@example.invalid' from crm_phase4_fixture
union all select p5,w1,'Prueba','Pago aprobado','crm4-'||p5||'@example.invalid' from crm_phase4_fixture
union all select p6,w1,'Prueba','Con tarea manual','crm4-'||p6||'@example.invalid' from crm_phase4_fixture
union all select p_foreign,w2,'Prueba','Ajena','crm4-'||p_foreign||'@example.invalid' from crm_phase4_fixture;
update public.automation_rules set enabled=true where workspace_id=(select w1 from crm_phase4_fixture);
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes,expires_at)
select i1,w1,pr1,s1,p1,'scheduled'::public.booking_status,1000000,60,now()+interval '3 days' from crm_phase4_fixture
union all select i2,w1,pr1,s1,p2,'scheduled'::public.booking_status,1000000,60,now()+interval '3 days' from crm_phase4_fixture
union all select i3,w1,pr1,s1,p3,'scheduled'::public.booking_status,1000000,60,now()+interval '3 days' from crm_phase4_fixture
union all select i4,w1,pr1,s1,p4,'pending_payment'::public.booking_status,1000000,60,now()+interval '3 days' from crm_phase4_fixture
union all select i5,w1,pr1,s1,p5,'pending_payment'::public.booking_status,1000000,60,now()+interval '3 days' from crm_phase4_fixture
union all select i6,w1,pr1,s1,p6,'pending_payment'::public.booking_status,1000000,60,now()+interval '3 days' from crm_phase4_fixture
union all select i_future,w1,pr1,s1,p2,'scheduled'::public.booking_status,1000000,60,now()+interval '3 days' from crm_phase4_fixture;
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i1,pr1,p1,now()-interval '1 day',now()-interval '1 day'+interval '1 hour','scheduled'::public.booking_status from crm_phase4_fixture
union all select w1,i2,pr1,p2,now()-interval '2 days',now()-interval '2 days'+interval '1 hour','scheduled' from crm_phase4_fixture
union all select w1,i3,pr1,p3,now()-interval '61 days',now()-interval '61 days'+interval '1 hour','scheduled' from crm_phase4_fixture;
update public.appointments set status='completed' where workspace_id=(select w1 from crm_phase4_fixture);
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i_future,pr1,p2,now()+interval '5 days',now()+interval '5 days'+interval '1 hour','scheduled'::public.booking_status from crm_phase4_fixture;
insert into public.payments(workspace_id,booking_intent_id,provider,amount_minor,status)
select w1,i4,'external_link',1000000,'pending'::public.payment_status from crm_phase4_fixture
union all select w1,i5,'external_link',1000000,'pending' from crm_phase4_fixture
union all select w1,i6,'external_link',1000000,'pending' from crm_phase4_fixture;
update public.payments set status='approved',approved_at=now() where booking_intent_id=(select i5 from crm_phase4_fixture);
insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by)
select w1,p6,pr1,'Revisar pago pendiente',current_date,u1 from crm_phase4_fixture;
select private.enqueue_automation_candidates();
select private.enqueue_automation_candidates();
do $$ begin
  if exists(select 1 from public.automation_runs group by automation_rule_id,reference_id having count(*)>1) then
    raise exception 'Duplicate run after repeated enqueue'; end if;
end $$;
update public.automation_runs set scheduled_for=now()-interval '1 second'
where workspace_id=(select w1 from crm_phase4_fixture)
  and ((patient_id in (select p1 from crm_phase4_fixture union all select p2 from crm_phase4_fixture)
    and automation_rule_id=(select id from public.automation_rules where workspace_id=(select w1 from crm_phase4_fixture) and rule_key='first_consultation'))
    or (patient_id=(select p3 from crm_phase4_fixture)
      and automation_rule_id=(select id from public.automation_rules where workspace_id=(select w1 from crm_phase4_fixture) and rule_key='inactive_patient'))
    or (patient_id in (select p4 from crm_phase4_fixture union all select p5 from crm_phase4_fixture union all select p6 from crm_phase4_fixture)
      and automation_rule_id=(select id from public.automation_rules where workspace_id=(select w1 from crm_phase4_fixture) and rule_key='pending_payment')));
select private.process_due_automation_runs(100);
select private.process_due_automation_runs(100);
do $$ declare f record; begin
  select * into f from crm_phase4_fixture;
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1 and patient_id=f.p1 and source='automation')<>1 then raise exception 'First consultation action failed'; end if;
  if not exists(select 1 from public.automation_runs where workspace_id=f.w1 and patient_id=f.p2 and status='skipped' and result->>'reason'='Ya tiene un próximo turno') then raise exception 'Future appointment was not re-evaluated'; end if;
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1 and patient_id=f.p3 and source='automation' and title='Revisar seguimiento de paciente inactivo')<>1 then raise exception 'Inactive patient action failed'; end if;
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1 and patient_id=f.p4 and source='automation')<>1 then raise exception 'Pending payment action failed'; end if;
  if not exists(select 1 from public.automation_runs where workspace_id=f.w1 and patient_id=f.p5 and status='skipped' and result->>'reason'='El pago ya no está pendiente') then raise exception 'Approved payment was not skipped'; end if;
  if (select count(*) from public.patient_follow_ups where workspace_id=f.w1 and patient_id=f.p6)<>1 then raise exception 'Equivalent manual follow-up duplicated'; end if;
  if (select count(*) from public.patient_activities where workspace_id=f.w1 and type='automation_created_follow_up')<>3 then raise exception 'Automation activity missing'; end if;
end $$;
insert into public.automation_runs(workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
select f.w2,r.id,f.p_foreign,f.pr2,'payment',gen_random_uuid(),now(),now()+interval '1 day'
from crm_phase4_fixture f join public.automation_rules r on r.workspace_id=f.w2 and r.rule_key='pending_payment';
select set_config('request.jwt.claim.sub',u1::text,true) from crm_phase4_fixture;
set local role authenticated;
do $$ declare f record; n integer; denied boolean:=false; begin
  select * into f from crm_phase4_fixture;
  if (select count(*) from public.automation_rules where workspace_id=f.w2)<>0 then raise exception 'Foreign rules exposed'; end if;
  if (select count(*) from public.automation_runs where workspace_id=f.w2)<>0 then raise exception 'Foreign runs exposed'; end if;
  if (select count(*) from public.patients where workspace_id=f.w2)<>0 then raise exception 'Foreign patient exposed'; end if;
  update public.automation_rules set enabled=true where workspace_id=f.w2;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Foreign rule changed'; end if;
  begin
    insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by,source,automation_run_id)
      values(f.w1,f.p1,f.pr1,'Tarea falsa',current_date,f.u1,'automation',gen_random_uuid());
  exception when insufficient_privilege or check_violation then denied:=true;
  end;
  if not denied then raise exception 'Authenticated user spoofed an automatic follow-up'; end if;
end $$;
reset role;
rollback;
