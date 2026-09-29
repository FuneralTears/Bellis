-- Datos sintéticos. La transacción completa se revierte.
begin;
create temp table crm_phase2_fixture as
select a.workspace_id w1,a.user_id u1,a.id pr1,b.workspace_id w2,b.user_id u2,b.id pr2,
  gen_random_uuid() p1,gen_random_uuid() p2,gen_random_uuid() f2
from (select p.workspace_id,p.user_id,p.id from public.professionals p
  join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
  order by p.workspace_id limit 1) a
cross join (select p.workspace_id,p.user_id,p.id from public.professionals p
  join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
  order by p.workspace_id offset 1 limit 1) b;
grant select on crm_phase2_fixture to authenticated;
insert into public.patients(id,workspace_id,first_name,last_name,email)
select p1,w1,'Prueba','Uno','crm-phase2-'||p1||'@example.invalid' from crm_phase2_fixture
union all
select p2,w2,'Prueba','Dos','crm-phase2-'||p2||'@example.invalid' from crm_phase2_fixture;
insert into public.patient_follow_ups(id,workspace_id,patient_id,professional_id,title,due_date,priority,created_by)
select f2,w2,p2,pr2,'Control ajeno',current_date,'medium',u2 from crm_phase2_fixture;
insert into public.patient_activities(workspace_id,patient_id,professional_id,type,title,description,created_by)
select w2,p2,pr2,'email','Contacto ajeno','Prueba sintética',u2 from crm_phase2_fixture;
select set_config('request.jwt.claim.sub',u1::text,true) from crm_phase2_fixture;
set local role authenticated;
do $$
declare f record; own_follow_up uuid; cancelled_follow_up uuid; row_count integer; denied boolean := false;
begin
  select * into f from crm_phase2_fixture;
  if (select count(*) from public.patient_crm_overview where id=f.p1) <> 1 then raise exception 'own patient not visible'; end if;
  if (select count(*) from public.patient_crm_overview where id=f.p2) <> 0 then raise exception 'foreign patient visible'; end if;
  insert into public.patient_notes(workspace_id,patient_id,author_id,content)
    values(f.w1,f.p1,f.u1,'Nota sintética');
  insert into public.patient_activities(workspace_id,patient_id,professional_id,type,title,description,created_by)
    values(f.w1,f.p1,f.pr1,'call','Llamada','Contacto sintético',f.u1);
  insert into public.patient_activities(workspace_id,patient_id,professional_id,type,title,description,created_by)
    values(f.w1,f.p1,f.pr1,'whatsapp','WhatsApp','Contacto sintético',f.u1),
      (f.w1,f.p1,f.pr1,'email','Email','Contacto sintético',f.u1);
  if (select count(*) from public.patient_activities where patient_id=f.p1) <> 3 then raise exception 'own activities not visible'; end if;
  insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by)
    values(f.w1,f.p1,f.pr1,'Próxima acción',current_date,f.u1) returning id into own_follow_up;
  if (select follow_up_due_date from public.patient_crm_overview where id=f.p1) <> current_date then raise exception 'overview due date missing'; end if;
  update public.patient_follow_ups set title='Próxima acción editada',priority='high' where id=own_follow_up;
  if not exists(select 1 from public.patient_follow_ups where id=own_follow_up and title='Próxima acción editada' and priority='high') then raise exception 'follow-up edit missing'; end if;
  update public.patient_follow_ups set status='completed' where id=own_follow_up;
  if not exists(select 1 from public.patient_follow_ups where id=own_follow_up and status='completed' and completed_at is not null) then raise exception 'completion timestamp missing'; end if;
  insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by)
    values(f.w1,f.p1,f.pr1,'Cancelar acción',current_date,f.u1) returning id into cancelled_follow_up;
  update public.patient_follow_ups set status='cancelled' where id=cancelled_follow_up;
  if not exists(select 1 from public.patient_follow_ups where id=cancelled_follow_up and status='cancelled' and cancelled_at is not null) then raise exception 'cancellation timestamp missing'; end if;
  if (select count(*) from public.patient_follow_ups where patient_id=f.p2) <> 0 then raise exception 'foreign follow-up visible'; end if;
  if (select count(*) from public.patient_activities where patient_id=f.p2) <> 0 then raise exception 'foreign activity visible'; end if;
  update public.patient_follow_ups set status='completed' where id=f.f2;
  get diagnostics row_count = row_count;
  if row_count <> 0 then raise exception 'foreign follow-up changed'; end if;
  begin
    insert into public.patient_activities(workspace_id,patient_id,professional_id,type,title,description,created_by)
      values(f.w2,f.p2,f.pr2,'call','Ajena','No permitida',f.u1);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'foreign activity inserted'; end if;
  denied := false;
  begin
    insert into public.patient_follow_ups(workspace_id,patient_id,professional_id,title,due_date,created_by)
      values(f.w2,f.p2,f.pr2,'Ajeno',current_date,f.u1);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'foreign follow-up inserted'; end if;
end $$;
rollback;
