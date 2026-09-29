-- Mercado Pago uses the existing intent/payment lifecycle. Seller tokens stay in Vault.
create table private.mercado_pago_accounts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  seller_user_id text not null,
  access_token_secret_id uuid not null,
  environment text not null check (environment in ('test','production')),
  active boolean not null default true,
  connected_at timestamptz not null default now()
);
alter table private.mercado_pago_accounts enable row level security;
revoke all on private.mercado_pago_accounts from public, anon, authenticated;

alter table public.payments add column provider_payment_id text;
create unique index payments_one_per_intent on public.payments(booking_intent_id);
create unique index payments_provider_payment_unique on public.payments(provider,provider_payment_id)
  where provider_payment_id is not null;

-- This RPC is callable only with the Edge Function's service key. Never expose its result to a browser.
create function public.mercado_pago_account(p_workspace uuid)
returns table(seller_user_id text, access_token text, environment text)
language sql security definer set search_path = '' as $$
  select a.seller_user_id, s.decrypted_secret, a.environment
  from private.mercado_pago_accounts a
  join vault.decrypted_secrets s on s.id=a.access_token_secret_id
  where a.workspace_id=p_workspace and a.active;
$$;
revoke all on function public.mercado_pago_account(uuid) from public, anon, authenticated;
grant execute on function public.mercado_pago_account(uuid) to service_role;

create or replace function public.create_checkout_intent(
  p_service uuid,p_first_name text,p_last_name text,p_email text,p_phone text,
  p_answers jsonb,p_token_hash text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_intent uuid; v_workspace public.workspaces%rowtype; v_booking public.booking_intents%rowtype;
  v_service_link text;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token_hash'; end if;
  v_intent := public.create_preconsultation_intent(p_service,p_first_name,p_last_name,p_email,p_phone,p_answers);
  select * into v_booking from public.booking_intents where id=v_intent;
  select * into v_workspace from public.workspaces where id=v_booking.workspace_id;
  select external_payment_url into v_service_link from public.services where id=p_service;
  if v_workspace.status='suspended' or (v_workspace.status='trial' and v_workspace.trial_ends_at < now())
    then raise exception 'workspace_unavailable'; end if;
  if v_workspace.payment_provider='external_link' then
    if coalesce(v_service_link,v_workspace.external_payment_url) is null
      then raise exception 'payment_not_configured'; end if;
  elsif v_workspace.payment_provider='mercado_pago_ar' then
    if v_booking.currency_code<>'ARS' or v_booking.price_minor<=0 or
      not exists(select 1 from private.mercado_pago_accounts a where a.workspace_id=v_booking.workspace_id and a.active)
      then raise exception 'payment_not_configured'; end if;
  else
    raise exception 'payment_not_configured';
  end if;
  update public.booking_intents set access_token_hash=p_token_hash where id=v_intent;
  insert into public.payments(workspace_id,booking_intent_id,provider,provider_order_id,amount_minor,currency_code,status)
  values(v_booking.workspace_id,v_intent,v_workspace.payment_provider,
    case when v_workspace.payment_provider='external_link' then v_intent::text else null end,
    v_booking.price_minor,v_booking.currency_code,'pending');
  return v_intent;
end $$;
revoke all on function public.create_checkout_intent(uuid,text,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_checkout_intent(uuid,text,text,text,text,jsonb,text) to service_role;

create function public.set_mercado_pago_preference(p_intent uuid,p_preference text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_payment public.payments%rowtype;
begin
  if length(p_preference) not between 3 and 200 then raise exception 'invalid_preference'; end if;
  select * into v_payment from public.payments where booking_intent_id=p_intent for update;
  if not found or v_payment.provider<>'mercado_pago_ar' or v_payment.status<>'pending'
    or (v_payment.provider_order_id is not null and v_payment.provider_order_id<>p_preference)
    then raise exception 'invalid_payment_state'; end if;
  update public.payments set provider_order_id=p_preference where id=v_payment.id;
end $$;
revoke all on function public.set_mercado_pago_preference(uuid,text) from public,anon,authenticated;
grant execute on function public.set_mercado_pago_preference(uuid,text) to service_role;

-- Atomic, idempotent transition. Browser-return fields never call this RPC.
create function public.record_mercado_pago_payment(
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
  if p_status='refunded' and (v_payment.status<>'approved' or v_payment.provider_payment_id<>p_payment_id)
    then raise exception 'refund_mismatch'; end if;
  update public.payments set status=p_status,provider_payment_id=p_payment_id,
    provider_event_id=p_event_id,approved_at=case when p_status='approved' then now() else approved_at end
    where id=v_payment.id;
  if p_status='approved' and v_intent.status='pending_payment' then
    update public.booking_intents set status='awaiting_schedule',expires_at=greatest(expires_at,now()+interval '30 days')
      where id=p_intent;
  elsif p_status='refunded' then
    update public.booking_intents set status='refunded' where id=p_intent;
    update public.appointments set status='cancelled' where booking_intent_id=p_intent and status='scheduled';
  end if;
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(v_intent.workspace_id,'mercado_pago_'||p_status::text,'payment',v_payment.id);
  return true;
end $$;
revoke all on function public.record_mercado_pago_payment(uuid,text,text,text,public.payment_status,integer,char(3)) from public,anon,authenticated;
grant execute on function public.record_mercado_pago_payment(uuid,text,text,text,public.payment_status,integer,char(3)) to service_role;
