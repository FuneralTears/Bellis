"use client";

import type { ChangeEvent, FormEvent, ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CircleCheck, Clock3 } from "lucide-react";
import BellisLogo from "@/components/brand/BellisLogo";
import { AuthHeading, AuthLoading, AuthMessage, friendlyAuthError } from "@/components/auth/AuthUi";
import { DEFAULT_TIMEZONE_LABEL, formatMoney } from "@/lib/market";
import "./onboarding.css";

/**
 * Presentation of /onboarding. Nothing here saves or decides where to go: the page keeps
 * the form state, the validation and the save, and the demo drives the same screens with mock state.
 * Fields and controls reuse the auth styles so sign-up and first steps read as one flow.
 */

export type OnboardingForm = {
  service: string; description: string; price: string; duration: string; mode: string;
  start: string; end: string; breakStart: string; breakEnd: string; notice: string; buffer: string;
};
type FieldHandler = (key: keyof OnboardingForm) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;

const weekdays = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
// The account already exists when someone gets here, so it counts as the first step done.
const steps = ["Tu cuenta", "Tu consulta", "Tus horarios"];

export function OnboardingShell({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return <div className="onb-shell auth-shell">
    <header className="onb-header"><Link href="/" aria-label="Bellis, ir al inicio"><BellisLogo /></Link>{action}</header>
    <main className="onb-main">{children}</main>
  </div>;
}

/** The page could not open the flow at all: say it plainly and offer the way back. */
export function OnboardingBlocked({ message }: { message: string }) {
  return <section className="auth-card auth-card-wide"><AuthHeading title="No pudimos continuar" />
    <div className="auth-form"><AuthMessage tone="error">{friendlyAuthError(message)}</AuthMessage><a className="auth-button" href="/ingresar">Volver a iniciar sesión</a></div>
  </section>;
}

export function OnboardingLoading() {
  return <section className="auth-card auth-card-wide"><AuthLoading>Preparando tu espacio…</AuthLoading></section>;
}

function Progress({ step }: { step: 1 | 2 }) {
  return <div className="onb-progress">
    <p><b>Paso {step + 1} de {steps.length}</b>{step === 1 ? <span>Después: {steps[2].toLowerCase()}</span> : <span>Último paso</span>}</p>
    <div className="onb-bar" role="progressbar" aria-label="Avance de los primeros pasos" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={step + 1} aria-valuetext={`Paso ${step + 1} de ${steps.length}: ${steps[step]}`}><span style={{ width: `${((step + 1) / steps.length) * 100}%` }} /></div>
    <ol>{steps.map((label, index) => <li key={label} className={index < step ? "done" : index === step ? "current" : ""} aria-current={index === step ? "step" : undefined}>{index < step && <Check size={14} aria-hidden />}{label}</li>)}</ol>
  </div>;
}

/** The two steps. `step`, the values and every handler belong to the caller. */
export function OnboardingSteps({ step, form, days, busy, error, onField, onToggleDay, onSubmit, onBack }: {
  step: 1 | 2; form: OnboardingForm; days: boolean[]; busy: boolean; error: string;
  onField: FieldHandler; onToggleDay: (index: number) => void; onSubmit: (event: FormEvent) => void; onBack: () => void;
}) {
  return <>
    <Progress step={step} />
    <section className="auth-card auth-card-wide">
      {step === 1 ? <AuthHeading title="¿Qué consulta ofrecés?">Creá la primera consulta que tus pacientes van a poder reservar. Después podés agregar más desde tu panel.</AuthHeading>
        : <AuthHeading title="¿Cuándo atendés?">Elegí los días y horarios en los que tus pacientes pueden reservar.</AuthHeading>}
      <form className="auth-form" onSubmit={onSubmit} aria-describedby={error ? "onb-error" : undefined}>
        {step === 1 ? <div className="auth-grid">
          <label className="auth-field auth-full">Nombre de la consulta<input required value={form.service} onChange={onField("service")} /></label>
          <label className="auth-field auth-full">Descripción (opcional)<textarea value={form.description} onChange={onField("description")} placeholder="Contá brevemente qué incluye" /></label>
          <label className="auth-field">Precio (ARS)<input required type="number" inputMode="numeric" min="1" max="9999999" value={form.price} onChange={onField("price")} /></label>
          <label className="auth-field">Duración<select value={form.duration} onChange={onField("duration")}>{[30, 45, 50, 60, 75, 90, 120].map((value) => <option value={value} key={value}>{value} minutos</option>)}</select></label>
          <label className="auth-field auth-full">Modalidad<select value={form.mode} onChange={onField("mode")}><option>Online</option><option>Presencial</option><option>Ambas</option></select></label>
        </div> : <>
          <fieldset className="onb-days"><legend>Días de atención</legend>
            <div>{weekdays.map((day, index) => <button type="button" key={day} aria-pressed={days[index]} aria-label={day} onClick={() => onToggleDay(index)}>{day.slice(0, 3)}</button>)}</div>
          </fieldset>
          <div className="auth-grid onb-pairs">
            <label className="auth-field">Atendés desde<input type="time" value={form.start} onChange={onField("start")} /></label>
            <label className="auth-field">Atendés hasta<input type="time" value={form.end} onChange={onField("end")} /></label>
            <label className="auth-field">Descanso desde<input type="time" value={form.breakStart} onChange={onField("breakStart")} /></label>
            <label className="auth-field">Descanso hasta<input type="time" value={form.breakEnd} onChange={onField("breakEnd")} /></label>
          </div>
          <div className="auth-grid">
            <label className="auth-field">Anticipación mínima<select value={form.notice} onChange={onField("notice")}><option value="1">1 hora</option><option value="12">12 horas</option><option value="24">24 horas</option><option value="48">48 horas</option></select><small>Con cuánto tiempo de anticipación se puede reservar.</small></label>
            <label className="auth-field">Tiempo entre turnos<select value={form.buffer} onChange={onField("buffer")}><option value="0">Sin pausa</option><option value="10">10 minutos</option><option value="15">15 minutos</option><option value="30">30 minutos</option></select><small>Un respiro entre un paciente y el siguiente.</small></label>
          </div>
          <p className="onb-why"><Clock3 size={18} aria-hidden /><span>Bellis usa estos horarios para mostrar turnos disponibles a tus pacientes. Zona horaria: {DEFAULT_TIMEZONE_LABEL}.</span></p>
        </>}
        {error && <AuthMessage tone="error" id="onb-error">{error}</AuthMessage>}
        <div className="onb-actions">
          <button className="auth-button" type="submit" disabled={busy}>{busy ? "Guardando…" : step === 1 ? "Continuar" : "Guardar y terminar"}{!busy && <ArrowRight size={17} aria-hidden />}</button>
          {step === 2 && <button type="button" className="onb-back" onClick={onBack} disabled={busy}><ArrowLeft size={17} aria-hidden /> Volver</button>}
        </div>
        <p className="auth-note">{step === 1 ? "Todo esto lo podés cambiar después desde tu panel." : "Al terminar guardamos tu consulta y tus horarios. Podés cambiarlos cuando quieras."}</p>
      </form>
    </section>
  </>;
}

const laterItems = [
  ["Cómo cobrás", "Elegí cómo te van a pagar tus pacientes, en Perfil → Cobros y pagos."],
  ["Tu preconsulta", "Las preguntas que responden tus pacientes antes de reservar, en Formularios."],
];

/** Shown once the save went through: what was set up, what can wait, and the way into the panel. */
export function OnboardingDone({ form, days, actions }: { form: OnboardingForm; days: boolean[]; actions: ReactNode }) {
  const activeDays = weekdays.filter((_, index) => days[index]).map((day) => day.slice(0, 3)).join(", ");
  const summary = [
    ["Tu cuenta", "Creada"],
    ["Tu consulta", `${form.service} · ${form.duration} minutos · ${formatMoney(Number(form.price))} · ${form.mode}`],
    ["Tus horarios", `${activeDays} · ${form.start} a ${form.end} · Descanso de ${form.breakStart} a ${form.breakEnd}`],
  ];
  return <section className="auth-card auth-card-wide onb-done">
    <span className="auth-notice-mark"><CircleCheck size={26} aria-hidden /></span>
    <h1>Ya podés empezar a usar Bellis</h1>
    <p className="onb-done-lead" role="status">Guardamos tu consulta y tus horarios. Podés completar el resto desde tu panel.</p>
    <ul className="onb-summary">{summary.map(([label, value]) => <li key={label}><Check size={16} aria-hidden /><span><b>{label}</b>{value}</span></li>)}</ul>
    <div className="onb-later"><h2>Para después</h2>
      <ul>{laterItems.map(([label, value]) => <li key={label}><b>{label}</b>{value}</li>)}</ul>
    </div>
    <div className="auth-actions">{actions}</div>
  </section>;
}
