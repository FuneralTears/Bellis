-- Apply after 202609260001_bellis_core.sql in the Bellis Supabase project.
-- This migration is additive; the earlier forms/form_questions/form_answers tables remain untouched.
create type public.questionnaire_question_type as enum
  ('single_choice','multiple_choice','text','long_text','number','yes_no','scale','date');

alter table public.professionals add constraint professionals_workspace_id_id_unique unique (workspace_id,id);
alter table public.services add constraint services_workspace_id_id_unique unique (workspace_id,id);
alter table public.patients add constraint patients_workspace_id_id_unique unique (workspace_id,id);
alter table public.booking_intents add constraint booking_intents_workspace_id_id_unique unique (workspace_id,id);

create table public.questionnaires (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  professional_id uuid not null,
  service_id uuid not null,
  title text not null default 'Preconsulta',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id,id),
  foreign key (workspace_id,professional_id) references public.professionals(workspace_id,id) on delete cascade,
  foreign key (workspace_id,service_id) references public.services(workspace_id,id) on delete cascade
);
create unique index questionnaires_one_active_per_service
  on public.questionnaires(service_id) where active;

create table public.questionnaire_sections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  questionnaire_id uuid not null,
  section_key text not null check (section_key in ('situation','problem','implication','need')),
  visible_name text not null,
  sort_order integer not null check (sort_order >= 0),
  unique (workspace_id,questionnaire_id,section_key),
  unique (questionnaire_id,sort_order),
  foreign key (workspace_id,questionnaire_id) references public.questionnaires(workspace_id,id) on delete cascade
);

create table public.questionnaire_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  questionnaire_id uuid not null,
  section_key text not null,
  title text not null,
  description text,
  type public.questionnaire_question_type not null,
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  required boolean not null default false,
  sort_order integer not null check (sort_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id,questionnaire_id,id),
  unique (questionnaire_id,sort_order),
  foreign key (workspace_id,questionnaire_id,section_key)
    references public.questionnaire_sections(workspace_id,questionnaire_id,section_key) on delete cascade
);

create table public.questionnaire_answers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  questionnaire_id uuid not null,
  question_id uuid not null,
  booking_intent_id uuid not null,
  patient_id uuid not null,
  answer jsonb not null,
  created_at timestamptz not null default now(),
  unique (booking_intent_id,question_id),
  foreign key (workspace_id,questionnaire_id,question_id)
    references public.questionnaire_questions(workspace_id,questionnaire_id,id),
  foreign key (workspace_id,booking_intent_id) references public.booking_intents(workspace_id,id) on delete cascade,
  foreign key (workspace_id,patient_id) references public.patients(workspace_id,id) on delete cascade
);

create index questionnaire_questions_order on public.questionnaire_questions(questionnaire_id,sort_order) where active;
create index questionnaire_answers_intent on public.questionnaire_answers(booking_intent_id);
create index questionnaire_answers_workspace on public.questionnaire_answers(workspace_id,created_at);

-- Keep every questionnaire bound to the professional who owns its service.
create function public.validate_questionnaire_service()
returns trigger language plpgsql set search_path = '' as $$
declare service_professional uuid;
begin
  select s.professional_id into service_professional
  from public.services s where s.id = new.service_id and s.workspace_id = new.workspace_id;
  if service_professional is null or service_professional <> new.professional_id then
    raise exception 'questionnaire_service_mismatch';
  end if;
  return new;
end;
$$;
create trigger questionnaire_service_guard before insert or update on public.questionnaires
for each row execute function public.validate_questionnaire_service();

-- An answer must belong to the same patient, intent and service as its question.
create function public.validate_questionnaire_answer()
returns trigger language plpgsql set search_path = '' as $$
declare intent_patient uuid; intent_service uuid; questionnaire_service uuid;
begin
  select i.patient_id, i.service_id into intent_patient, intent_service
  from public.booking_intents i where i.id = new.booking_intent_id and i.workspace_id = new.workspace_id;
  select q.service_id into questionnaire_service
  from public.questionnaires q where q.id = new.questionnaire_id and q.workspace_id = new.workspace_id;
  if intent_patient is null or questionnaire_service is null
     or intent_patient <> new.patient_id or intent_service <> questionnaire_service then
    raise exception 'questionnaire_answer_mismatch';
  end if;
  return new;
end;
$$;
create trigger questionnaire_answer_guard before insert or update on public.questionnaire_answers
for each row execute function public.validate_questionnaire_answer();

create function public.can_manage_questionnaire(target_workspace uuid, target_questionnaire uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.questionnaires q
    join public.professionals p on p.id = q.professional_id and p.workspace_id = q.workspace_id
    where q.id = target_questionnaire and q.workspace_id = target_workspace
      and (
        public.has_workspace_role(target_workspace,array['owner','admin']::public.workspace_role[])
        or p.user_id = (select auth.uid())
      )
  );
$$;
revoke all on function public.can_manage_questionnaire(uuid,uuid) from public;
grant execute on function public.can_manage_questionnaire(uuid,uuid) to authenticated;

alter table public.questionnaires enable row level security;
alter table public.questionnaire_sections enable row level security;
alter table public.questionnaire_questions enable row level security;
alter table public.questionnaire_answers enable row level security;

create policy questionnaire_read on public.questionnaires for select to authenticated
  using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy questionnaire_insert on public.questionnaires for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])
    or exists(select 1 from public.professionals p where p.id=questionnaires.professional_id and p.workspace_id=questionnaires.workspace_id and p.user_id=(select auth.uid()))
  );
create policy questionnaire_update on public.questionnaires for update to authenticated
  using (public.can_manage_questionnaire(workspace_id,id))
  with check (public.can_manage_questionnaire(workspace_id,id));
create policy questionnaire_delete on public.questionnaires for delete to authenticated
  using (public.can_manage_questionnaire(workspace_id,id));

create policy questionnaire_section_read on public.questionnaire_sections for select to authenticated
  using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy questionnaire_section_insert on public.questionnaire_sections for insert to authenticated
  with check (public.can_manage_questionnaire(workspace_id,questionnaire_id));
create policy questionnaire_section_update on public.questionnaire_sections for update to authenticated
  using (public.can_manage_questionnaire(workspace_id,questionnaire_id))
  with check (public.can_manage_questionnaire(workspace_id,questionnaire_id));
create policy questionnaire_section_delete on public.questionnaire_sections for delete to authenticated
  using (public.can_manage_questionnaire(workspace_id,questionnaire_id));

create policy questionnaire_question_read on public.questionnaire_questions for select to authenticated
  using (public.has_workspace_role(workspace_id,array['owner','admin','professional','reception']::public.workspace_role[]));
create policy questionnaire_question_insert on public.questionnaire_questions for insert to authenticated
  with check (public.can_manage_questionnaire(workspace_id,questionnaire_id));
create policy questionnaire_question_update on public.questionnaire_questions for update to authenticated
  using (public.can_manage_questionnaire(workspace_id,questionnaire_id))
  with check (public.can_manage_questionnaire(workspace_id,questionnaire_id));
create policy questionnaire_question_delete on public.questionnaire_questions for delete to authenticated
  using (public.can_manage_questionnaire(workspace_id,questionnaire_id));

create policy questionnaire_answer_read on public.questionnaire_answers for select to authenticated
  using (
    public.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[])
    or exists (
      select 1 from public.booking_intents i
      join public.professionals p on p.id=i.professional_id and p.workspace_id=i.workspace_id
      where i.id=questionnaire_answers.booking_intent_id and i.workspace_id=questionnaire_answers.workspace_id and p.user_id=(select auth.uid())
    )
  );

-- No anonymous or authenticated insert/update/delete policy exists for answers.
-- A trusted server-side endpoint must validate each answer and use a service-role
-- transaction. Never send the service key to a browser or log answer bodies.
