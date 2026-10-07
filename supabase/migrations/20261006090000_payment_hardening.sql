-- Payment hardening (G7A). No new tables or columns: one read-only check, one cleanup task and a stricter
-- version of the function that records a verified Mercado Pago payment. Every statement can be run again.

-- Whether a workspace can take Mercado Pago payments right now, without reading its token from Vault.
-- Same rule as the status the panel shows: past its expiry with nothing to renew it is not connected.
create or replace function public.mercado_pago_checkout_ready(p_workspace uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.mercado_pago_accounts a
    where a.workspace_id=p_workspace and a.status='connected'
      and not (a.token_expires_at<now() and a.refresh_token_secret_id is null));
$$;
revoke all on function public.mercado_pago_checkout_ready(uuid) from public, anon, authenticated;
grant execute on function public.mercado_pago_checkout_ready(uuid) to service_role;

-- Closes requests that ran out of time without a payment. Safe to run at any moment and as often as wanted:
-- a request is closed once, nothing is deleted, and a paid request is never touched.
-- The request becomes 'cancelled' and its payment 'expired', which is what tells it apart from any other cancellation.
create or replace function public.expire_stale_booking_intents(p_limit integer default 500)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
  with stale as (
    select i.id from public.booking_intents i
    where i.status='pending_payment' and i.expires_at<now()
      and not exists(select 1 from public.payments p where p.booking_intent_id=i.id and p.status in ('approved','refunded'))
    order by i.expires_at limit greatest(1,least(coalesce(p_limit,500),5000))
    for update skip locked),
  closed as (
    update public.booking_intents i set status='cancelled' from stale s where i.id=s.id
    returning i.id,i.workspace_id),
  unpaid as (
    update public.payments p set status='expired' from closed c
    where p.booking_intent_id=c.id and p.status not in ('approved','refunded') returning 1),
  logged as (
    insert into public.audit_events(workspace_id,action,object_type,object_id)
    select c.workspace_id,'booking_intent_expired','booking_intent',c.id from closed c returning 1)
  select count(*) into v_count from closed;
  return v_count;
end $$;
revoke all on function public.expire_stale_booking_intents(integer) from public, anon, authenticated;
grant execute on function public.expire_stale_booking_intents(integer) to service_role;

-- Atomic, idempotent transition. Browser-return fields never call this RPC.
-- Late payments: a payment that Mercado Pago approves after the request ran out of time, or after it was closed
-- for any reason, is recorded as approved with its payment id, and nothing else moves: the request stays closed,
-- no time can be chosen from it and no appointment is created. 'mercado_pago_late_payment_approved' is left on
-- the request for a person to review. Nothing is refunded from here.
create or replace function public.record_mercado_pago_payment(
  p_intent uuid,p_preference text,p_payment_id text,p_event_id text,
  p_status public.payment_status,p_amount_minor integer,p_currency char(3)
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_payment public.payments%rowtype;
begin
  if length(p_payment_id) not between 1 and 100 or length(p_event_id) not between 1 and 150
    then raise exception 'invalid_provider_reference'; end if;
  select * into v_intent from public.booking_intents where id=p_intent for update;
  select * into v_payment from public.payments where booking_intent_id=p_intent for update;
  if not found or v_payment.provider<>'mercado_pago_ar' or v_payment.workspace_id<>v_intent.workspace_id
    or v_payment.provider_order_id is distinct from p_preference
    or p_amount_minor<>v_intent.price_minor or p_currency<>v_intent.currency_code
    or v_payment.amount_minor<>v_intent.price_minor or v_payment.currency_code<>v_intent.currency_code
    then raise exception 'payment_mismatch'; end if;
  if v_payment.status=p_status then return false; end if;
  if v_payment.status='approved' and p_status<>'refunded' then return false; end if;
  if v_payment.status='refunded' then return false; end if;
  -- Once a request was closed for running out of time, only an approved payment changes its payment again.
  if v_payment.status='expired' and p_status<>'approved' then return false; end if;
  if p_status='refunded' and (v_payment.status<>'approved' or v_payment.provider_payment_id<>p_payment_id)
    then raise exception 'refund_mismatch'; end if;
  update public.payments set status=p_status,provider_payment_id=p_payment_id,
    provider_event_id=p_event_id,approved_at=case when p_status='approved' then now() else approved_at end
    where id=v_payment.id;
  if p_status='approved' and v_intent.status='pending_payment' and v_intent.expires_at>=now() then
    update public.booking_intents set status='awaiting_schedule',expires_at=greatest(expires_at,now()+interval '30 days')
      where id=p_intent;
  elsif p_status='approved' then
    -- Past its date but not closed by the cleanup yet: closed here, so it reads the same either way.
    if v_intent.status='pending_payment' then
      update public.booking_intents set status='cancelled' where id=p_intent;
      insert into public.audit_events(workspace_id,action,object_type,object_id)
      values(v_intent.workspace_id,'booking_intent_expired','booking_intent',p_intent);
    end if;
    insert into public.audit_events(workspace_id,action,object_type,object_id)
    values(v_intent.workspace_id,'mercado_pago_late_payment_approved','booking_intent',p_intent);
  elsif p_status='refunded' then
    update public.booking_intents set status='refunded' where id=p_intent;
    update public.appointments set status='cancelled' where booking_intent_id=p_intent and status='scheduled';
  end if;
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(v_intent.workspace_id,'mercado_pago_'||p_status::text,'payment',v_payment.id);
  return true;
end $$;
