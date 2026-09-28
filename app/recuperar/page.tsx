"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/browser";
import "../registro/registro.css";

export default function Recuperar() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"request" | "update">("request");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (window.location.hash.includes("type=recovery") || window.location.search.includes("mode=update")) setMode("update"); }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const client = await getSupabase();
      if (mode === "request") {
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/recuperar?mode=update` });
        if (error) throw error;
        setMessage("Si el email está registrado, recibirás un enlace para cambiar la contraseña.");
      } else {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setMessage("Contraseña actualizada. Ya podés ingresar.");
      }
    } catch { setMessage("No pudimos completar el cambio. Revisá el enlace o intentá nuevamente."); }
    finally { setBusy(false); }
  };
  return <main className="signup-shell"><header className="signup-header"><a className="brand" href="/"><span className="brand-mark">b.</span> bellis</a><a href="/ingresar">Ingresar</a></header><div className="signup-body"><aside className="signup-aside"><span className="signup-kicker">TU CUENTA</span><h2>Recuperá el acceso a tu espacio.</h2></aside><section className="signup-card"><form onSubmit={submit}><h1>{mode === "request" ? "Recuperar contraseña" : "Crear nueva contraseña"}</h1><div className="form-grid">{mode === "request" ? <label className="full">Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label> : <label className="full">Nueva contraseña<input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>}</div>{message && <p role="status">{message}</p>}<div className="signup-actions"><button className="signup-next" disabled={busy}>{busy ? "Procesando…" : mode === "request" ? "Enviar enlace" : "Guardar contraseña"}</button></div></form></section></div></main>;
}
