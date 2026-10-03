"use client";

import BellisLogo from "@/components/brand/BellisLogo";
import { useEffect, useState } from "react";
import { authMessage } from "@/lib/auth/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import "../registro/registro.css";

export default function Recuperar() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"request" | "checking" | "update" | "invalid" | "done">("request");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    if (hash.has("error") || query.has("error")) {
      setMode("invalid"); setMessage("Este enlace venció o no es válido. Solicitá uno nuevo."); return;
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
        else { setMode("invalid"); setMessage("Este enlace venció o no es válido. Solicitá uno nuevo."); }
      }
      if (!active) subscription.subscription.unsubscribe();
      else cleanup = () => subscription.subscription.unsubscribe();
    }).catch(() => { if (active) { setMode("invalid"); setMessage("No pudimos verificar el enlace. Solicitá uno nuevo."); } });
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
  return <main className="signup-shell"><header className="signup-header"><a className="brand" href="/"><BellisLogo /></a><a className="auth-link" href="/ingresar">Iniciar sesión</a></header><div className="signup-body"><aside className="signup-aside"><span className="signup-kicker">TU CUENTA</span><h2>Recuperá el acceso a tu espacio.</h2></aside><section className="signup-card">{mode === "checking" ? <p role="status">Verificando tu enlace…</p> : mode === "done" ? <div className="signup-done"><h1>Contraseña actualizada</h1><p role="status">{message}</p><a href="/ingresar" className="signup-next">Ir a ingresar</a></div> : <form onSubmit={submit}><h1>{requestMode ? "Recuperar contraseña" : "Crear nueva contraseña"}</h1><div className="form-grid">{requestMode ? <label className="full">Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label> : <label className="full">Nueva contraseña<input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>}</div>{message && <p role={mode === "invalid" ? "alert" : "status"}>{message}</p>}<div className="signup-actions"><button className="signup-next" disabled={busy}>{busy ? "Procesando…" : requestMode ? "Enviar enlace" : "Guardar contraseña"}</button></div></form>}</section></div></main>;
}
