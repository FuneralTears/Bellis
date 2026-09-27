-- RLS and SQL privileges are independent. Remove broad default Data API grants
-- before granting only the operations supported by Bellis policies.
revoke all on all tables in schema public from public, anon, authenticated;

grant select on public.workspaces, public.workspace_members, public.professionals,
  public.services, public.forms, public.form_questions, public.patients,
  public.booking_intents, public.payments, public.availability_rules,
  public.availability_blocks, public.appointments,
  public.questionnaires, public.questionnaire_sections,
  public.questionnaire_questions, public.questionnaire_answers to authenticated;

grant insert, update, delete on public.professionals, public.services, public.forms,
  public.availability_rules, public.availability_blocks,
  public.questionnaires, public.questionnaire_sections,
  public.questionnaire_questions to authenticated;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
