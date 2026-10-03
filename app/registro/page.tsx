"use client";

import BellisLogo from "@/components/brand/BellisLogo";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Clock3 } from "lucide-react";
import { DEFAULT_MARKET } from "@/lib/market";
import { authMessage, landingRouteForUser } from "@/lib/auth/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import "./registro.css";

const specialties = ["Psicología", "Odontología", "Kinesiología", "Nutrición", "Psicopedagogía", "Otro"];
const provinces = ["Buenos Aires", "CABA", "Córdoba", "Santa Fe", "Mendoza", "Tucumán", "Entre Ríos", "Salta", "Neuquén", "Misiones", "Santiago del Estero", "Catamarca", "Chaco", "Chubut", "Corrientes", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Río Negro", "San Juan", "San Luis", "Santa Cruz", "Tierra del Fuego"];

export default function Registro() {
  const [form, setForm] = useState({ name: "", business: "", specialty: "Psicología", email: "", password: "", province: "", city: "", timezone: DEFAULT_MARKET.timezone });
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [needsEmail, setNeedsEmail] = useState(false);

  useEffect(() => {
    let active = true;
    getSupabase().then(async (client) => {
      const { data } = await client.auth.getUser();
      if (data.user) window.location.replace(await landingRouteForUser(client, data.user.id));
      else if (active) setChecking(false);
    }).catch(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  const field = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const client = await getSupabase();
      const { data, error: authError } = await client.auth.signUp({
        email: form.email.trim(), password: form.password,
        options: { emailRedirectTo: `${window.location.origin}/ingresar?confirmed=1`,
          data: { bellis_signup: "1", name: form.name.trim(), business: form.business.trim(), specialty: form.specialty,
            province: form.province, city: form.city.trim(), timezone: form.timezone } },
      });
      if (authError) throw authError;
      if (data.session && data.user) {
        window.location.replace(await landingRouteForUser(client, data.user.id));
        return;
      }
      setNeedsEmail(true);
    } catch (caught) { setError(authMessage(caught, "signup")); }
    finally { setLoading(false); }
  };

  return <main className="signup-shell"><header className="signup-header"><a className="brand" href="/"><BellisLogo /></a><span>¿Ya tenés cuenta? <a href="/ingresar">Ingresar</a></span></header><div className="signup-body"><aside className="signup-aside"><span className="signup-kicker">TU ESPACIO COMIENZA ACÁ</span><h2>Más tiempo para tus pacientes.</h2><p>Configurá lo esencial para que tus pacientes puedan informarse, pagar y reservar en un mismo recorrido.</p><div className="signup-progress">{["Tu cuenta", "Primera sesión", "Horarios"].map((item, index) => <div key={item} className={index === 0 ? "progress-step on" : "progress-step"}><span>{index === 0 && needsEmail ? <Check size={16} /> : index + 1}</span>{item}</div>)}</div><div className="signup-footnote"><Clock3 size={18} /> Menos de 2 minutos para configurar tu espacio</div></aside><section className="signup-card"><div className="mobile-progress">Paso 1 de 3</div>{needsEmail ? <div className="signup-done"><span><Check size={30} /></span><h1>Revisá tu email</h1><p>Si la dirección puede registrarse, recibirás un enlace para confirmar la cuenta. Después ingresá para completar tu primera sesión y horarios.</p><p>Si ya tenés cuenta, <a href="/recuperar">recuperá tu contraseña</a>.</p><a className="signup-next" href="/ingresar">Ir a ingresar <ArrowRight size={17} /></a></div> : checking ? <p role="status">Comprobando tu sesión…</p> : <form onSubmit={submit}><span className="signup-step-label">PASO 1 DE 3</span><h1>Activá tu agenda en menos de 2 minutos</h1><p className="signup-description">Empezá con tus datos básicos. Después podrás configurar tu sesión y horarios.</p><div className="form-grid"><label>Tu nombre<input required value={form.name} onChange={field("name")} placeholder="Ana López" autoComplete="name" /></label><label>Nombre profesional o consultorio<input required value={form.business} onChange={field("business")} placeholder="Dra. Ana López" /></label><label>Especialidad<select value={form.specialty} onChange={field("specialty")}>{specialties.map((item) => <option key={item}>{item}</option>)}</select></label><label>Email<input required type="email" value={form.email} onChange={field("email")} placeholder="ana@consultorio.com" autoComplete="email" /></label><label>Contraseña<input required type="password" minLength={8} value={form.password} onChange={field("password")} placeholder="Mínimo 8 caracteres" autoComplete="new-password" /></label><label>Provincia<select required value={form.province} onChange={field("province")}><option value="">Seleccioná una provincia</option>{provinces.map((item) => <option key={item}>{item}</option>)}</select></label><label>Ciudad<input required value={form.city} onChange={field("city")} placeholder="Tu ciudad" /></label><label className="full">Zona horaria<select value={form.timezone} onChange={field("timezone")}><option value="America/Argentina/Buenos_Aires">Argentina — Buenos Aires</option><option value="America/Argentina/Cordoba">Argentina — Córdoba</option><option value="America/Argentina/Mendoza">Argentina — Mendoza</option><option value="America/Argentina/Salta">Argentina — Salta</option><option value="America/Argentina/Ushuaia">Argentina — Tierra del Fuego</option></select></label></div>{error && <p className="signup-error" role="alert">{error}</p>}<div className="signup-actions"><button className="signup-next" type="submit" disabled={loading}>{loading ? "Creando cuenta…" : "Crear mi cuenta"}<ArrowRight size={17} /></button></div></form>}</section></div></main>;
}
