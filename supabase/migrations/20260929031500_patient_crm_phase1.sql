-- Bellis CRM phase 1. Existing patient and booking records remain in place.
create type public.patient_status as enum ('new','active','follow_up','inactive');
alter table public.patients add column status public.patient_status not null default 'new';
create index patients_crm_list on public.patients(workspace_id,status,created_at desc) where deleted_at is null;
create index appointments_patient_time on public.appointments(workspace_id,patient_id,starts_at desc);
create index intents_patient_time on public.booking_intents(workspace_id,patient_id,created_at desc);
create index answers_patient_time on public.questionnaire_answers(workspace_id,patient_id,created_at desc);
create index payments_intent_time on public.payments(workspace_id,booking_intent_id,created_at desc);

-- Only the status column can be changed through the authenticated Data API.
grant update(status) on public.patients to authenticated;
create policy patient_status_write on public.patients for update to authenticated
using (
  deleted_at is null and (
    private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
    or exists (select 1 from public.booking_intents i join public.professionals pr
      on pr.id=i.professional_id and pr.workspace_id=i.workspace_id
      where i.patient_id=patients.id and i.workspace_id=patients.workspace_id
        and pr.user_id=(select auth.uid()))
  )
)
with check (
  deleted_at is null and (
    private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
    or exists (select 1 from public.booking_intents i join public.professionals pr
      on pr.id=i.professional_id and pr.workspace_id=i.workspace_id
      where i.patient_id=patients.id and i.workspace_id=patients.workspace_id
        and pr.user_id=(select auth.uid()))
  )
);

create table public.patient_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  patient_id uuid not null,
  author_id uuid not null references auth.users(id),
  content text not null check (char_length(btrim(content)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id,patient_id) references public.patients(workspace_id,id) on delete cascade
);
create index patient_notes_patient_time on public.patient_notes(workspace_id,patient_id,created_at desc);
alter table public.patient_notes enable row level security;
grant select,insert on public.patient_notes to authenticated;
grant update(content) on public.patient_notes to authenticated;
grant all on public.patient_notes to service_role;

create policy patient_notes_read on public.patient_notes for select to authenticated using (
  exists(select 1 from public.patients p where p.id=patient_id and p.workspace_id=patient_notes.workspace_id and p.deleted_at is null)
);
create policy patient_notes_insert on public.patient_notes for insert to authenticated with check (
  author_id=(select auth.uid()) and
  exists(select 1 from public.patients p where p.id=patient_id and p.workspace_id=patient_notes.workspace_id and p.deleted_at is null)
);
create policy patient_notes_update on public.patient_notes for update to authenticated using (
  author_id=(select auth.uid()) and
  exists(select 1 from public.patients p where p.id=patient_id and p.workspace_id=patient_notes.workspace_id and p.deleted_at is null)
) with check (
  author_id=(select auth.uid()) and
  exists(select 1 from public.patients p where p.id=patient_id and p.workspace_id=patient_notes.workspace_id and p.deleted_at is null)
);

create function private.touch_patient_note() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
revoke all on function private.touch_patient_note() from public,anon,authenticated;
create trigger patient_note_updated before update on public.patient_notes
  for each row execute function private.touch_patient_note();

-- Reception can review payment status and preconsultations for patients it manages.
drop policy payment_read on public.payments;
create policy payment_read on public.payments for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.booking_intents i join public.professionals p
    on p.id=i.professional_id and p.workspace_id=i.workspace_id
    where i.id=booking_intent_id and i.workspace_id=payments.workspace_id and p.user_id=(select auth.uid()))
);
drop policy questionnaire_answer_read on public.questionnaire_answers;
create policy questionnaire_answer_read on public.questionnaire_answers for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.booking_intents i join public.professionals p
    on p.id=i.professional_id and p.workspace_id=i.workspace_id
    where i.id=booking_intent_id and i.workspace_id=questionnaire_answers.workspace_id and p.user_id=(select auth.uid()))
);

-- Invoker rights apply all underlying RLS policies. No stored aggregate is accepted from clients.
create view public.patient_crm_overview with (security_invoker=true) as
select p.id,p.workspace_id,p.first_name,p.last_name,p.email,p.phone,p.date_of_birth,
  p.status,p.created_at,
  concat_ws(' ',p.first_name,p.last_name) as full_name,
  a.last_turn,a.next_turn,coalesce(a.turn_count,0)::integer as turn_count,
  coalesce(pay.approved_total_minor,0)::bigint as approved_total_minor,
  w.currency_code
from public.patients p
join public.workspaces w on w.id=p.workspace_id
left join lateral (
  select max(starts_at) filter (where starts_at < now() and status <> 'cancelled') as last_turn,
    min(starts_at) filter (where starts_at >= now() and status='scheduled') as next_turn,
    count(*) as turn_count
  from public.appointments a where a.patient_id=p.id and a.workspace_id=p.workspace_id
) a on true
left join lateral (
  select sum(pm.amount_minor) as approved_total_minor
  from public.booking_intents i join public.payments pm
    on pm.booking_intent_id=i.id and pm.workspace_id=i.workspace_id
  where i.patient_id=p.id and i.workspace_id=p.workspace_id and pm.status='approved'
    and pm.currency_code=w.currency_code
) pay on true
where p.deleted_at is null;
revoke all on public.patient_crm_overview from public,anon;
grant select on public.patient_crm_overview to authenticated;
