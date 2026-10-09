-- Runs the cleanup of requests that ran out of time without a payment, every 15 minutes.
-- Needs migration 20261006090000_payment_hardening.sql (the function) and pg_cron (already used by the automations).
--
-- What it can change: a request in 'pending_payment' whose expires_at is in the past and that has no approved or
-- refunded payment becomes 'cancelled', its payment 'expired', and 'booking_intent_expired' is audited. Once.
-- What it never touches: awaiting_schedule, payment_confirmed, scheduled, completed, refunded, or anything paid.
-- Nothing is deleted.
--
-- Security: the job runs inside the database as its owner, with no network call and no secret. The function is
-- security invoker with an empty search_path, executable only by service_role and the owner; the job adds no grant.
-- At most 500 requests per run, locked with SKIP LOCKED, so a run never waits on a payment being recorded.
--
-- No loop: the only trigger the cleanup fires is payment_automation_enqueue, which acts on payments entering
-- 'pending' and ignores 'expired'. A closed request no longer matches the filter, so the next run skips it.
--
-- cron.schedule replaces a job of the same name: running this file again changes nothing.
do $$ begin
  if to_regprocedure('public.expire_stale_booking_intents(integer)') is null
    then raise exception 'expire_stale_booking_intents is missing: apply 20261006090000_payment_hardening first'; end if;
end $$;
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('bellis-expire-booking-intents','*/15 * * * *','select public.expire_stale_booking_intents()');

-- To check:      select jobname,schedule,active from cron.job where jobname='bellis-expire-booking-intents';
--                select status,return_message,start_time from cron.job_run_details d join cron.job j using(jobid)
--                  where j.jobname='bellis-expire-booking-intents' order by start_time desc limit 5;
-- To deactivate: select cron.unschedule('bellis-expire-booking-intents');
