-- H3.1A.1, sign-in with Google. A person who signs up with Google arrives without the sign-up form in their metadata,
-- so the sign-up trigger creates nothing for them. They complete their Bellis account afterwards, with the same data
-- the form asks for, through the same function the trigger uses. Nothing here writes to the auth schema.

-- One place that creates a Bellis account: workspace, owner membership and professional profile, as the trigger did.
create function private.create_bellis_account(p_user uuid,p_email text,m jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_workspace uuid := gen_random_uuid();
begin
  if p_user is null then raise exception 'authentication_required'; end if;
  if nullif(trim(coalesce(p_email,'')),'') is null then raise exception 'email_required'; end if;
  if length(trim(coalesce(m->>'business',''))) not between 2 and 120 then raise exception 'business_required'; end if;
  if length(trim(coalesce(m->>'name',''))) not between 2 and 120 then raise exception 'name_required'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=coalesce(m->>'timezone',''))
    then raise exception 'invalid_timezone'; end if;

  insert into public.workspaces(id,name,slug,timezone)
  values(v_workspace,trim(m->>'business'),'bellis-'||replace(v_workspace::text,'-',''),m->>'timezone');
  insert into public.workspace_members(workspace_id,user_id,role)
  values(v_workspace,p_user,'owner');
  insert into public.professionals(workspace_id,user_id,display_name,specialty,province,city,practice_name,public_slug)
  values(v_workspace,p_user,trim(m->>'business'),left(coalesce(m->>'specialty','Otro'),80),
    left(coalesce(m->>'province',''),80),left(coalesce(m->>'city',''),80),trim(m->>'business'),
    'profesional-'||substr(replace(p_user::text,'-',''),1,12));
  return v_workspace;
end $$;
revoke all on function private.create_bellis_account(uuid,text,jsonb) from public, anon, authenticated;

-- The sign-up trigger: exactly what it did before, now through create_bellis_account.
create or replace function private.bootstrap_bellis_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(new.raw_user_meta_data,'{}'::jsonb);
begin
  if m->>'bellis_signup' is distinct from '1' then return new; end if;
  perform private.create_bellis_account(new.id,new.email,m);
  return new;
end $$;

-- Completes the Bellis account of the signed-in person who has none yet (signed up with Google). The person is the
-- session, never the request. Idempotent and safe with two tabs or a repeated request: under a per-person lock, an
-- existing membership is returned as it is and nothing is created. Only for a confirmed email: an account Google did
-- not verify gets no Bellis account. The document carries the sign-up form's fields only.
create function public.complete_bellis_account(p_document jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_email text; v_confirmed timestamptz; v_workspace uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_document is null or pg_catalog.jsonb_typeof(p_document)<>'object' or pg_catalog.pg_column_size(p_document)>4096
    then raise exception 'invalid_account'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bellis_account:'||v_user::text,0));
  select m.workspace_id into v_workspace from public.workspace_members m where m.user_id=v_user order by m.created_at limit 1;
  if v_workspace is not null then return v_workspace; end if;
  select u.email,u.email_confirmed_at into v_email,v_confirmed from auth.users u where u.id=v_user;
  if v_confirmed is null then raise exception 'email_not_verified'; end if;
  return private.create_bellis_account(v_user,v_email,pg_catalog.jsonb_build_object(
    'name',p_document->>'name','business',p_document->>'business','specialty',p_document->>'specialty',
    'province',p_document->>'province','city',p_document->>'city','timezone',p_document->>'timezone'));
end $$;
revoke all on function public.complete_bellis_account(jsonb) from public, anon;
grant execute on function public.complete_bellis_account(jsonb) to authenticated;
