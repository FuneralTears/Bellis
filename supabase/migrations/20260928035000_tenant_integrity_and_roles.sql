-- Bind every booking record to the same workspace as its referenced records.
alter table public.appointments add constraint appointments_workspace_id_id_unique unique(workspace_id,id);
alter table public.services add constraint services_workspace_professional_fk
  foreign key(workspace_id,professional_id) references public.professionals(workspace_id,id);
alter table public.availability_rules add constraint rules_workspace_professional_fk
  foreign key(workspace_id,professional_id) references public.professionals(workspace_id,id);
alter table public.availability_blocks add constraint blocks_workspace_professional_fk
  foreign key(workspace_id,professional_id) references public.professionals(workspace_id,id);
alter table public.booking_intents add constraint intents_workspace_professional_fk
  foreign key(workspace_id,professional_id) references public.professionals(workspace_id,id);
alter table public.booking_intents add constraint intents_workspace_service_fk
  foreign key(workspace_id,service_id) references public.services(workspace_id,id);
alter table public.booking_intents add constraint intents_workspace_patient_fk
  foreign key(workspace_id,patient_id) references public.patients(workspace_id,id);
alter table public.payments add constraint payments_workspace_intent_fk
  foreign key(workspace_id,booking_intent_id) references public.booking_intents(workspace_id,id);
alter table public.appointments add constraint appointments_workspace_intent_fk
  foreign key(workspace_id,booking_intent_id) references public.booking_intents(workspace_id,id);
alter table public.appointments add constraint appointments_workspace_professional_fk
  foreign key(workspace_id,professional_id) references public.professionals(workspace_id,id);
alter table public.appointments add constraint appointments_workspace_patient_fk
  foreign key(workspace_id,patient_id) references public.patients(workspace_id,id);
alter table public.notification_outbox add constraint notifications_workspace_appointment_fk
  foreign key(workspace_id,appointment_id) references public.appointments(workspace_id,id);

drop policy service_read on public.services;
create policy service_read on public.services for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.professionals p where p.id=professional_id and p.workspace_id=workspace_id
    and p.user_id=(select auth.uid())));
create policy service_professional_write on public.services for all to authenticated
  using (exists(select 1 from public.professionals p where p.id=professional_id and p.workspace_id=workspace_id
    and p.user_id=(select auth.uid())))
  with check (exists(select 1 from public.professionals p where p.id=professional_id and p.workspace_id=workspace_id
    and p.user_id=(select auth.uid())));

drop policy availability_read on public.availability_rules;
create policy availability_read on public.availability_rules for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.professionals p where p.id=professional_id and p.workspace_id=workspace_id
    and p.user_id=(select auth.uid())));
create policy availability_professional_write on public.availability_rules for all to authenticated
  using (exists(select 1 from public.professionals p where p.id=professional_id and p.workspace_id=workspace_id
    and p.user_id=(select auth.uid())))
  with check (exists(select 1 from public.professionals p where p.id=professional_id and p.workspace_id=workspace_id
    and p.user_id=(select auth.uid())));

drop policy payment_read on public.payments;
create policy payment_read on public.payments for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])
  or exists(select 1 from public.booking_intents i join public.professionals p
    on p.id=i.professional_id and p.workspace_id=i.workspace_id
    where i.id=booking_intent_id and i.workspace_id=payments.workspace_id and p.user_id=(select auth.uid())));

drop policy patient_read on public.patients;
create policy patient_read on public.patients for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.booking_intents i join public.professionals p
    on p.id=i.professional_id and p.workspace_id=i.workspace_id
    where i.patient_id=patients.id and i.workspace_id=patients.workspace_id and p.user_id=(select auth.uid())));

create policy professional_self_update on public.professionals for update to authenticated
  using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
-- Prevent owner/profile edits from moving a professional to another tenant or user.
create function private.prevent_professional_reparent()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.workspace_id<>old.workspace_id or new.user_id is distinct from old.user_id
    then raise exception 'professional_identity_immutable'; end if;
  return new;
end $$;
revoke all on function private.prevent_professional_reparent() from public,anon,authenticated;
create trigger professional_identity_guard before update on public.professionals
for each row execute function private.prevent_professional_reparent();

drop policy audit_actor_insert on public.audit_events;
create policy audit_actor_insert on public.audit_events for insert to authenticated
  with check (actor_user_id=(select auth.uid()) and (
    private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])
    or (object_type='professional' and exists(select 1 from public.professionals p
      where p.id=object_id and p.workspace_id=audit_events.workspace_id and p.user_id=(select auth.uid())))));

create or replace function public.save_weekly_availability(p_professional uuid,p_rules jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_workspace uuid; v_item jsonb;
begin
  select workspace_id into v_workspace from public.professionals where id=p_professional;
  if v_workspace is null or not (
    private.has_workspace_role(v_workspace,array['owner','admin']::public.workspace_role[])
    or exists(select 1 from public.professionals p where p.id=p_professional and p.user_id=(select auth.uid())))
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
