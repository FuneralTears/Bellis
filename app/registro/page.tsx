"use client";

import { useEffect, useState } from "react";
import { DEFAULT_MARKET, DEFAULT_TIMEZONE_LABEL } from "@/lib/market";
import { authMessage, landingRouteForUser } from "@/lib/auth/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { AuthFixedField, AuthHeading, AuthLoading, AuthMessage, AuthNotice, AuthShell, PasswordField, friendlyAuthError } from "@/components/auth/AuthUi";

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

  return <AuthShell wide={!needsEmail && !checking}>{needsEmail ? <AuthNotice title="Revisá tu email" actions={<a className="auth-button" href="/ingresar">Ir a iniciar sesión</a>}>
      <p>Si ese email puede registrarse, te enviamos un enlace para confirmar tu cuenta. Después iniciá sesión para terminar de configurar tu espacio.</p>
      <p>Si no lo encontrás, revisá Spam o Correo no deseado.</p>
      <p>¿Ya tenías cuenta? <a className="auth-link" href="/recuperar">Recuperá tu acceso</a>.</p>
    </AuthNotice> : checking ? <AuthLoading>Comprobando tu sesión…</AuthLoading> : <>
    <AuthHeading title="Creá tu cuenta">Empezá a organizar tu consulta con Bellis.</AuthHeading>
    <form className="auth-form" onSubmit={submit} aria-describedby={error ? "auth-error" : undefined}>
      <div className="auth-grid">
        <label className="auth-field">Tu nombre<input required value={form.name} onChange={field("name")} placeholder="Ana López" autoComplete="name" /></label>
        <label className="auth-field">Nombre profesional o consultorio<input required value={form.business} onChange={field("business")} placeholder="Dra. Ana López" /></label>
        <label className="auth-field">Especialidad<select value={form.specialty} onChange={field("specialty")}>{specialties.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="auth-field">Email<input required type="email" value={form.email} onChange={field("email")} placeholder="ana@consultorio.com" autoComplete="email" /></label>
        <PasswordField label="Contraseña" hint="Mínimo 8 caracteres." required minLength={8} value={form.password} onChange={field("password")} autoComplete="new-password" />
        <label className="auth-field">Provincia<select required value={form.province} onChange={field("province")}><option value="">Seleccioná una provincia</option>{provinces.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="auth-field">Ciudad<input required value={form.city} onChange={field("city")} placeholder="Tu ciudad" /></label>
        <AuthFixedField label="Zona horaria" value={DEFAULT_TIMEZONE_LABEL} />
      </div>
      {error && <AuthMessage tone="error" id="auth-error">{friendlyAuthError(error)}</AuthMessage>}
      <button className="auth-button" type="submit" disabled={loading}>{loading ? "Creando cuenta…" : "Crear cuenta"}</button>
      <p className="auth-note">Después vas a configurar tu primera sesión y tus horarios. Lleva menos de 2 minutos.</p>
    </form>
    <p className="auth-alt">¿Ya tenés cuenta? <a className="auth-link" href="/ingresar">Iniciá sesión</a></p>
  </>}</AuthShell>;
}
