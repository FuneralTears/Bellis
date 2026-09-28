create table public.public_request_limits (
  fingerprint text not null,
  window_start timestamptz not null,
  attempts integer not null default 1,
  primary key(fingerprint,window_start)
);
alter table public.public_request_limits enable row level security;
revoke all on public.public_request_limits from public,anon,authenticated;
grant select,insert,update,delete on public.public_request_limits to service_role;

create function public.consume_public_request_limit(p_fingerprint text,p_max integer,p_window_minutes integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_start timestamptz; v_attempts integer;
begin
  if p_fingerprint !~ '^[a-f0-9]{64}$' or p_max not between 1 and 1000
    or p_window_minutes not between 1 and 1440 then return false; end if;
  v_start := pg_catalog.date_bin(make_interval(mins=>p_window_minutes),now(),'2020-01-01'::timestamptz);
  insert into public.public_request_limits(fingerprint,window_start,attempts)
  values(p_fingerprint,v_start,1)
  on conflict(fingerprint,window_start) do update
    set attempts=public.public_request_limits.attempts+1
  returning attempts into v_attempts;
  return v_attempts<=p_max;
end $$;
revoke all on function public.consume_public_request_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_public_request_limit(text,integer,integer) to service_role;
