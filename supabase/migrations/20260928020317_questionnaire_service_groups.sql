-- One editable form can be associated with several services. Each service still
-- receives its own versioned questionnaire, so historic patient answers are stable.
alter table public.questionnaires
  add column form_group_id uuid not null default gen_random_uuid();
create index questionnaires_active_form_group_idx
  on public.questionnaires (form_group_id, service_id) where active;

create function public.save_questionnaire_for_services(
  p_group uuid, p_services uuid[], p_document jsonb
) returns uuid[] language plpgsql security invoker set search_path = '' as $$
declare
  v_services uuid[];
  v_service uuid;
  v_workspace uuid;
  v_existing_workspace uuid;
  v_id uuid;
  v_ids uuid[] := array[]::uuid[];
begin
  if (select auth.uid()) is null then raise exception 'authentication_required'; end if;
  if p_group is null then raise exception 'group_required'; end if;
  select array_agg(distinct item order by item) into v_services
  from unnest(p_services) as item where item is not null;
  if coalesce(array_length(v_services,1),0) not between 1 and 20
    then raise exception 'invalid_services'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_group::text, 1));
  select q.workspace_id into v_existing_workspace
  from public.questionnaires q where q.form_group_id=p_group limit 1;
  foreach v_service in array v_services loop
    select s.workspace_id into v_workspace from public.services s where s.id=v_service and s.active;
    if v_workspace is null then raise exception 'service_not_found'; end if;
    if v_existing_workspace is not null and v_workspace <> v_existing_workspace
      then raise exception 'different_workspace'; end if;
    if v_existing_workspace is null then v_existing_workspace := v_workspace; end if;
    v_id := public.save_questionnaire(v_service,p_document);
    update public.questionnaires set form_group_id=p_group where id=v_id;
    v_ids := array_append(v_ids,v_id);
  end loop;
  -- Removing a service from this form withdraws that association only. Its
  -- historical versions and answers remain intact.
  update public.questionnaires q set active=false,updated_at=now()
  where q.form_group_id=p_group and q.active and not (q.service_id=any(v_services));
  return v_ids;
end;
$$;
revoke all on function public.save_questionnaire_for_services(uuid,uuid[],jsonb) from public, anon;
grant execute on function public.save_questionnaire_for_services(uuid,uuid[],jsonb) to authenticated;
