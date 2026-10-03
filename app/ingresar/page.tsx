"use client";

import BellisLogo from "@/components/brand/BellisLogo";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import { authMessage, landingRouteForUser } from "@/lib/auth/navigation";
import "../registro/registro.css";

export default function Ingresar() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
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
  return <main className="signup-shell"><header className="signup-header"><a className="brand" href="/"><BellisLogo /></a><a className="auth-link" href="/registro">Crear cuenta</a></header><div className="signup-body"><aside className="signup-aside"><span className="signup-kicker">TU ESPACIO PROFESIONAL</span><h2>Todo listo antes de atender.</h2><p>Ingresá para gestionar turnos, pacientes, cobros y preconsultas.</p></aside><section className="signup-card">{checking ? <p role="status">Comprobando tu sesión…</p> : <form onSubmit={submit}><span className="signup-step-label">BIENVENIDA DE NUEVO</span><h1>Ingresá a Bellis</h1><p className="signup-description">Usá el email y la contraseña de tu cuenta profesional.</p><div className="form-grid"><label className="full">Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label><label className="full">Contraseña<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label></div><a className="auth-recover" href="/recuperar">Olvidé mi contraseña</a>{error && <p className="signup-error" role="alert">{error}</p>}<div className="signup-actions"><button className="signup-next" disabled={loading} type="submit">{loading ? "Ingresando…" : "Ingresar"}<ArrowRight size={17}/></button></div><p className="auth-alt">¿No tenés cuenta? <a href="/registro">Crear cuenta</a></p></form>}</section></div></main>;
}
