-- Create a workspace for a professional who registered through Bellis.
create function private.bootstrap_bellis_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_workspace uuid := gen_random_uuid();
  v_professional uuid;
  v_price integer;
  v_duration integer;
  v_day integer;
  v_start time;
  v_end time;
begin
  if m->>'bellis_signup' is distinct from '1' then return new; end if;
  if nullif(trim(coalesce(new.email,'')), '') is null then raise exception 'email_required'; end if;
  if length(trim(coalesce(m->>'business',''))) not between 2 and 120 then raise exception 'business_required'; end if;
  if length(trim(coalesce(m->>'name',''))) not between 2 and 120 then raise exception 'name_required'; end if;
  if length(trim(coalesce(m->>'service',''))) not between 2 and 120 then raise exception 'service_required'; end if;
  if coalesce(m->>'price','') !~ '^[0-9]{1,7}$' then raise exception 'invalid_price'; end if;
  v_price := (m->>'price')::integer * 100;
  if coalesce(m->>'duration','') !~ '^[0-9]{2,3}$' then raise exception 'invalid_duration'; end if;
  v_duration := (m->>'duration')::integer;
  if v_duration not between 15 and 480 then raise exception 'invalid_duration'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = coalesce(m->>'timezone','')) then raise exception 'invalid_timezone'; end if;
  if coalesce(m->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(m->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'invalid_hours'; end if;
  v_start := (m->>'start')::time;
  v_end := (m->>'end')::time;
  if v_end <= v_start then raise exception 'invalid_hours'; end if;

  insert into public.workspaces(id,name,slug,timezone)
  values(v_workspace,trim(m->>'business'),'bellis-' || replace(v_workspace::text,'-',''),m->>'timezone');
  insert into public.workspace_members(workspace_id,user_id,role)
  values(v_workspace,new.id,'owner');
  insert into public.professionals(workspace_id,user_id,display_name,specialty,province,city,practice_name,public_slug)
  values(v_workspace,new.id,trim(m->>'business'),left(coalesce(m->>'specialty','Otro'),80),
    left(coalesce(m->>'province',''),80),left(coalesce(m->>'city',''),80),trim(m->>'business'),
    'profesional-' || substr(replace(new.id::text,'-',''),1,12))
  returning id into v_professional;
  insert into public.services(workspace_id,professional_id,name,description,price_minor,duration_minutes,modality,min_notice_minutes)
  values(v_workspace,v_professional,trim(m->>'service'),left(coalesce(m->>'description',''),1000),v_price,v_duration,
    case m->>'mode' when 'Presencial' then 'in_person' when 'Ambas' then 'both' else 'online' end,
    greatest(0,least(coalesce(nullif(m->>'notice','')::integer,24),720))*60);

  for v_day in 0..6 loop
    if coalesce(m->'days'->>v_day,'false') = 'true' then
      insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
      values(v_workspace,v_professional,((v_day+1)%7)::smallint,v_start,v_end,
        greatest(0,least(coalesce(nullif(m->>'buffer','')::integer,0),240)));
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.bootstrap_bellis_user() from public, anon, authenticated;
create trigger on_auth_user_created_bellis after insert on auth.users
for each row execute function private.bootstrap_bellis_user();

-- Version the form on each save, retaining questions already referenced by answers.
create function public.save_questionnaire(p_service uuid, p_document jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace uuid;
  v_professional uuid;
  v_id uuid;
  v_sections jsonb := p_document->'sections';
  v_questions jsonb := p_document->'questions';
  v_item jsonb;
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
  if pg_catalog.pg_column_size(p_document) > 65536 then raise exception 'questionnaire_too_large'; end if;
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
    insert into public.questionnaire_questions(workspace_id,questionnaire_id,section_key,title,description,type,options,required,sort_order,active)
    values(v_workspace,v_id,v_section,trim(v_item->>'title'),nullif(trim(coalesce(v_item->>'description','')),''),
      v_type,v_options,coalesce((v_item->>'required')::boolean,false),v_order,
      coalesce((v_item->>'active')::boolean,true));
  end loop;
  if not exists(select 1 from public.questionnaire_questions where questionnaire_id=v_id and active)
    then raise exception 'active_question_required'; end if;

  update public.questionnaires set active=false,updated_at=now()
  where service_id=p_service and active;
  update public.questionnaires set active=true,updated_at=now() where id=v_id;
  return v_id;
end;
$$;
revoke all on function public.save_questionnaire(uuid,jsonb) from public, anon;
grant execute on function public.save_questionnaire(uuid,jsonb) to authenticated;
