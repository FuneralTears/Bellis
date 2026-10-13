-- H2.8A: quién es parte del equipo de Bellis.
-- El backoffice no reutiliza los roles de workspace: ser owner o admin de un consultorio no da ningún acceso acá.
-- La lista vive en private y solo se lee a través de funciones; nadie la consulta ni la escribe desde el navegador.
--   admin    ve todo el backoffice y, más adelante, hace los cambios comerciales.
--   support  ve todo el backoffice; no cambia nada.
-- No se carga a nadie en esta migración: promover a una persona es un paso manual y explícito (docs/backoffice-admins.md).

create table private.bellis_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','support')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table private.bellis_admins enable row level security;
revoke all on private.bellis_admins from public,anon,authenticated,service_role;

-- El rol de quien llama, o null si no es del equipo o está dado de baja.
create function private.bellis_admin_role() returns text
language sql stable security definer set search_path = '' as $$
  select a.role from private.bellis_admins a where a.user_id=(select auth.uid()) and a.active;
$$;
revoke all on function private.bellis_admin_role() from public,anon,authenticated;

create function private.is_bellis_admin(p_roles text[] default array['admin','support']) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.bellis_admin_role() = any(p_roles), false);
$$;
revoke all on function private.is_bellis_admin(text[]) from public,anon,authenticated;

-- Toda función del backoffice empieza por acá. A quien no es del equipo se le responde lo mismo que si la función
-- no existiera: no se distingue "no tenés permiso" de "no hay nada".
create function private.require_bellis_admin(p_roles text[] default array['admin','support']) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_bellis_admin(p_roles) then raise exception 'not_found' using errcode = 'P0002'; end if;
end $$;
revoke all on function private.require_bellis_admin(text[]) from public,anon,authenticated;

-- Lo único que el frontend pregunta antes de mostrar algo: con qué rol entra esta persona. Falla para el resto.
create function private.bellis_admin_session() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_bellis_admin();
  return jsonb_build_object('role', private.bellis_admin_role());
end $$;
revoke all on function private.bellis_admin_session() from public,anon,authenticated;
grant execute on function private.bellis_admin_session() to authenticated;

create function public.bellis_admin_session() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.bellis_admin_session();
$$;
revoke all on function public.bellis_admin_session() from public,anon;
grant execute on function public.bellis_admin_session() to authenticated;
