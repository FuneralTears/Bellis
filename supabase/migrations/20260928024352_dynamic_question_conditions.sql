-- Conditional questions belong to one immutable form version and workspace.
create table public.questionnaire_conditions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  questionnaire_id uuid not null,
  target_question_id uuid not null,
  question_id uuid not null,
  operator text not null check (operator in ('equals','not_equals','contains','includes','greater_than','less_than')),
  value jsonb not null,
  action text not null check (action in ('show','hide')),
  created_at timestamptz not null default now(),
  foreign key (workspace_id,questionnaire_id,target_question_id)
    references public.questionnaire_questions(workspace_id,questionnaire_id,id) on delete cascade,
  foreign key (workspace_id,questionnaire_id,question_id)
    references public.questionnaire_questions(workspace_id,questionnaire_id,id) on delete cascade
);
create index questionnaire_conditions_target_idx on public.questionnaire_conditions(questionnaire_id,target_question_id);
alter table public.questionnaire_conditions enable row level security;
grant select,insert,update,delete on public.questionnaire_conditions to authenticated;
grant all on public.questionnaire_conditions to service_role;
create policy questionnaire_condition_read on public.questionnaire_conditions for select to authenticated
  using (private.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy questionnaire_condition_insert on public.questionnaire_conditions for insert to authenticated
  with check (private.can_manage_questionnaire(workspace_id,questionnaire_id));
create policy questionnaire_condition_update on public.questionnaire_conditions for update to authenticated
  using (private.can_manage_questionnaire(workspace_id,questionnaire_id))
  with check (private.can_manage_questionnaire(workspace_id,questionnaire_id));
create policy questionnaire_condition_delete on public.questionnaire_conditions for delete to authenticated
  using (private.can_manage_questionnaire(workspace_id,questionnaire_id));

create function private.validate_questionnaire_condition()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_source public.questionnaire_questions%rowtype;
  v_target public.questionnaire_questions%rowtype;
  v_text text;
begin
  select * into v_source from public.questionnaire_questions where id=new.question_id;
  select * into v_target from public.questionnaire_questions where id=new.target_question_id;
  if v_source.id is null or v_target.id is null or not v_source.active
    or v_source.questionnaire_id <> new.questionnaire_id
    or v_target.questionnaire_id <> new.questionnaire_id
    or v_source.workspace_id <> new.workspace_id
    or v_target.workspace_id <> new.workspace_id
    or v_source.sort_order >= v_target.sort_order then
    raise exception 'invalid_condition_source';
  end if;
  if (select count(*) from public.questionnaire_conditions c
      where c.target_question_id=new.target_question_id and c.id<>new.id) >= 10 then
    raise exception 'too_many_conditions';
  end if;
  v_text := new.value #>> '{}';
  if v_source.type = 'multiple_choice' then
    if new.operator <> 'includes' or pg_catalog.jsonb_typeof(new.value) <> 'string'
      or not exists(select 1 from pg_catalog.jsonb_array_elements_text(v_source.options) as opt(value) where opt.value=v_text)
      then raise exception 'invalid_condition_value'; end if;
  elsif v_source.type = 'single_choice' then
    if new.operator not in ('equals','not_equals') or pg_catalog.jsonb_typeof(new.value) <> 'string'
      or not exists(select 1 from pg_catalog.jsonb_array_elements_text(v_source.options) as opt(value) where opt.value=v_text)
      then raise exception 'invalid_condition_value'; end if;
  elsif v_source.type = 'yes_no' then
    if new.operator not in ('equals','not_equals') or pg_catalog.jsonb_typeof(new.value) <> 'boolean'
      then raise exception 'invalid_condition_value'; end if;
  elsif v_source.type in ('number','scale') then
    if new.operator not in ('equals','not_equals','greater_than','less_than')
      or pg_catalog.jsonb_typeof(new.value) <> 'number'
      then raise exception 'invalid_condition_value'; end if;
  elsif v_source.type = 'date' then
    if new.operator not in ('equals','not_equals') or pg_catalog.jsonb_typeof(new.value) <> 'string'
      or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      then raise exception 'invalid_condition_value'; end if;
    perform v_text::date;
  else
    if new.operator not in ('equals','not_equals','contains')
      or pg_catalog.jsonb_typeof(new.value) <> 'string'
      or length(trim(v_text)) not between 1 and 4000
      then raise exception 'invalid_condition_value'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.validate_questionnaire_condition() from public,anon,authenticated;
create trigger questionnaire_condition_guard before insert or update on public.questionnaire_conditions
for each row execute function private.validate_questionnaire_condition();

create function private.question_condition_matches(p_answer jsonb,p_operator text,p_value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_answer is null or p_answer = 'null'::jsonb then return false; end if;
  if p_operator = 'equals' then return p_answer = p_value; end if;
  if p_operator = 'not_equals' then return p_answer <> p_value; end if;
  if p_operator = 'contains' then
    return pg_catalog.jsonb_typeof(p_answer)='string' and pg_catalog.jsonb_typeof(p_value)='string'
      and pg_catalog.strpos(pg_catalog.lower(p_answer #>> '{}'),pg_catalog.lower(p_value #>> '{}')) > 0;
  end if;
  if p_operator = 'includes' then
    return pg_catalog.jsonb_typeof(p_answer)='array' and pg_catalog.jsonb_typeof(p_value)='string'
      and p_answer @> pg_catalog.jsonb_build_array(p_value);
  end if;
  if p_operator in ('greater_than','less_than') then
    if pg_catalog.jsonb_typeof(p_answer)<>'number' or pg_catalog.jsonb_typeof(p_value)<>'number' then return false; end if;
    if p_operator='greater_than' then return (p_answer #>> '{}')::numeric > (p_value #>> '{}')::numeric; end if;
    return (p_answer #>> '{}')::numeric < (p_value #>> '{}')::numeric;
  end if;
  return false;
end;
$$;
revoke all on function private.question_condition_matches(jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function private.question_condition_matches(jsonb,text,jsonb) to service_role;

-- Preserve the existing versioned save API. Client IDs identify references in
-- the draft; the RPC remaps them to fresh question IDs in the saved version.
create or replace function public.save_questionnaire(p_service uuid,p_document jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace uuid;
  v_professional uuid;
  v_id uuid;
  v_question_id uuid;
  v_target_id uuid;
  v_source_id uuid;
  v_client_id text;
  v_client_ids jsonb := '{}'::jsonb;
  v_sections jsonb := p_document->'sections';
  v_questions jsonb := p_document->'questions';
  v_item jsonb;
  v_rule jsonb;
  v_options jsonb;
  v_section text;
  v_type public.questionnaire_question_type;
  v_order integer;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required'; end if;
  select s.workspace_id,s.professional_id into v_workspace,v_professional
  from public.services s where s.id=p_service and s.active;
  if v_workspace is null then raise exception 'service_not_found'; end if;
  if not (private.has_workspace_role(v_workspace,array['owner','admin']::public.workspace_role[])
    or exists(select 1 from public.professionals p where p.id=v_professional and p.user_id=(select auth.uid())))
    then raise exception 'not_authorized'; end if;
  if pg_catalog.pg_column_size(p_document) > 200000 then raise exception 'questionnaire_too_large'; end if;
  if pg_catalog.jsonb_typeof(v_sections) <> 'array' or pg_catalog.jsonb_array_length(v_sections) <> 4
    or pg_catalog.jsonb_typeof(v_questions) <> 'array' or pg_catalog.jsonb_array_length(v_questions) not between 1 and 50
    then raise exception 'invalid_questionnaire'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_service::text,0));
  insert into public.questionnaires(workspace_id,professional_id,service_id,title,active)
  values(v_workspace,v_professional,p_service,left(coalesce(nullif(trim(p_document->>'title'),''),'Preconsulta'),120),false)
  returning id into v_id;

  for v_item,v_order in select value,(ordinality-1)::integer from pg_catalog.jsonb_array_elements(v_sections) with ordinality loop
    v_section := v_item->>'key';
    if v_section not in ('situation','problem','implication','need')
      or length(trim(coalesce(v_item->>'label',''))) not between 1 and 80 then raise exception 'invalid_section'; end if;
    insert into public.questionnaire_sections(workspace_id,questionnaire_id,section_key,visible_name,sort_order)
    values(v_workspace,v_id,v_section,trim(v_item->>'label'),v_order);
  end loop;
  if (select count(distinct section_key) from public.questionnaire_sections where questionnaire_id=v_id) <> 4
    then raise exception 'duplicate_section'; end if;

  for v_item,v_order in select value,(ordinality-1)::integer from pg_catalog.jsonb_array_elements(v_questions) with ordinality loop
    v_section := v_item->>'section';
    if not exists(select 1 from public.questionnaire_sections where questionnaire_id=v_id and section_key=v_section)
      or length(trim(coalesce(v_item->>'title',''))) not between 1 and 500
      or length(coalesce(v_item->>'description','')) > 2000 then raise exception 'invalid_question'; end if;
    v_type := (v_item->>'type')::public.questionnaire_question_type;
    v_options := coalesce(v_item->'options','[]'::jsonb);
    if pg_catalog.jsonb_typeof(v_options) <> 'array' or pg_catalog.jsonb_array_length(v_options) > 20
      then raise exception 'invalid_options'; end if;
    if v_type in ('single_choice','multiple_choice') and pg_catalog.jsonb_array_length(v_options) < 2
      then raise exception 'choices_required'; end if;
    v_client_id := coalesce(nullif(v_item->>'client_id',''),'#' || v_order::text);
    if length(v_client_id)>150 or v_client_ids ? v_client_id then raise exception 'duplicate_question_client_id'; end if;
    insert into public.questionnaire_questions(workspace_id,questionnaire_id,section_key,title,description,type,options,required,sort_order,active)
    values(v_workspace,v_id,v_section,trim(v_item->>'title'),nullif(trim(coalesce(v_item->>'description','')),''),
      v_type,v_options,coalesce((v_item->>'required')::boolean,false),v_order,
      coalesce((v_item->>'active')::boolean,true)) returning id into v_question_id;
    v_client_ids := v_client_ids || pg_catalog.jsonb_build_object(v_client_id,v_question_id::text);
  end loop;
  if not exists(select 1 from public.questionnaire_questions where questionnaire_id=v_id and active)
    then raise exception 'active_question_required'; end if;

  for v_item,v_order in select value,(ordinality-1)::integer from pg_catalog.jsonb_array_elements(v_questions) with ordinality loop
    v_client_id := coalesce(nullif(v_item->>'client_id',''),'#' || v_order::text);
    v_target_id := (v_client_ids->>v_client_id)::uuid;
    if v_item ? 'conditions' and (pg_catalog.jsonb_typeof(v_item->'conditions')<>'array'
      or pg_catalog.jsonb_array_length(v_item->'conditions')>10) then raise exception 'invalid_conditions'; end if;
    for v_rule in select value from pg_catalog.jsonb_array_elements(coalesce(v_item->'conditions','[]'::jsonb)) loop
      v_source_id := (v_client_ids->>(v_rule->>'question_id'))::uuid;
      if v_source_id is null or v_rule->'value' is null then raise exception 'invalid_condition_source'; end if;
      insert into public.questionnaire_conditions(workspace_id,questionnaire_id,target_question_id,question_id,operator,value,action)
      values(v_workspace,v_id,v_target_id,v_source_id,v_rule->>'operator',v_rule->'value',v_rule->>'action');
    end loop;
  end loop;

  update public.questionnaires set active=false,updated_at=now()
  where service_id=p_service and active;
  update public.questionnaires set active=true,updated_at=now() where id=v_id;
  return v_id;
end;
$$;
revoke all on function public.save_questionnaire(uuid,jsonb) from public,anon;
grant execute on function public.save_questionnaire(uuid,jsonb) to authenticated;

-- The trusted intake transaction recomputes visibility from saved conditions.
-- Hidden answers are rejected and only visible required questions are required.
create or replace function public.create_preconsultation_intent(
  p_service uuid, p_first_name text, p_last_name text,
  p_email text, p_phone text, p_answers jsonb
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_service public.services%rowtype;
  v_form public.questionnaires%rowtype;
  v_question public.questionnaire_questions%rowtype;
  v_source public.questionnaire_questions%rowtype;
  v_condition public.questionnaire_conditions%rowtype;
  v_item jsonb;
  v_source_answer jsonb;
  v_target_answer jsonb;
  v_seen uuid[] := array[]::uuid[];
  v_visible uuid[] := array[]::uuid[];
  v_has_show boolean;
  v_show_match boolean;
  v_hide_match boolean;
  v_matches boolean;
  v_patient uuid;
  v_intent uuid;
  v_label text;
begin
  if pg_catalog.jsonb_typeof(p_answers) <> 'array'
    or pg_catalog.jsonb_array_length(p_answers) > 50
    or pg_catalog.pg_column_size(p_answers) > 100000 then
    raise exception 'invalid_answers';
  end if;
  if length(trim(coalesce(p_first_name,''))) not between 1 and 120
    or length(trim(coalesce(p_last_name,''))) not between 1 and 120
    or length(trim(coalesce(p_email,''))) not between 5 and 255
    or coalesce(p_phone,'') !~ '^\+54[0-9]{8,13}$' then
    raise exception 'invalid_patient';
  end if;

  select * into v_service from public.services where id=p_service and active;
  if not found then raise exception 'service_not_found'; end if;
  select * into v_form from public.questionnaires where service_id=p_service and active;
  if not found then raise exception 'questionnaire_not_found'; end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_answers) loop
    if coalesce(v_item->>'question_id','') !~ '^[0-9a-fA-F-]{36}$'
      then raise exception 'invalid_question_id'; end if;
    select * into v_question from public.questionnaire_questions
    where id=(v_item->>'question_id')::uuid and questionnaire_id=v_form.id and active;
    if not found then raise exception 'question_not_found'; end if;
    if v_question.id=any(v_seen) then raise exception 'duplicate_answer'; end if;
    v_seen := array_append(v_seen,v_question.id);
    if v_item->'answer' is null or v_item->'answer' = 'null'::jsonb then
      raise exception 'empty_answer';
    end if;
  end loop;

  for v_question in select * from public.questionnaire_questions
    where questionnaire_id=v_form.id and active order by sort_order loop
    v_has_show := false;
    v_show_match := false;
    v_hide_match := false;
    for v_condition in select * from public.questionnaire_conditions
      where target_question_id=v_question.id order by id loop
      select * into v_source from public.questionnaire_questions
        where id=v_condition.question_id and questionnaire_id=v_form.id;
      if not found or not v_source.active or v_source.sort_order >= v_question.sort_order
        then raise exception 'invalid_condition_graph'; end if;
      if v_condition.action='show' then v_has_show := true; end if;
      v_source_answer := null;
      if v_condition.question_id=any(v_visible) then
        select item.value->'answer' into v_source_answer
        from pg_catalog.jsonb_array_elements(p_answers) as item(value)
        where item.value->>'question_id'=v_condition.question_id::text limit 1;
      end if;
      v_matches := private.question_condition_matches(v_source_answer,v_condition.operator,v_condition.value);
      if v_condition.action='show' and v_matches then v_show_match := true; end if;
      if v_condition.action='hide' and v_matches then v_hide_match := true; end if;
    end loop;
    select item.value->'answer' into v_target_answer
    from pg_catalog.jsonb_array_elements(p_answers) as item(value)
    where item.value->>'question_id'=v_question.id::text limit 1;
    if (not v_has_show or v_show_match) and not v_hide_match then
      v_visible := array_append(v_visible,v_question.id);
      if v_question.required and v_target_answer is null
        then raise exception 'required_answer_missing'; end if;
    elsif v_target_answer is not null then
      raise exception 'hidden_question_answer';
    end if;
  end loop;

  insert into public.patients(workspace_id,first_name,last_name,email,phone)
  values(v_service.workspace_id,trim(p_first_name),trim(p_last_name),lower(trim(p_email)),p_phone)
  returning id into v_patient;
  insert into public.booking_intents(workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes)
  values(v_service.workspace_id,v_service.professional_id,v_service.id,v_patient,'pending_payment',
    v_service.price_minor,v_service.currency_code,v_service.duration_minutes)
  returning id into v_intent;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_answers) loop
    select * into v_question from public.questionnaire_questions where id=(v_item->>'question_id')::uuid;
    select visible_name into v_label from public.questionnaire_sections
      where questionnaire_id=v_form.id and section_key=v_question.section_key;
    insert into public.questionnaire_answers(
      workspace_id,questionnaire_id,question_id,booking_intent_id,patient_id,
      answer,question_title,section_label
    ) values(
      v_service.workspace_id,v_form.id,v_question.id,v_intent,v_patient,
      v_item->'answer',v_question.title,v_label
    );
  end loop;
  return v_intent;
end;
$$;
revoke all on function public.create_preconsultation_intent(uuid,text,text,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.create_preconsultation_intent(uuid,text,text,text,text,jsonb) to service_role;
