-- Validate answer shape at the table boundary, including service-role writes.
create function private.validate_questionnaire_answer_value()
returns trigger language plpgsql set search_path = '' as $$
declare
  q public.questionnaire_questions%rowtype;
  answer_type text;
  answer_text text;
begin
  select * into q from public.questionnaire_questions where id=new.question_id;
  if not found then raise exception 'question_not_found'; end if;
  answer_type := pg_catalog.jsonb_typeof(new.answer);
  answer_text := new.answer #>> '{}';

  if q.type in ('text','long_text','date','single_choice') then
    if answer_type <> 'string' or length(trim(answer_text)) = 0 then
      raise exception 'invalid_text_answer';
    end if;
    if length(answer_text) > 4000 then raise exception 'answer_too_long'; end if;
  end if;
  if q.type = 'single_choice' then
    if not exists(select 1 from pg_catalog.jsonb_array_elements_text(q.options) as opt(value)
      where opt.value=answer_text) then raise exception 'invalid_choice'; end if;
  end if;
  if q.type = 'multiple_choice' then
    if answer_type <> 'array' or pg_catalog.jsonb_array_length(new.answer) not between 1 and 20 then
      raise exception 'invalid_choices';
    end if;
    if exists(select 1 from pg_catalog.jsonb_array_elements_text(new.answer) as choice(value)
      where choice.value not in (
        select opt.value from pg_catalog.jsonb_array_elements_text(q.options) as opt(value)
      )) then raise exception 'invalid_choices'; end if;
  end if;
  if q.type = 'number' and answer_type <> 'number' then raise exception 'invalid_number'; end if;
  if q.type = 'scale' then
    if answer_type <> 'number' then raise exception 'invalid_scale'; end if;
    if answer_text::numeric not between 1 and 5 then raise exception 'invalid_scale'; end if;
  end if;
  if q.type = 'yes_no' and answer_type <> 'boolean' then raise exception 'invalid_boolean'; end if;
  if q.type = 'date' then
    if answer_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'invalid_date'; end if;
    perform answer_text::date;
  end if;
  return new;
end;
$$;
revoke all on function private.validate_questionnaire_answer_value() from public, anon, authenticated;
create trigger questionnaire_answer_value_guard
before insert or update of answer on public.questionnaire_answers
for each row execute function private.validate_questionnaire_answer_value();
