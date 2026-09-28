create function public.save_weekly_availability(p_professional uuid,p_rules jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_workspace uuid; v_item jsonb;
begin
  select workspace_id into v_workspace from public.professionals where id=p_professional;
  if v_workspace is null or not private.has_workspace_role(v_workspace,array['owner','admin']::public.workspace_role[])
    then raise exception 'not_authorized'; end if;
  if pg_catalog.jsonb_typeof(p_rules)<>'array' or pg_catalog.jsonb_array_length(p_rules)>21
    then raise exception 'invalid_rules'; end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_rules) loop
    if coalesce(v_item->>'weekday','') !~ '^[0-6]$'
      or coalesce(v_item->>'starts_at','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or coalesce(v_item->>'ends_at','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or (v_item->>'starts_at')::time >= (v_item->>'ends_at')::time
      or coalesce(v_item->>'buffer_minutes','') !~ '^[0-9]{1,3}$'
      or (v_item->>'buffer_minutes')::integer > 240 then raise exception 'invalid_rule'; end if;
  end loop;
  delete from public.availability_rules where professional_id=p_professional and workspace_id=v_workspace;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_rules) loop
    insert into public.availability_rules(workspace_id,professional_id,weekday,starts_at,ends_at,buffer_minutes)
    values(v_workspace,p_professional,(v_item->>'weekday')::smallint,(v_item->>'starts_at')::time,
      (v_item->>'ends_at')::time,(v_item->>'buffer_minutes')::integer);
  end loop;
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_workspace,(select auth.uid()),'availability_updated','professional',p_professional);
end $$;
revoke all on function public.save_weekly_availability(uuid,jsonb) from public,anon;
grant execute on function public.save_weekly_availability(uuid,jsonb) to authenticated;

-- The invoker needs only to write their own audit event through this RPC.
grant insert on public.audit_events to authenticated;
create policy audit_actor_insert on public.audit_events for insert to authenticated
  with check (actor_user_id=(select auth.uid()) and
    private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
