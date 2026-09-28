"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3 } from "lucide-react";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import "../registro/registro.css";

const weekdays = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const [days, setDays] = useState([true, true, true, true, true, false, false]);
  const [form, setForm] = useState({ service: "Consulta inicial", description: "", price: "25000", duration: "60", mode: "Online", start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00", notice: "24", buffer: "15" });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getSupabase().then(async (client) => {
      const { data, error: authError } = await client.auth.getUser();
      if (authError || !data.user) { window.location.replace("/ingresar"); return; }
      const destination = await landingRouteForUser(client, data.user.id);
      if (destination === "/dashboard") window.location.replace(destination);
      else if (active) setReady(true);
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "No pudimos abrir tu espacio."); });
    return () => { active = false; };
  }, []);

  const field = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    if (step === 1) { setStep(2); return; }
    if (!days.some(Boolean)) { setError("Seleccioná al menos un día de trabajo."); return; }
    setBusy(true);
    try {
      const client = await getSupabase();
      const { data } = await client.auth.getUser();
      if (!data.user) { window.location.replace("/ingresar"); return; }
      const { error: saveError } = await client.rpc("complete_bellis_onboarding", { p_document: { ...form, days } });
      if (saveError) throw saveError;
      window.location.replace("/dashboard");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      setError(message.includes("invalid_break") ? "El descanso debe estar dentro del horario de atención." :
        message.includes("invalid_hours") ? "Revisá el horario de inicio y fin." :
        message.includes("authentication_required") ? "Tu sesión venció. Volvé a ingresar." :
        "No pudimos guardar tu configuración. Revisá los datos e intentá nuevamente.");
    } finally { setBusy(false); }
  };

  const signOut = async () => { const client = await getSupabase(); await client.auth.signOut(); window.location.replace("/ingresar"); };

  return <main className="signup-shell"><header className="signup-header"><a className="brand" href="/"><span className="brand-mark">b.</span> bellis</a><button className="back-btn" onClick={signOut}>Cerrar sesión</button></header><div className="signup-body"><aside className="signup-aside"><span className="signup-kicker">TU ESPACIO COMIENZA ACÁ</span><h2>Más tiempo para tus pacientes.</h2><p>Terminá de configurar tu primera sesión y tus horarios. Podrás cambiarlos desde el panel.</p><div className="signup-progress">{["Tu cuenta", "Primera sesión", "Horarios"].map((item, index) => <div key={item} className={step >= index ? "progress-step on" : "progress-step"}><span>{index === 0 || step > index ? <Check size={16} /> : index + 1}</span>{item}</div>)}</div><div className="signup-footnote"><Clock3 size={18} /> Configuración inicial</div></aside><section className="signup-card"><div className="mobile-progress">Paso {step + 1} de 3</div>{error && !ready ? <div className="signup-done"><h1>No pudimos continuar</h1><p role="alert">{error}</p><a href="/ingresar">Volver a ingresar</a></div> : !ready ? <p role="status">Cargando tu espacio…</p> : <form onSubmit={submit}><span className="signup-step-label">PASO {step + 1} DE 3</span><h1>{step === 1 ? "Configurá tu primera sesión" : "Configurá tus horarios"}</h1><p className="signup-description">{step === 1 ? "Este servicio aparecerá en tu página pública para que tus pacientes puedan elegirlo." : "Definí cuándo pueden reservar. Podrás modificar estas reglas después."}</p>{step === 1 ? <div className="form-grid"><label className="full">Nombre del servicio<input required value={form.service} onChange={field("service")} /></label><label className="full">Descripción<textarea value={form.description} onChange={field("description")} placeholder="Contá brevemente qué incluye esta sesión" /></label><label>Precio (ARS)<input required type="number" min="1" max="9999999" value={form.price} onChange={field("price")} /></label><label>Duración<select value={form.duration} onChange={field("duration")}>{[30, 45, 50, 60, 75, 90, 120].map((value) => <option value={value} key={value}>{value} minutos</option>)}</select></label><label className="full">Modalidad<select value={form.mode} onChange={field("mode")}><option>Online</option><option>Presencial</option><option>Ambas</option></select></label></div> : <><div className="day-pills">{weekdays.map((day, index) => <button type="button" key={day} className={days[index] ? "on" : ""} onClick={() => setDays((current) => current.map((active, position) => index === position ? !active : active))}>{day.slice(0, 3)}</button>)}</div><div className="form-grid"><label>Inicio<input type="time" value={form.start} onChange={field("start")} /></label><label>Fin<input type="time" value={form.end} onChange={field("end")} /></label><label>Descanso desde<input type="time" value={form.breakStart} onChange={field("breakStart")} /></label><label>Descanso hasta<input type="time" value={form.breakEnd} onChange={field("breakEnd")} /></label><label>Anticipación mínima<select value={form.notice} onChange={field("notice")}><option value="1">1 hora</option><option value="12">12 horas</option><option value="24">24 horas</option><option value="48">48 horas</option></select></label><label>Tiempo entre turnos<select value={form.buffer} onChange={field("buffer")}><option value="0">Sin pausa</option><option value="10">10 minutos</option><option value="15">15 minutos</option><option value="30">30 minutos</option></select></label></div></>}{error && <p className="signup-error" role="alert">{error}</p>}<div className="signup-actions">{step === 2 && <button type="button" className="back-btn" onClick={() => { setError(""); setStep(1); }}><ArrowLeft size={17} /> Volver</button>}<button className="signup-next" type="submit" disabled={busy}>{busy ? "Guardando…" : step === 1 ? "Continuar" : "Activar mi agenda"}<ArrowRight size={17} /></button></div></form>}</section></div></main>;
}
