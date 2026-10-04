"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getSupabase } from "@/lib/supabase/browser";
import { authMessage, landingRouteForUser } from "@/lib/auth/navigation";
import { AuthHeading, AuthLoading, AuthMessage, AuthShell, PasswordField, friendlyAuthError } from "@/components/auth/AuthUi";

// The sign-up confirmation link lands here with ?confirmed=1. Read for display only; a link that came back with an error does not count.
const subscribeToNothing = () => () => {};
function arrivedFromConfirmation() {
  const query = new URLSearchParams(window.location.search);
  return query.get("confirmed") === "1" && !query.has("error") && !new URLSearchParams(window.location.hash.slice(1)).has("error");
}

export default function Ingresar() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const confirmed = useSyncExternalStore(subscribeToNothing, arrivedFromConfirmation, () => false);
  useEffect(() => {
    let active = true;
    getSupabase().then(async (client) => {
      const { data } = await client.auth.getUser();
      if (data.user) window.location.replace(await landingRouteForUser(client, data.user.id));
      else if (active) setChecking(false);
    }).catch((caught) => { if (active) { setError(caught instanceof Error ? caught.message : "No pudimos verificar tu cuenta."); setChecking(false); } });
    return () => { active = false; };
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const client = await getSupabase();
      const result = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      if (!result.data.user) throw new Error("No pudimos verificar tu cuenta.");
      window.location.replace(await landingRouteForUser(client, result.data.user.id));
    } catch (caught) {
      setError(authMessage(caught, "login"));
      setLoading(false);
    }
  };
  return <AuthShell>{checking ? <AuthLoading>Comprobando tu sesión…</AuthLoading> : <>
    <AuthHeading title="Iniciá sesión">Entrá a tu espacio de Bellis.</AuthHeading>
    {confirmed && !error && <AuthMessage tone="success">Tu email quedó confirmado. Ya podés iniciar sesión.</AuthMessage>}
    <form className="auth-form" onSubmit={submit} aria-describedby={error ? "auth-error" : undefined}>
      <label className="auth-field">Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <PasswordField label="Contraseña" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
      <a className="auth-link auth-forgot" href="/recuperar">¿Olvidaste tu contraseña?</a>
      {error && <AuthMessage tone="error" id="auth-error">{friendlyAuthError(error)}</AuthMessage>}
      <button className="auth-button" disabled={loading} type="submit">{loading ? "Ingresando…" : "Iniciar sesión"}</button>
    </form>
    <p className="auth-alt">¿Todavía no tenés cuenta? <a className="auth-link" href="/registro">Crear cuenta</a></p>
  </>}</AuthShell>;
}
