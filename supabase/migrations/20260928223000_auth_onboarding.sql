-- Existing accounts already submitted their service and schedule during sign-up.
alter table public.workspaces add column onboarding_completed_at timestamptz;
update public.workspaces w set onboarding_completed_at=w.created_at
where exists(select 1 from public.services s where s.workspace_id=w.id)
  and exists(select 1 from public.availability_rules a where a.workspace_id=w.id);

-- A new Auth user gets one workspace and professional profile atomically.
-- The service and schedule are saved after confirmation in complete_bellis_onboarding.
create or replace function private.bootstrap_bellis_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(new.raw_user_meta_data,'{}'::jsonb);
  v_workspace uuid := gen_random_uuid();
begin
  if m->>'bellis_signup' is distinct from '1' then return new; end if;
  if nullif(trim(coalesce(new.email,'')),'') is null then raise exception 'email_required'; end if;
  if length(trim(coalesce(m->>'business',''))) not between 2 and 120 then raise exception 'business_required'; end if;
  if length(trim(coalesce(m->>'name',''))) not between 2 and 120 then raise exception 'name_required'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=coalesce(m->>'timezone',''))
    then raise exception 'invalid_timezone'; end if;

  insert into public.workspaces(id,name,slug,timezone)
  values(v_workspace,trim(m->>'business'),'bellis-'||replace(v_workspace::text,'-',''),m->>'timezone');
  insert into public.workspace_members(workspace_id,user_id,role)
  values(v_workspace,new.id,'owner');
  insert into public.professionals(workspace_id,user_id,display_name,specialty,province,city,practice_name,public_slug)
  values(v_workspace,new.id,trim(m->>'business'),left(coalesce(m->>'specialty','Otro'),80),
    left(coalesce(m->>'province',''),80),left(coalesce(m->>'city',''),80),trim(m->>'business'),
    'profesional-'||substr(replace(new.id::text,'-',''),1,12));
  return new;
end $$;

create function private.complete_bellis_onboarding(p_document jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_workspace uuid; v_professional uuid;
  v_done timestamptz; v_price integer; v_duration integer; v_notice integer; v_buffer integer;
  v_start time; v_end time; v_break_start time; v_break_end time; v_has_break boolean;
  v_day integer; v_days jsonb; v_name text; v_mode text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if pg_catalog.jsonb_typeof(p_document)<>'object' or pg_catalog.pg_column_size(p_document)>8192
    then raise exception 'invalid_onboarding'; end if;
  select w.id,w.onboarding_completed_at into v_workspace,v_done
  from public.workspaces w join public.workspace_members m on m.workspace_id=w.id
  where m.user_id=v_user and m.role='owner'
  order by m.created_at limit 1 for update of w;
  if v_workspace is null then raise exception 'workspace_missing'; end if;
  select id into v_professional from public.professionals
  where workspace_id=v_workspace and user_id=v_user order by created_at limit 1;
  if v_professional is null then raise exception 'professional_missing'; end if;
  if v_done is not null then return; end if;

  v_name := trim(coalesce(p_document->>'service',''));
  if length(v_name) not between 2 and 120
    or length(coalesce(p_document->>'description',''))>1000
    then raise exception 'invalid_service'; end if;
  if coalesce(p_document->>'price','') !~ '^[0-9]{1,7}$'
    or coalesce(p_document->>'duration','') !~ '^[0-9]{2,3}$'
    or coalesce(p_document->>'notice','') !~ '^[0-9]{1,3}$'
    or coalesce(p_document->>'buffer','') !~ '^[0-9]{1,3}$'
    then raise exception 'invalid_service'; end if;
  v_price := (p_document->>'price')::integer;
  v_duration := (p_document->>'duration')::integer;
  v_notice := (p_document->>'notice')::integer;
  v_buffer := (p_document->>'buffer')::integer;
  v_mode := p_document->>'mode';
  if v_price<1 or v_duration not between 15 and 480 or v_notice>720 or v_buffer>240
    or v_mode not in ('Online','Presencial','Ambas') then raise exception 'invalid_service'; end if;
  if coalesce(p_document->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_document->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_document->>'breakStart','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_document->>'breakEnd','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    then raise exception 'invalid_hours'; end if;
  v_start := (p_document->>'start')::time;
  v_end := (p_document->>'end')::time;
  v_break_start := (p_document->>'breakStart')::time;
  v_break_end := (p_document->>'breakEnd')::time;
  v_has_break := v_break_start>v_start and v_break_end<v_end and v_break_end>v_break_start;
  if v_start>=v_end then raise exception 'invalid_hours'; end if;
  if not v_has_break and not (v_break_start=v_break_end or v_break_start>=v_end or v_break_end<=v_start)
    then raise exception 'invalid_break'; end if;
  v_days := p_document->'days';
  if pg_catalog.jsonb_typeof(v_days)<>'array' or pg_catalog.jsonb_array_length(v_days)<>7
    or not exists(select 1 from pg_catalog.jsonb_array_elements(v_days) d where d.value='true'::jsonb)
    or exists(select 1 from pg_catalog.jsonb_array_elements(v_days) d where d.value not in ('true'::jsonb,'false'::jsonb))
    then raise exception 'invalid_days'; end if;

  if not exists(select 1 from public.services where workspace_id=v_workspace and professional_id=v_professional) then
    insert into public.services(workspace_id,professional_id,name,description,price_minor,duration_minutes,modality,min_notice_minutes)
    values(v_workspace,v_professional,v_name,nullif(trim(coalesce(p_document->>'description','')),''),v_price*100,v_duration,
      case v_mode when 'Presencial' then 'in_person' when 'Ambas' then 'both' else 'online' end,v_notice*60);
  end if;
  delete from public.availability_rules where workspace_id=v_workspace and professional_id=v_professional;
  for v_day in 0..6 loop
    if v_days->v_day='true'::jsonb then
      if v_has_break then
        insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
        values(v_workspace,v_professional,((v_day+1)%7)::smallint,v_start,v_break_start,v_buffer),
          (v_workspace,v_professional,((v_day+1)%7)::smallint,v_break_end,v_end,v_buffer);
      else
        insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
        values(v_workspace,v_professional,((v_day+1)%7)::smallint,v_start,v_end,v_buffer);
      end if;
    end if;
  end loop;
  update public.workspaces set onboarding_completed_at=now() where id=v_workspace;
end $$;
revoke all on function private.complete_bellis_onboarding(jsonb) from public,anon;
grant execute on function private.complete_bellis_onboarding(jsonb) to authenticated;

create function public.complete_bellis_onboarding(p_document jsonb)
returns void language sql security invoker set search_path = '' as $$
  select private.complete_bellis_onboarding(p_document);
$$;
revoke all on function public.complete_bellis_onboarding(jsonb) from public,anon;
grant execute on function public.complete_bellis_onboarding(jsonb) to authenticated;
