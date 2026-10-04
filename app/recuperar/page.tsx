"use client";

import { useEffect, useState } from "react";
import { authMessage } from "@/lib/auth/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { AuthHeading, AuthLoading, AuthMessage, AuthNotice, AuthShell, PasswordField, friendlyAuthError } from "@/components/auth/AuthUi";

export default function Recuperar() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"request" | "checking" | "update" | "invalid" | "done">("request");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Presentation only: the request went through, so the card shows "Revisá tu email" instead of the form.
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    if (hash.has("error") || query.has("error")) {
      setMode("invalid"); setMessage("Este enlace ya no es válido o venció. Pedí uno nuevo acá abajo."); return;
    }
    const tokenInUrl = hash.get("type") === "recovery" && !!hash.get("access_token");
    const expected = tokenInUrl || query.get("mode") === "update" || query.has("code");
    if (!expected) return;
    setMode("checking");
    let active = true;
    getSupabase().then(async (client) => {
      let recoveryEvent = false;
      const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
        if (active && event === "PASSWORD_RECOVERY" && session) {
          recoveryEvent = true; setMode("update"); setMessage("");
        }
      });
      const { data, error } = await client.auth.getUser();
      if (active && !recoveryEvent) {
        if (!error && data.user && tokenInUrl) setMode("update");
        else { setMode("invalid"); setMessage("Este enlace ya no es válido o venció. Pedí uno nuevo acá abajo."); }
      }
      if (!active) subscription.subscription.unsubscribe();
      else cleanup = () => subscription.subscription.unsubscribe();
    }).catch(() => { if (active) { setMode("invalid"); setMessage("No pudimos verificar el enlace. Pedí uno nuevo acá abajo."); } });
    let cleanup: (() => void) | undefined;
    return () => { active = false; cleanup?.(); };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const client = await getSupabase();
      if (mode === "request" || mode === "invalid") {
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/recuperar?mode=update` });
        if (error) throw error;
        setMode("request");
        setMessage("Si el email está registrado, recibirás un enlace para cambiar la contraseña.");
        setSent(true);
      } else if (mode === "update") {
        const { data } = await client.auth.getUser();
        if (!data.user) { setMode("invalid"); throw new Error("invalid_recovery_link"); }
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        await client.auth.signOut();
        setMode("done"); setMessage("Contraseña actualizada. Ingresá con tu nueva contraseña.");
      }
    } catch (caught) { setMessage(authMessage(caught, "recovery")); }
    finally { setBusy(false); }
  };

  const requestMode = mode === "request" || mode === "invalid";
  return <AuthShell>{mode === "checking" ? <AuthLoading>Verificando tu enlace…</AuthLoading>
    : mode === "done" ? <AuthNotice title="Tu contraseña se actualizó correctamente" actions={<a className="auth-button" href="/ingresar">Ir a iniciar sesión</a>}><p>Ya podés entrar con tu nueva contraseña.</p></AuthNotice>
    : sent && mode === "request" ? <AuthNotice title="Revisá tu email" actions={<><a className="auth-button" href="/ingresar">Volver a iniciar sesión</a><button type="button" className="auth-link" onClick={() => { setSent(false); setMessage(""); }}>Probar con otro email</button></>}>
      <p>Si hay una cuenta con ese email, te enviamos un enlace para restablecer tu contraseña.</p>
      <p>Si no lo encontrás, revisá Spam o Correo no deseado.</p>
    </AuthNotice> : <>
    <AuthHeading title={mode === "update" ? "Elegí una nueva contraseña" : mode === "invalid" ? "Solicitá un nuevo enlace" : "Recuperá tu acceso"}>{mode === "update" ? "Es la que vas a usar para entrar a Bellis de ahora en adelante." : "Te vamos a enviar un enlace para que puedas elegir una nueva contraseña."}</AuthHeading>
    <form className="auth-form" onSubmit={submit} aria-describedby={message ? "auth-error" : undefined}>
      {message && <AuthMessage tone="error" id="auth-error">{friendlyAuthError(message)}</AuthMessage>}
      {requestMode ? <label className="auth-field">Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        : <PasswordField label="Nueva contraseña" hint="Mínimo 8 caracteres." autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />}
      <button className="auth-button" disabled={busy}>{busy ? requestMode ? "Enviando…" : "Guardando…" : requestMode ? "Enviar enlace" : "Guardar nueva contraseña"}</button>
    </form>
    <p className="auth-alt"><a className="auth-link" href="/ingresar">Volver a iniciar sesión</a></p>
  </>}</AuthShell>;
}
