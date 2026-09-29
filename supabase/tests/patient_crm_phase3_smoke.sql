-- Datos sintéticos. No persiste nada: toda la transacción se revierte.
begin;
create temp table crm_phase3_fixture as
select a.workspace_id w1,a.user_id u1,a.id pr1,b.workspace_id w2,b.id pr2,
  gen_random_uuid() p1,gen_random_uuid() p2,gen_random_uuid() p3,
  gen_random_uuid() s1,gen_random_uuid() s2,
  gen_random_uuid() i1,gen_random_uuid() i2,gen_random_uuid() i3,
  gen_random_uuid() f1
from (select p.workspace_id,p.user_id,p.id from public.professionals p
  join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
  order by p.workspace_id limit 1) a
cross join (select p.workspace_id,p.id from public.professionals p
  join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
  order by p.workspace_id offset 1 limit 1) b;
grant select on crm_phase3_fixture to authenticated;
insert into public.patients(id,workspace_id,first_name,last_name,email,created_at)
select p1,w1,'Prueba','Atención','crm-phase3-'||p1||'@example.invalid',now()-interval '80 days' from crm_phase3_fixture
union all select p2,w1,'Prueba','Nueva','crm-phase3-'||p2||'@example.invalid',now() from crm_phase3_fixture
union all select p3,w2,'Prueba','Ajena','crm-phase3-'||p3||'@example.invalid',now() from crm_phase3_fixture;
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality)
select s1,w1,pr1,'Servicio sintético',1000000,60,'online' from crm_phase3_fixture
union all select s2,w2,pr2,'Servicio sintético',1000000,60,'online' from crm_phase3_fixture;
insert into public.booking_intents(id,workspace_id,professional_id,service_id,patient_id,status,price_minor,duration_minutes,expires_at)
select i1,w1,pr1,s1,p1,'completed'::public.booking_status,1000000,60,now()+interval '1 day' from crm_phase3_fixture
union all select i2,w1,pr1,s1,p1,'pending_payment'::public.booking_status,1000000,60,now()+interval '1 day' from crm_phase3_fixture
union all select i3,w1,pr1,s1,p1,'scheduled'::public.booking_status,1000000,60,now()+interval '1 day' from crm_phase3_fixture;
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i1,pr1,p1,now()-interval '70 days',now()-interval '70 days'+interval '1 hour','completed'
from crm_phase3_fixture;
insert into public.payments(workspace_id,booking_intent_id,provider,amount_minor,status)
select w1,i2,'external_link',1000000,'pending' from crm_phase3_fixture;
insert into public.patient_follow_ups(id,workspace_id,patient_id,professional_id,title,due_date,created_by)
select f1,w1,p1,pr1,'Control sintético',current_date-1,u1 from crm_phase3_fixture;
select set_config('request.jwt.claim.sub',u1::text,true) from crm_phase3_fixture;
set local role authenticated;
do $$
declare f record; row_data record;
begin
  select * into f from crm_phase3_fixture;
  select * into row_data from public.patient_follow_up_opportunities where id=f.p1;
  if row_data.id is null or not row_data.first_completed_without_next or not row_data.inactive_after_care
    or not row_data.has_pending_payment or not row_data.has_overdue_follow_up or row_data.has_upcoming_turn
    then raise exception 'initial opportunity rules failed'; end if;
  select * into row_data from public.patient_follow_up_opportunities where id=f.p2;
  if row_data.id is null or not row_data.is_new_patient or row_data.without_next_turn
    then raise exception 'new patient rule failed'; end if;
  if exists(select 1 from public.patient_follow_up_opportunities where id=f.p3)
    then raise exception 'cross workspace opportunity exposed'; end if;
end $$;
reset role;
insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at,status)
select w1,i3,pr1,p1,now()+interval '10 days',now()+interval '10 days'+interval '1 hour','scheduled'
from crm_phase3_fixture;
update public.payments set status='approved',approved_at=now()
where booking_intent_id=(select i2 from crm_phase3_fixture);
update public.patient_follow_ups set status='completed' where id=(select f1 from crm_phase3_fixture);
select set_config('request.jwt.claim.sub',u1::text,true) from crm_phase3_fixture;
set local role authenticated;
do $$
declare f record; row_data record;
begin
  select * into f from crm_phase3_fixture;
  select * into row_data from public.patient_follow_up_opportunities where id=f.p1;
  if row_data.id is null or row_data.without_next_turn or row_data.inactive_after_care
    or row_data.has_pending_payment or row_data.has_overdue_follow_up or not row_data.has_upcoming_turn
    then raise exception 'opportunity did not refresh after source changes'; end if;
end $$;
rollback;
