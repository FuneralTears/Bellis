"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import "../registro/registro.css";

export default function Ingresar() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const client = await getSupabase();
      const result = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      window.location.assign("/dashboard/questionnaires");
    } catch {
      setError("No pudimos ingresar. Revisá tus datos y la confirmación de tu email.");
      setLoading(false);
    }
  };
  return <main className="signup-shell"><header className="signup-header"><a className="brand" href="/"><span className="brand-mark">b.</span> bellis</a><a href="/registro">Crear cuenta</a></header><div className="signup-body"><aside className="signup-aside"><span className="signup-kicker">TU ESPACIO PROFESIONAL</span><h2>Todo listo antes de atender.</h2><p>Ingresá para configurar las preguntas que verá cada paciente antes de reservar su turno.</p></aside><section className="signup-card"><form onSubmit={submit}><span className="signup-step-label">BIENVENIDA DE NUEVO</span><h1>Ingresá a Bellis</h1><p className="signup-description">Usá el email y la contraseña de tu cuenta profesional.</p><div className="form-grid"><label className="full">Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label><label className="full">Contraseña<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label></div>{error && <p className="signup-error" role="alert">{error}</p>}<div className="signup-actions"><button className="signup-next" disabled={loading} type="submit">{loading ? "Ingresando…" : "Ingresar"}<ArrowRight size={17}/></button></div></form></section></div></main>;
}
