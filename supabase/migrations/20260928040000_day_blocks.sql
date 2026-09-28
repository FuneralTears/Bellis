create function public.block_professional_day(p_professional uuid,p_day date,p_reason text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_workspace uuid; v_timezone text; v_id uuid;
begin
  select p.workspace_id,w.timezone into v_workspace,v_timezone
  from public.professionals p join public.workspaces w on w.id=p.workspace_id
  where p.id=p_professional;
  if v_workspace is null or not (
    private.has_workspace_role(v_workspace,array['owner','admin','reception']::public.workspace_role[])
    or exists(select 1 from public.professionals p where p.id=p_professional and p.user_id=(select auth.uid())))
    then raise exception 'not_authorized'; end if;
  if p_day < current_date - 1 or p_day > current_date + 730 then raise exception 'invalid_block_day'; end if;
  insert into public.availability_blocks(workspace_id,professional_id,starts_at,ends_at,reason)
  values(v_workspace,p_professional,p_day::timestamp at time zone v_timezone,
    (p_day+1)::timestamp at time zone v_timezone,left(coalesce(nullif(trim(p_reason),''),'Día bloqueado'),120))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.block_professional_day(uuid,date,text) from public,anon;
grant execute on function public.block_professional_day(uuid,date,text) to authenticated;
