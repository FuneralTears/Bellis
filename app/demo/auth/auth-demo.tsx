"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DEFAULT_TIMEZONE_LABEL } from "@/lib/market";
import { AuthFixedField, AuthHeading, AuthMessage, AuthNotice, AuthShell, PasswordField } from "@/components/auth/AuthUi";
import "./auth-demo.css";

/**
 * Showroom of /ingresar, /registro and /recuperar. Same components and copy as the product,
 * but every form only moves local state: no Supabase, no session, no emails.
 */

type Screen = "ingresar" | "registro" | "recuperar";
type Step = "form" | "sent" | "update" | "done";
const screens: { key: Screen; label: string }[] = [
  { key: "ingresar", label: "Ingresar" },
  { key: "registro", label: "Registro" },
  { key: "recuperar", label: "Recuperar" },
];
const specialties = ["Psicología", "Odontología", "Kinesiología", "Nutrición", "Psicopedagogía", "Otro"];
const provinces = ["Buenos Aires", "CABA", "Córdoba", "Santa Fe", "Mendoza"];

export default function AuthDemo() {
  const [{ screen, step }, setView] = useState<{ screen: Screen; step: Step }>({ screen: "ingresar", step: "form" });
  const go = (next: Screen, nextStep: Step = "form") => setView({ screen: next, step: nextStep });
  const mock = (nextStep: Step) => (event: React.FormEvent) => { event.preventDefault(); go(screen, nextStep); };

  return <div className="auth-demo">
    <nav className="auth-demo-bar" aria-label="Pantallas de acceso de la demo">
      <Link className="auth-demo-back" href="/demo"><ArrowLeft size={16} aria-hidden /> Volver a la demo</Link>
      <div className="auth-demo-tabs">{screens.map(({ key, label }) => <button key={key} type="button" aria-current={screen === key ? "page" : undefined} onClick={() => go(key)}>{label}</button>)}</div>
      <p className="auth-demo-note"><span>Demo interactiva</span> No se crean cuentas, no se inicia sesión ni se envían emails.</p>
    </nav>
    <AuthShell wide={screen === "registro" && step === "form"}>
      {screen === "ingresar" && <>
        <AuthHeading title="Iniciá sesión">Entrá a tu espacio de Bellis.</AuthHeading>
        <form className="auth-form" onSubmit={mock("done")}>
          <label className="auth-field">Email<input type="email" autoComplete="off" required defaultValue="ana@consultorio.com" /></label>
          <PasswordField label="Contraseña" autoComplete="off" required />
          <button type="button" className="auth-link auth-forgot" onClick={() => go("recuperar")}>¿Olvidaste tu contraseña?</button>
          {step === "done" && <AuthMessage tone="info">En la demo no se inicia sesión. En Bellis, acá entrarías a tu espacio.</AuthMessage>}
          <button className="auth-button" type="submit">Iniciar sesión</button>
        </form>
        <p className="auth-alt">¿Todavía no tenés cuenta? <button type="button" className="auth-link" onClick={() => go("registro")}>Crear cuenta</button></p>
      </>}

      {screen === "registro" && (step === "sent" ? <AuthNotice title="Revisá tu email" actions={<button type="button" className="auth-button" onClick={() => go("ingresar")}>Ir a iniciar sesión</button>}>
        <p>Si ese email puede registrarse, te enviamos un enlace para confirmar tu cuenta. Después iniciá sesión para terminar de configurar tu espacio.</p>
        <p>Si no lo encontrás, revisá Spam o Correo no deseado.</p>
        <p>¿Ya tenías cuenta? <button type="button" className="auth-link" onClick={() => go("recuperar")}>Recuperá tu acceso</button>.</p>
      </AuthNotice> : <>
        <AuthHeading title="Creá tu cuenta">Empezá a organizar tu consulta con Bellis.</AuthHeading>
        <form className="auth-form" onSubmit={mock("sent")}>
          <div className="auth-grid">
            <label className="auth-field">Tu nombre<input required placeholder="Ana López" autoComplete="off" /></label>
            <label className="auth-field">Nombre profesional o consultorio<input required placeholder="Dra. Ana López" autoComplete="off" /></label>
            <label className="auth-field">Especialidad<select>{specialties.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="auth-field">Email<input required type="email" placeholder="ana@consultorio.com" autoComplete="off" /></label>
            <PasswordField label="Contraseña" hint="Mínimo 8 caracteres." required minLength={8} autoComplete="off" />
            <label className="auth-field">Provincia<select required defaultValue=""><option value="">Seleccioná una provincia</option>{provinces.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="auth-field">Ciudad<input required placeholder="Tu ciudad" autoComplete="off" /></label>
            <AuthFixedField label="Zona horaria" value={DEFAULT_TIMEZONE_LABEL} />
          </div>
          <button className="auth-button" type="submit">Crear cuenta</button>
          <p className="auth-note">Después vas a configurar tu primera sesión y tus horarios. Lleva menos de 2 minutos.</p>
        </form>
        <p className="auth-alt">¿Ya tenés cuenta? <button type="button" className="auth-link" onClick={() => go("ingresar")}>Iniciá sesión</button></p>
      </>)}

      {screen === "recuperar" && (step === "done" ? <AuthNotice title="Tu contraseña se actualizó correctamente" actions={<button type="button" className="auth-button" onClick={() => go("ingresar")}>Ir a iniciar sesión</button>}>
        <p>Ya podés entrar con tu nueva contraseña.</p>
      </AuthNotice> : step === "sent" ? <AuthNotice title="Revisá tu email" actions={<>
        <button type="button" className="auth-button" onClick={() => go("ingresar")}>Volver a iniciar sesión</button>
        <button type="button" className="auth-link" onClick={() => go("recuperar")}>Probar con otro email</button>
        <button type="button" className="auth-link" onClick={() => go("recuperar", "update")}>Demo: abrir el enlace del email</button>
      </>}>
        <p>Si hay una cuenta con ese email, te enviamos un enlace para restablecer tu contraseña.</p>
        <p>Si no lo encontrás, revisá Spam o Correo no deseado.</p>
      </AuthNotice> : <>
        <AuthHeading title={step === "update" ? "Elegí una nueva contraseña" : "Recuperá tu acceso"}>{step === "update" ? "Es la que vas a usar para entrar a Bellis de ahora en adelante." : "Te vamos a enviar un enlace para que puedas elegir una nueva contraseña."}</AuthHeading>
        <form className="auth-form" key={step} onSubmit={mock(step === "update" ? "done" : "sent")}>
          {step === "update" ? <PasswordField label="Nueva contraseña" hint="Mínimo 8 caracteres." autoComplete="off" minLength={8} required />
            : <label className="auth-field">Email<input type="email" autoComplete="off" required defaultValue="ana@consultorio.com" /></label>}
          <button className="auth-button">{step === "update" ? "Guardar nueva contraseña" : "Enviar enlace"}</button>
        </form>
        <p className="auth-alt"><button type="button" className="auth-link" onClick={() => go("ingresar")}>Volver a iniciar sesión</button></p>
      </>)}
    </AuthShell>
  </div>;
}
