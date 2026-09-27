-- Keep RLS helper functions outside the exposed public API schema.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter function public.has_workspace_role(uuid, public.workspace_role[]) set schema private;
alter function public.can_manage_questionnaire(uuid, uuid) set schema private;

create or replace function private.can_manage_questionnaire(target_workspace uuid, target_questionnaire uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.questionnaires q
    join public.professionals p on p.id = q.professional_id and p.workspace_id = q.workspace_id
    where q.id = target_questionnaire and q.workspace_id = target_workspace
      and (
        private.has_workspace_role(target_workspace,array['owner','admin']::public.workspace_role[])
        or p.user_id = (select auth.uid())
      )
  );
$$;

revoke all on function private.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
revoke all on function private.can_manage_questionnaire(uuid, uuid) from public, anon;
grant execute on function private.has_workspace_role(uuid, public.workspace_role[]) to authenticated;
grant execute on function private.can_manage_questionnaire(uuid, uuid) to authenticated;
