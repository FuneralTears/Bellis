# Backoffice interno: quién entra y cómo se da acceso

El backoffice (`/admin`) es solo para el equipo de Bellis. No reutiliza los roles de workspace: ser dueño o
admin de un consultorio no da ningún acceso.

## Cómo funciona

- La lista del equipo está en `private.bellis_admins`. Nadie la lee ni la escribe desde el navegador.
- Hay dos roles: `admin` y `support`. Hoy los dos ven lo mismo; los cambios de plan, cuando existan, serán solo de `admin`.
- Cada función del backoffice (`admin_overview`, `admin_workspaces`, `admin_workspace_detail`,
  `admin_recent_activity`) valida en el servidor a quien llama. A quien no es del equipo le responde `not_found`.
- El frontend muestra la página de "no encontrado" a cualquiera que no sea del equipo. Eso es solo presentación:
  la protección de los datos está en las funciones.

## Dar acceso a una persona

Es un paso manual, explícito y por entorno. **No se carga a nadie por migración ni se deja ningún email en git.**

1. La persona tiene que tener una cuenta en ese entorno (registrarse o iniciar sesión una vez).
2. Con acceso de `postgres` al proyecto (SQL Editor de Supabase), revisar a quién se va a promover:

   ```sql
   select id, email, created_at from auth.users where email = 'EMAIL_DE_LA_PERSONA';
   ```

   Tiene que devolver exactamente una fila. Si devuelve otra cosa, no seguir.

3. Promoverla. El email se escribe en el momento, en el editor; no se guarda en ningún archivo:

   ```sql
   insert into private.bellis_admins (user_id, role)
   select id, 'support' from auth.users where email = 'EMAIL_DE_LA_PERSONA'
   on conflict (user_id) do update set role = excluded.role, active = true
   returning user_id, role, active;
   ```

   Usar `'admin'` en lugar de `'support'` solo para quien vaya a hacer cambios comerciales.

4. Verificar quiénes tienen acceso:

   ```sql
   select a.role, a.active, a.created_at, u.email
   from private.bellis_admins a join auth.users u on u.id = a.user_id
   order by a.created_at;
   ```

## Quitar el acceso

Se da de baja sin borrar la fila, para que quede el registro de que existió. El corte es inmediato.

```sql
update private.bellis_admins set active = false
where user_id = (select id from auth.users where email = 'EMAIL_DE_LA_PERSONA')
returning user_id, role, active;
```

## Entornos

- **Staging:** promover primero acá, a una cuenta de prueba del equipo, para revisar el backoffice.
- **Producción:** se hace aparte, después del release, con el mismo procedimiento y solo con cuentas reales del
  equipo. Nunca copiar la lista de un entorno a otro: los ids de usuario no coinciden.

## Qué no muestra el backoffice

Notas de pacientes, respuestas de formularios, títulos o descripciones de seguimientos, nombres o datos de
contacto de pacientes. Solo cantidades, fechas y estados, más el nombre del consultorio, la profesión y el email
de quien creó la cuenta. Si una pantalla nueva necesitara contenido clínico para funcionar, hay que rediseñarla.
