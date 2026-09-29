-- Reserve semantic activity types for later integrations without writing duplicate
-- appointment, payment, note or follow-up rows into this table today.
alter table public.patient_activities drop constraint patient_activities_type_check;
alter table public.patient_activities add constraint patient_activities_type_check
  check (type in ('note','follow_up_created','follow_up_completed','message_sent','call','email','whatsapp','other'));
drop policy patient_activities_insert on public.patient_activities;
create policy patient_activities_insert on public.patient_activities for insert to authenticated with check (
  type in ('call','email','whatsapp','other')
  and created_by=(select auth.uid()) and metadata='{}'::jsonb
  and exists(select 1 from public.patients p where p.workspace_id=patient_activities.workspace_id
    and p.id=patient_activities.patient_id and p.deleted_at is null)
  and (exists(select 1 from public.professionals pr where pr.workspace_id=patient_activities.workspace_id
    and pr.id=patient_activities.professional_id and pr.user_id=(select auth.uid()))
    or private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[]))
);
