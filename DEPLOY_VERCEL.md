# Bellis en Vercel

Bellis usa **Next.js 16 App Router** con React y TypeScript. El código de Bellis ya compilaba mediante vinext para ChatGPT Sites; Vercel debe compilarlo con Next.js. Supabase sigue siendo el backend, la base de datos, Auth, las Edge Functions y el motor de automatizaciones con `pg_cron`.

## Proyecto y build

1. Importar el repositorio GitHub en Vercel y elegir la carpeta que contiene este `package.json` como **Root Directory**.
2. Framework Preset: **Next.js**. Node.js: **22.x**.
3. Install Command: `npm ci`. Build Command: `npm run build` (`next build`).
4. **No configurar Output Directory**: Vercel gestiona la salida de Next.js (`.next`). Tampoco se necesita `vercel.json` ni una regla de rewrite a `index.html`: las rutas de `app/` las resuelve Next.js, también al entrar directamente o refrescar.
5. Conectar el repositorio para conservar despliegues por commit, previews e historial. Los comandos `dev:sites`, `build:sites` y `start:sites` quedan separados para el runtime anterior; no se usan en Vercel.

## Variables en Vercel

Configurar en **Project → Settings → Environment Variables**. Usar los valores del proyecto Supabase Bellis existente. No copiar valores desde este documento ni subir `.env.local` al repositorio.

| Variable real | Clasificación | Production | Preview | Development |
| --- | --- | --- | --- | --- |
| `SUPABASE_URL` | Pública: `/api/supabase-config` la entrega al navegador | Requerida | Requerida | Requerida |
| `SUPABASE_PUBLISHABLE_KEY` | Pública: clave publicable de Supabase | Requerida | Requerida | Requerida |

Ambas tienen nombres **sin** `NEXT_PUBLIC_` porque la ruta de servidor `app/api/supabase-config/route.ts` entrega únicamente estos dos valores públicos. No configurar `SUPABASE_SERVICE_ROLE_KEY`, tokens de Mercado Pago ni claves privadas en Vercel: Bellis no los necesita allí. Las claves privadas del flujo de cobro permanecen en Supabase Edge Functions.

Localmente, `npm run dev` abre Next.js en `http://localhost:5173` y lee el `.env.local` ignorado por Git. `npm run build` usa Next.js y `npm run start` sirve la compilación en el mismo puerto.

## Supabase después de obtener la URL real

No cambiar la base de datos ni volver a aplicar migraciones. La aplicación de Vercel debe apuntar al **mismo** `SUPABASE_URL` y a su clave publicable.

En **Supabase → Authentication → URL Configuration**:

- **Site URL:** la URL exacta de producción de Vercel, sin barra final. No usar una URL inventada antes del primer despliegue.
- **Redirect URLs de producción:** `https://<URL-REAL-VERCEL>/ingresar?confirmed=1` y `https://<URL-REAL-VERCEL>/recuperar?mode=update`.
- **Conservar para desarrollo:** `http://localhost:5173/ingresar?confirmed=1` y `http://localhost:5173/recuperar?mode=update`.
- **Previews:** agregar las dos URLs exactas de callback de cada preview que se quiera probar. Evitar comodines sobre todo `*.vercel.app`. Cuando haya un patrón de previews estable y acotado a la cuenta, revisarlo antes de permitirlo.

El registro usa `emailRedirectTo` hacia `/ingresar?confirmed=1`. La recuperación usa `redirectTo` hacia `/recuperar?mode=update`. El login con contraseña usa `/ingresar` sin callback adicional. Ambas redirecciones se construyen con `window.location.origin`, así que respetan localhost, previews y producción.

La función pública `supabase/functions/bellis-public` comprueba el origen del navegador. **Antes de probar el perfil público en Vercel**, desplegar la versión de esa función incluida en este commit y configurar en Supabase Edge Functions:

- `BELLIS_SITE_ORIGIN`: origen exacto de producción de Vercel, sin path ni barra final.
- `BELLIS_ADDITIONAL_ORIGINS`: opcional; lista separada por comas de orígenes HTTPS exactos para previews autorizados o para mantener temporalmente accesible la demo anterior. No admite comodines.

Esta configuración no es una clave de servicio. El runtime local sigue aceptando `http://localhost:<puerto>`. La URL de retorno de Mercado Pago usa el origen autorizado del preview cuando corresponda; el webhook permanece en Supabase. La función y sus secretos de servidor nunca se empaquetan en el frontend de Vercel.

## Comprobación del primer despliegue

1. Confirmar que Vercel compiló con `next build`, entregó una URL y `/api/supabase-config` responde sin error 503. No publicar los valores devueltos por esa ruta en capturas o logs.
2. Abrir `/`, `/registro`, `/ingresar`, `/recuperar` y un perfil real `/p/[slug]`.
3. Ingresar con una cuenta de prueba. Abrir y refrescar `/dashboard`, `/pacientes`, `/pacientes/[id]`, `/seguimientos`, `/automatizaciones`, `/automatizaciones/ejecuciones` y `/notificaciones`.
4. Confirmar en el navegador que Auth, lecturas y escrituras autorizadas usan el Supabase existente y que RLS sigue aislando los espacios. No activar las reglas de automatización para probar la navegación.
5. Revisar errores de runtime y de red. Para probar registro y recuperación por email, completar antes las Redirect URLs de Auth y la configuración de correo correspondiente.

El primer deploy y la validación posterior dependen de la URL asignada por Vercel y del acceso al repositorio y a Vercel. No configurar dominio personalizado ni DNS en esta etapa.
