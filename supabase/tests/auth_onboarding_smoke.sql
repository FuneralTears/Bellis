-- Synthetic Auth/bootstrap/onboarding integration test. Nothing is retained.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','a4000000-0000-4000-8000-000000000001','authenticated','authenticated',
  'auth-onboarding@example.invalid','',now(),'{}',
  '{"bellis_signup":"1","name":"Ana Prueba","business":"Consultorio Prueba","specialty":"Psicología","province":"Córdoba","city":"Córdoba","timezone":"America/Argentina/Buenos_Aires"}',now(),now());

do $$ begin
  if (select count(*) from public.workspace_members where user_id='a4000000-0000-4000-8000-000000000001')<>1
    or (select count(*) from public.professionals where user_id='a4000000-0000-4000-8000-000000000001')<>1
    or exists(select 1 from public.services s join public.professionals p on p.id=s.professional_id
      where p.user_id='a4000000-0000-4000-8000-000000000001')
    then raise exception 'signup_bootstrap_wrong'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','a4000000-0000-4000-8000-000000000001',true);
do $$ begin
  begin
    perform public.complete_bellis_onboarding('{"service":"Consulta","price":"0"}'::jsonb);
    raise exception 'invalid_onboarding_allowed';
  exception when others then if sqlerrm<>'invalid_service' then raise; end if; end;
end $$;

select public.complete_bellis_onboarding('{
  "service":"Consulta psicológica","description":"Consulta inicial","price":"25000",
  "duration":"60","mode":"Online","start":"09:00","end":"18:00",
  "breakStart":"13:00","breakEnd":"14:00","notice":"24","buffer":"15",
  "days":[true,true,true,true,true,false,false]
}'::jsonb);
select public.complete_bellis_onboarding('{
  "service":"Consulta psicológica","description":"Consulta inicial","price":"25000",
  "duration":"60","mode":"Online","start":"09:00","end":"18:00",
  "breakStart":"13:00","breakEnd":"14:00","notice":"24","buffer":"15",
  "days":[true,true,true,true,true,false,false]
}'::jsonb);

do $$ declare v_workspace uuid; v_professional uuid; begin
  select workspace_id into v_workspace from public.workspace_members where user_id='a4000000-0000-4000-8000-000000000001';
  select id into v_professional from public.professionals where user_id='a4000000-0000-4000-8000-000000000001';
  if (select onboarding_completed_at from public.workspaces where id=v_workspace) is null
    or (select count(*) from public.services where workspace_id=v_workspace and professional_id=v_professional)<>1
    or (select count(*) from public.availability_rules where workspace_id=v_workspace and professional_id=v_professional)<>10
    then raise exception 'onboarding_not_idempotent'; end if;
end $$;
rollback;
