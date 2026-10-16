"use client";

import { useEffect, useState } from "react";
import { DEFAULT_MARKET, DEFAULT_TIMEZONE_LABEL } from "@/lib/market";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { provinces, specialties } from "@/lib/auth/signup-fields";
import { AuthFixedField, AuthHeading, AuthLoading, AuthMessage, AuthShell } from "@/components/auth/AuthUi";

/**
 * Completes a Bellis account created with Google: the same professional fields /registro asks for, without email or
 * password (Google already gave the email). The account is created by the server for the signed-in person
 * (complete_bellis_account), once: a second submit, a refresh or another tab finds it and goes on.
 */
export default function CompletarRegistro() {
  const [form, setForm] = useState({ name: "", business: "", specialty: "Psicología", province: "", city: "" });
  const [email, setEmail] = useState("");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getSupabase().then(async (client) => {
      const { data } = await client.auth.getUser();
      if (!data.user) { window.location.replace("/ingresar"); return; }
      const destination = await landingRouteForUser(client, data.user.id);
      if (destination !== "/registro/completar") { window.location.replace(destination); return; }
      if (!active) return;
      // Only a suggestion for the field: the account takes nothing from it without the person submitting it.
      const suggested = data.user.user_metadata?.full_name ?? data.user.user_metadata?.name;
      setForm((current) => ({ ...current, name: typeof suggested === "string" ? suggested.slice(0, 120) : current.name }));
      setEmail(data.user.email ?? "");
      setChecking(false);
    }).catch(() => { if (active) { setError("No pudimos verificar tu cuenta. Intentá nuevamente."); setChecking(false); } });
    return () => { active = false; };
  }, []);

  const field = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const client = await getSupabase();
      const { error: rpcError } = await client.rpc("complete_bellis_account", { p_document: {
        name: form.name.trim(), business: form.business.trim(), specialty: form.specialty, province: form.province, city: form.city.trim(), timezone: DEFAULT_MARKET.timezone } });
      if (rpcError) throw rpcError;
      const { data } = await client.auth.getUser();
      window.location.replace(data.user ? await landingRouteForUser(client, data.user.id) : "/ingresar");
    } catch (caught) {
      const message = String((caught as { message?: unknown } | null)?.message ?? "");
      setError(message.includes("email_not_verified") ? "Tu email todavía no está verificado. Verificalo e intentá de nuevo."
        : message.includes("business_required") || message.includes("name_required") ? "Completá tu nombre y el nombre profesional (entre 2 y 120 caracteres)."
        : "No pudimos crear tu cuenta. Intentá nuevamente.");
      setBusy(false);
    }
  };

  return <AuthShell wide={!checking}>{checking ? <AuthLoading>Comprobando tu sesión…</AuthLoading> : <>
    <AuthHeading title="Completá tu cuenta">Ya iniciaste sesión con Google{email ? ` (${email})` : ""}. Contanos sobre tu consulta para crear tu espacio en Bellis.</AuthHeading>
    <form className="auth-form" onSubmit={submit} aria-describedby={error ? "auth-error" : undefined}>
      <div className="auth-grid">
        <label className="auth-field">Tu nombre<input required minLength={2} maxLength={120} value={form.name} onChange={field("name")} placeholder="Ana López" autoComplete="name" /></label>
        <label className="auth-field">Nombre profesional o consultorio<input required minLength={2} maxLength={120} value={form.business} onChange={field("business")} placeholder="Dra. Ana López" /></label>
        <label className="auth-field">Especialidad<select value={form.specialty} onChange={field("specialty")}>{specialties.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="auth-field">Provincia<select required value={form.province} onChange={field("province")}><option value="">Seleccioná una provincia</option>{provinces.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="auth-field">Ciudad<input required value={form.city} onChange={field("city")} placeholder="Tu ciudad" /></label>
        <AuthFixedField label="Zona horaria" value={DEFAULT_TIMEZONE_LABEL} />
      </div>
      {error && <AuthMessage tone="error" id="auth-error">{error}</AuthMessage>}
      <button className="auth-button" type="submit" disabled={busy}>{busy ? "Creando tu espacio…" : "Crear mi espacio"}</button>
      <p className="auth-note">Después vas a configurar tu primera sesión y tus horarios. Lleva menos de 2 minutos.</p>
    </form>
  </>}</AuthShell>;
}
