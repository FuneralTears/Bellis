-- Synthetic role and workspace isolation checks. All changes roll back.
begin;
create temp table phase6_roles_fixture as
select gen_random_uuid() w1, gen_random_uuid() w2,
  (select id from auth.users order by created_at limit 1) u1,
  (select id from auth.users order by created_at offset 1 limit 1) u2,
  gen_random_uuid() pr1, gen_random_uuid() pr2,
  gen_random_uuid() p1, gen_random_uuid() p2,
  gen_random_uuid() run1, gen_random_uuid() run2;
grant select on phase6_roles_fixture to authenticated;
do $$ begin
  if not exists(select 1 from phase6_roles_fixture where u1 is not null and u2 is not null and u1<>u2)
    then raise exception 'Two auth users required'; end if;
end $$;
insert into public.workspaces(id,name,slug)
select w1,'Fase 6 roles A','phase6-roles-'||w1 from phase6_roles_fixture
union all select w2,'Fase 6 roles B','phase6-roles-'||w2 from phase6_roles_fixture;
insert into public.workspace_members(workspace_id,user_id,role)
select w1,u1,'owner'::public.workspace_role from phase6_roles_fixture
union all select w2,u2,'owner'::public.workspace_role from phase6_roles_fixture;
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
select pr1,w1,u1,'Prueba A','Psicología','phase6-roles-a' from phase6_roles_fixture
union all select pr2,w2,u2,'Prueba B','Psicología','phase6-roles-b' from phase6_roles_fixture;
insert into public.patients(id,workspace_id,first_name,last_name,email)
select p1,w1,'Prueba','A','phase6-'||p1||'@example.invalid' from phase6_roles_fixture
union all select p2,w2,'Prueba','B','phase6-'||p2||'@example.invalid' from phase6_roles_fixture;
insert into public.automation_runs(id,workspace_id,automation_rule_id,patient_id,professional_id,reference_type,reference_id,triggered_at,scheduled_for)
select run1,w1,r.id,p1,pr1,'appointment',gen_random_uuid(),now(),now()
  from phase6_roles_fixture f join public.automation_rules r on r.workspace_id=f.w1 and r.rule_key='first_consultation'
union all
select run2,w2,r.id,p2,pr2,'appointment',gen_random_uuid(),now(),now()
  from phase6_roles_fixture f join public.automation_rules r on r.workspace_id=f.w2 and r.rule_key='first_consultation';
update public.automation_runs set status='failed',attempt_count=2,executed_at=now()
  where id in (select run1 from phase6_roles_fixture union all select run2 from phase6_roles_fixture);

select set_config('request.jwt.claim.sub',u1::text,true) from phase6_roles_fixture;
set local role authenticated;
do $$ declare f record; begin
  select * into f from phase6_roles_fixture;
  if (select count(*) from public.patients where id=f.p1)<>1 or (select count(*) from public.patients where id=f.p2)<>0
    then raise exception 'owner patient isolation'; end if;
  if (select count(*) from public.automation_runs where id=f.run1)<>1 or (select count(*) from public.automation_runs where id=f.run2)<>0
    then raise exception 'owner run isolation'; end if;
  if (select count(*) from public.internal_notifications where automation_run_id=f.run1)<>1
    or (select count(*) from public.internal_notifications where automation_run_id=f.run2)<>0
    then raise exception 'owner notification isolation'; end if;
end $$;

reset role;
update public.workspace_members set role='admin' where workspace_id=(select w1 from phase6_roles_fixture);
set local role authenticated;
do $$ declare f record; n integer; begin
  select * into f from phase6_roles_fixture;
  update public.automation_rules set name=name where workspace_id=f.w1;
  get diagnostics n=row_count;
  if n<>3 then raise exception 'admin cannot manage own rules'; end if;
  if exists(select 1 from public.patients where id=f.p2) or exists(select 1 from public.automation_runs where id=f.run2)
    then raise exception 'admin foreign workspace visible'; end if;
end $$;

reset role;
update public.workspace_members set role='professional' where workspace_id=(select w1 from phase6_roles_fixture);
set local role authenticated;
do $$ declare f record; n integer:=0; begin
  select * into f from phase6_roles_fixture;
  if (select count(*) from public.automation_runs where id=f.run1)<>1
    or exists(select 1 from public.automation_runs where id=f.run2)
    then raise exception 'professional run scope'; end if;
  begin
    update public.automation_rules set name=name where workspace_id=f.w1;
    get diagnostics n=row_count;
  exception when insufficient_privilege then n:=0;
  end;
  if n<>0 then raise exception 'professional changed a rule'; end if;
  if exists(select 1 from public.internal_notifications where automation_run_id=f.run2)
    then raise exception 'professional foreign notification visible'; end if;
end $$;

reset role;
update public.workspace_members set role='reception' where workspace_id=(select w1 from phase6_roles_fixture);
set local role authenticated;
do $$ declare f record; n integer:=0; begin
  select * into f from phase6_roles_fixture;
  if (select count(*) from public.patients where id=f.p1)<>1
    or (select count(*) from public.automation_runs where id=f.run1)<>1
    then raise exception 'reception own workspace hidden'; end if;
  if exists(select 1 from public.patients where id=f.p2)
    or exists(select 1 from public.automation_runs where id=f.run2)
    or exists(select 1 from public.internal_notifications where automation_run_id=f.run2)
    then raise exception 'reception foreign workspace visible'; end if;
  begin
    update public.automation_rules set name=name where workspace_id=f.w1;
    get diagnostics n=row_count;
  exception when insufficient_privilege then n:=0;
  end;
  if n<>0 then raise exception 'reception changed a rule'; end if;
end $$;
rollback;
