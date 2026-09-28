-- Synthetic data only. Always rolls back, including the generated patient answers.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','f1000000-0000-4000-8000-000000000001','authenticated','authenticated','dynamic-smoke@example.invalid','',now(),'{}','{}',now(),now());
insert into public.workspaces(id,name,slug) values('f1000000-0000-4000-8000-000000000002','Dynamic smoke','dynamic-smoke');
insert into public.workspace_members(workspace_id,user_id,role) values('f1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000001','owner');
insert into public.professionals(id,workspace_id,user_id,display_name,specialty,public_slug)
values('f1000000-0000-4000-8000-000000000003','f1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000001','Smoke','Psicología','dynamic-smoke');
insert into public.services(id,workspace_id,professional_id,name,price_minor,duration_minutes,modality)
values('f1000000-0000-4000-8000-000000000004','f1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000003','Consulta',2500000,60,'online');
set local role authenticated;
select set_config('request.jwt.claim.sub','f1000000-0000-4000-8000-000000000001',true);
select public.save_questionnaire('f1000000-0000-4000-8000-000000000004',
'{"title":"Condicional","sections":[{"key":"situation","label":"Situación"},{"key":"problem","label":"Problema"},{"key":"implication","label":"Implicación"},{"key":"need","label":"Necesidad"}],"questions":[{"client_id":"first","section":"situation","title":"¿Primera consulta?","type":"yes_no","options":[],"required":true,"active":true},{"client_id":"yes","section":"problem","title":"Contexto inicial","type":"text","options":[],"required":true,"active":true,"conditions":[{"question_id":"first","operator":"equals","value":true,"action":"show"}]},{"client_id":"no","section":"problem","title":"Experiencia anterior","type":"text","options":[],"required":true,"active":true,"conditions":[{"question_id":"first","operator":"equals","value":false,"action":"show"}]}]}'::jsonb);
set local role service_role;
do $$
declare source_id uuid; yes_id uuid; no_id uuid; payload jsonb; result_id uuid;
begin
  select id into source_id from public.questionnaire_questions where title='¿Primera consulta?' and workspace_id='f1000000-0000-4000-8000-000000000002';
  select id into yes_id from public.questionnaire_questions where title='Contexto inicial' and workspace_id='f1000000-0000-4000-8000-000000000002';
  select id into no_id from public.questionnaire_questions where title='Experiencia anterior' and workspace_id='f1000000-0000-4000-8000-000000000002';
  payload := jsonb_build_array(jsonb_build_object('question_id',source_id,'answer',true));
  begin
    perform public.create_preconsultation_intent('f1000000-0000-4000-8000-000000000004','Prueba','Uno','smoke@example.invalid','+5491112345678',payload);
    raise exception 'missing_branch_not_rejected';
  exception when others then
    if sqlerrm <> 'required_answer_missing' then raise; end if;
  end;
  payload := jsonb_build_array(jsonb_build_object('question_id',source_id,'answer',true),jsonb_build_object('question_id',yes_id,'answer','Contexto'));
  result_id := public.create_preconsultation_intent('f1000000-0000-4000-8000-000000000004','Prueba','Dos','smoke@example.invalid','+5491112345678',payload);
  if (select count(*) from public.questionnaire_answers where booking_intent_id=result_id) <> 2 then raise exception 'wrong_answer_count'; end if;
  payload := payload || jsonb_build_array(jsonb_build_object('question_id',no_id,'answer','No debería'));
  begin
    perform public.create_preconsultation_intent('f1000000-0000-4000-8000-000000000004','Prueba','Tres','smoke@example.invalid','+5491112345678',payload);
    raise exception 'hidden_branch_not_rejected';
  exception when others then
    if sqlerrm <> 'hidden_question_answer' then raise; end if;
  end;
end $$;
select count(*) as conditional_rules from public.questionnaire_conditions where workspace_id='f1000000-0000-4000-8000-000000000002';
rollback;
