-- Datos sintéticos. No persiste nada: toda la transacción se revierte.
begin;
-- Dos consultorios propios de este smoke, con Bellis Pro: no depende de ningún workspace real ni de su plan.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('fd100000-0000-4000-8000-00000000000' || n)::uuid,'authenticated','authenticated',
  'patient-crm-phase3-' || n || '@example.invalid','',now(),'{}','{}',now(),now() from generate_series(1,2) n;
insert into public.workspaces(id,name,slug,plan_code,pro_started_at) values
  ('fd100000-0000-4000-8000-0000000000a1','CRM smoke A','patient-crm-phase3-a','pro','2020-01-01'),
  ('fd100000-0000-4000-8000-0000000000a2','CRM smoke B','patient-crm-phase3-b','pro','2020-01-01');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('fd100000-0000-4000-8000-0000000000a1','fd100000-0000-4000-8000-000000000001','owner'),('fd100000-0000-4000-8000-0000000000a2','fd100000-0000-4000-8000-000000000002','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug) values
  ('fd100000-0000-4000-8000-0000000000b1','fd100000-0000-4000-8000-0000000000a1','fd100000-0000-4000-8000-000000000001','Smoke A','Psicología','patient-crm-phase3-a'),
  ('fd100000-0000-4000-8000-0000000000b2','fd100000-0000-4000-8000-0000000000a2','fd100000-0000-4000-8000-000000000002','Smoke B','Psicología','patient-crm-phase3-b');
create temp table crm_phase3_fixture as
select a.workspace_id w1,a.user_id u1,a.id pr1,b.workspace_id w2,b.id pr2,
  gen_random_uuid() p1,gen_random_uuid() p2,gen_random_uuid() p3,
  gen_random_uuid() s1,gen_random_uuid() s2,
  gen_random_uuid() i1,gen_random_uuid() i2,gen_random_uuid() i3,
  gen_random_uuid() f1
from (select p.workspace_id,p.user_id,p.id from public.professionals p
  join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
  where p.workspace_id in ('fd100000-0000-4000-8000-0000000000a1','fd100000-0000-4000-8000-0000000000a2')
  order by p.workspace_id limit 1) a
cross join (select p.workspace_id,p.id from public.professionals p
  join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
  where p.workspace_id in ('fd100000-0000-4000-8000-0000000000a1','fd100000-0000-4000-8000-0000000000a2')
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
-- Vencido ayer, en el día del consultorio. La regla compara la fecha del seguimiento con "hoy" en la zona horaria
-- del workspace (Argentina), no con el día de UTC: entre las 21:00 y las 24:00 de Argentina UTC ya está en el día
-- siguiente, y "ayer de UTC" es todavía hoy para el consultorio. Con la fecha del workspace vale a cualquier hora.
insert into public.patient_follow_ups(id,workspace_id,patient_id,professional_id,title,due_date,created_by)
select f1,w1,p1,pr1,'Control sintético',(now() at time zone (select w.timezone from public.workspaces w where w.id=w1))::date-1,u1 from crm_phase3_fixture;
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
