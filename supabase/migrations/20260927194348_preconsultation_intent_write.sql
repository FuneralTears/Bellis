-- Preserve question wording even when a professional edits a form later.
alter table public.questionnaire_answers
  add column question_title text not null,
  add column section_label text not null;

-- Unverified email addresses must not merge separate patient identities.
alter table public.patients drop constraint patients_workspace_id_email_key;

-- Trusted server transaction. Only service_role may call it.
create function public.create_preconsultation_intent(
  p_service uuid, p_first_name text, p_last_name text,
  p_email text, p_phone text, p_answers jsonb
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_service public.services%rowtype;
  v_form public.questionnaires%rowtype;
  v_question public.questionnaire_questions%rowtype;
  v_item jsonb;
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

  -- Resolve every submitted question against the active service form.
  for v_item in select value from pg_catalog.jsonb_array_elements(p_answers) loop
    select * into v_question from public.questionnaire_questions
    where id=(v_item->>'question_id')::uuid and questionnaire_id=v_form.id and active;
    if not found then raise exception 'question_not_found'; end if;
    if v_item->'answer' is null or v_item->'answer' = 'null'::jsonb then
      raise exception 'empty_answer';
    end if;
  end loop;
  if exists(
    select 1 from public.questionnaire_questions q
    where q.questionnaire_id=v_form.id and q.active and q.required
      and not exists(
        select 1 from pg_catalog.jsonb_array_elements(p_answers) as item(value)
        where item.value->>'question_id'=q.id::text
      )
  ) then raise exception 'required_answer_missing'; end if;

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
  from public, anon, authenticated;
grant execute on function public.create_preconsultation_intent(uuid,text,text,text,text,jsonb)
  to service_role;
