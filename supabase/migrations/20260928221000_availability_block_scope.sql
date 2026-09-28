-- A professional may only read or change their own blocks. Reception can
-- manage the shared agenda; owners and admins retain workspace-wide access.
drop policy block_read on public.availability_blocks;
create policy block_read on public.availability_blocks for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.professionals p
    where p.id=professional_id and p.workspace_id=availability_blocks.workspace_id
      and p.user_id=(select auth.uid())));

drop policy block_write on public.availability_blocks;
create policy block_write on public.availability_blocks for all to authenticated
  using (
    private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
    or exists(select 1 from public.professionals p
      where p.id=professional_id and p.workspace_id=availability_blocks.workspace_id
        and p.user_id=(select auth.uid())))
  with check (
    private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
    or exists(select 1 from public.professionals p
      where p.id=professional_id and p.workspace_id=availability_blocks.workspace_id
        and p.user_id=(select auth.uid())));
