-- Las señales son derivadas: turnos, pagos y seguimientos siguen siendo la fuente de verdad.
-- Una vista invoker conserva la RLS de cada tabla y no persiste datos clínicos nuevos.
create view public.patient_follow_up_opportunities with (security_invoker=true) as
select crm.*,
  coalesce(turns.completed_count,0)::integer as completed_turn_count,
  turns.last_completed_turn,
  coalesce(payments_due.pending_count,0)::integer as pending_payment_count,
  coalesce(follow_ups.overdue_count,0)::integer as overdue_follow_up_count,
  (coalesce(turns.completed_count,0) > 0 and crm.next_turn is null) as without_next_turn,
  (coalesce(turns.completed_count,0) = 1 and crm.next_turn is null) as first_completed_without_next,
  (turns.last_completed_turn < now() - interval '60 days' and crm.next_turn is null) as inactive_after_care,
  (coalesce(payments_due.pending_count,0) > 0) as has_pending_payment,
  (coalesce(follow_ups.overdue_count,0) > 0) as has_overdue_follow_up,
  (crm.next_turn is not null) as has_upcoming_turn,
  (crm.created_at >= now() - interval '30 days' and coalesce(turns.completed_count,0)=0) as is_new_patient,
  (coalesce(turns.completed_count,0) >= 2) as is_recurrent_patient
from public.patient_crm_overview crm
join public.workspaces w on w.id=crm.workspace_id
left join lateral (
  select count(*) as completed_count, max(a.starts_at) as last_completed_turn
  from public.appointments a
  where a.workspace_id=crm.workspace_id and a.patient_id=crm.id
    and a.status='completed' and a.starts_at < now()
) turns on true
left join lateral (
  select count(distinct i.id) as pending_count
  from public.booking_intents i
  join public.payments pm on pm.booking_intent_id=i.id and pm.workspace_id=i.workspace_id
  where i.workspace_id=crm.workspace_id and i.patient_id=crm.id
    and i.status='pending_payment' and i.expires_at > now() and pm.status='pending'
    and not exists (
      select 1 from public.payments approved
      where approved.booking_intent_id=i.id and approved.workspace_id=i.workspace_id
        and approved.status='approved'
    )
) payments_due on true
left join lateral (
  select count(*) as overdue_count
  from public.patient_follow_ups f
  where f.workspace_id=crm.workspace_id and f.patient_id=crm.id
    and f.status='pending' and f.due_date < (now() at time zone w.timezone)::date
) follow_ups on true;

revoke all on public.patient_follow_up_opportunities from public,anon;
grant select on public.patient_follow_up_opportunities to authenticated;
