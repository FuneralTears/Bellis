import type { ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, CalendarDays, Check, Clock3, Globe2, MapPin } from "lucide-react";
import BellisLogo from "@/components/brand/BellisLogo";
import "./booking.css";

/**
 * Presentation of the public booking, shared by /p/[slug] and its demo.
 * Nothing here reads data, calls the backend or decides the flow: every
 * component only draws what its host passes in.
 */

/** Stages the patient sees. Informative only: the host decides which one is current. */
export const BOOKING_STEPS = ["Servicio", "Preconsulta", "Pago", "Horario", "Confirmación"] as const;

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export function initialsOf(name: string) {
  return name.split(" ").slice(-2).map((part) => part[0]).join("").toUpperCase();
}

/** Human label and tone for a payment status; unknown values are shown as they arrive. */
export function paymentStatusInfo(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "pending": return { label: "Pago pendiente", tone: "warning" };
    case "approved": return { label: "Pago confirmado", tone: "success" };
    case "rejected": return { label: "Pago rechazado", tone: "danger" };
    case "cancelled": return { label: "Pago cancelado", tone: "danger" };
    case "expired": return { label: "Pago vencido", tone: "danger" };
    case "refunded": return { label: "Pago reembolsado", tone: "neutral" };
    default: return { label: status, tone: "neutral" };
  }
}

export function BookingShell({ professional, banner, children }: { professional?: string; banner?: ReactNode; children: ReactNode }) {
  return <div className="bk-shell">
    {banner}
    <header className="bk-header"><div className="bk-header-inner">
      <Link className="bk-brand" href="/" aria-label="Bellis, ir al inicio"><BellisLogo size="sm" /></Link>
      {professional && <p className="bk-header-pro"><span>Reserva de turnos</span><b>{professional}</b></p>}
    </div></header>
    <main className="bk-wrap">{children}</main>
    <footer className="bk-footer">Bellis · Turnos para profesionales</footer>
  </div>;
}

/** First view: who the patient is booking with. Empty fields are simply not drawn. */
export function ProfessionalIntro({ name, specialty, modalities, location }: { name: string; specialty?: string | null; modalities: string[]; location?: string }) {
  return <div className="bk-pro">
    <div className="bk-avatar" aria-hidden="true">{initialsOf(name)}</div>
    <div className="bk-pro-copy">
      <h1>{name}</h1>
      {specialty && <p>{specialty}</p>}
      {(modalities.length > 0 || location) && <div className="bk-meta">
        {modalities.length > 0 && <span><Globe2 size={16}/> {modalities.join(" · ")}</span>}
        {location && <span><MapPin size={16}/> {location}</span>}
      </div>}
    </div>
  </div>;
}

export function BookingPanel({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return <section className={`bk-panel ${className}`}>{title && <h2>{title}</h2>}{children}</section>;
}

export function ServiceCard({ name, description, duration, modality, price, disabled, onReserve }: { name: string; description?: string | null; duration: number; modality?: string; price: string; disabled?: boolean; onReserve: () => void }) {
  return <article className="bk-service">
    <div className="bk-service-copy">
      <h3>{name}</h3>
      {description && <p>{description}</p>}
      <div className="bk-meta"><span><Clock3 size={15}/> {duration} minutos</span>{modality && <span><CalendarDays size={15}/> {modality}</span>}</div>
    </div>
    <div className="bk-service-action">
      <strong>{price}</strong>
      <button className="bk-button" type="button" disabled={disabled} onClick={onReserve}>Reservar turno <ArrowRight size={16}/></button>
    </div>
  </article>;
}

export function HowItWorks({ points }: { points: string[] }) {
  return <aside className="bk-panel bk-how">
    <h2>Tu turno, paso a paso</h2>
    <ol>{["Elegí un servicio", "Completá la preconsulta", "Realizá el pago", "Elegí tu horario"].map((label, index) => <li key={label}><b>{index + 1}</b>{label}</li>)}</ol>
    <ul>{points.map((point) => <li key={point}><Check size={16}/> {point}</li>)}</ul>
  </aside>;
}

/** `current` is an index into BOOKING_STEPS; `complete` marks the whole flow as done. */
export function BookingStepper({ current, complete = false }: { current: number; complete?: boolean }) {
  return <nav className="bk-stepper" aria-label="Progreso de la reserva">
    <p className="bk-stepper-now" aria-hidden="true">Paso {current + 1} de {BOOKING_STEPS.length} · <b>{BOOKING_STEPS[current]}</b></p>
    <ol>{BOOKING_STEPS.map((label, index) => {
      const done = complete || index < current;
      const state = done ? "is-done" : index === current ? "is-current" : "";
      return <li key={label} className={state} aria-current={!done && index === current ? "step" : undefined}><b>{done ? <Check size={14}/> : index + 1}</b><span>{label}</span></li>;
    })}</ol>
  </nav>;
}

/** Keeps the professional and the chosen service in view while the patient moves through the steps. */
export function BookingContext({ name, detail }: { name: string; detail: string }) {
  return <div className="bk-context"><span className="bk-avatar bk-avatar-sm" aria-hidden="true">{initialsOf(name)}</span><p><b>{name}</b><span>{detail}</span></p></div>;
}

export function BookingCard({ icon, eyebrow, badge, title, description, center = false, children }: { icon?: ReactNode; eyebrow?: string; badge?: ReactNode; title: string; description?: ReactNode; center?: boolean; children?: ReactNode }) {
  return <section className={center ? "bk-card bk-card-center" : "bk-card"}>
    {icon}
    {(eyebrow || badge) && <div className="bk-card-top">{eyebrow && <span className="bk-eyebrow">{eyebrow}</span>}{badge}</div>}
    <h1>{title}</h1>
    {description && <p className="bk-card-description">{description}</p>}
    {children}
  </section>;
}

type SummaryRow = [label: string, value: ReactNode] | false | null | undefined | "";

export function SummaryList({ rows, total }: { rows: SummaryRow[]; total?: [label: string, value: ReactNode] }) {
  return <dl className="bk-summary">
    {rows.map((row) => row ? <div key={row[0]}><dt>{row[0]}</dt><dd>{row[1]}</dd></div> : null)}
    {total && <div className="bk-summary-total"><dt>{total[0]}</dt><dd>{total[1]}</dd></div>}
  </dl>;
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`bk-badge bk-tone-${tone}`}>{children}</span>;
}

export function Notice({ tone = "info", icon, title, children }: { tone?: Tone; icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className={`bk-notice bk-tone-${tone}`}>{icon}<div><b>{title}</b>{children && <p>{children}</p>}</div></div>;
}

export function BookingAlert({ children }: { children: ReactNode }) {
  return <p className="bk-alert" role="alert"><AlertCircle size={18}/> <span>{children}</span></p>;
}

/** Date field plus the times for that day. The host loads the slots and owns the selection. */
export function SlotPicker({ day, onDay, busy, slots, selected, onSelect }: { day: string; onDay: (day: string) => void; busy: boolean; slots: { value: string; label: string }[]; selected: string; onSelect: (value: string) => void }) {
  return <div className="bk-slot-picker">
    <label className="bk-field">Fecha <input type="date" value={day} onChange={(event) => onDay(event.target.value)} /></label>
    <h2 className="bk-subtitle">Horarios disponibles</h2>
    {busy ? <div className="bk-slots" role="status" aria-label="Cargando horarios…">{[0, 1, 2, 3, 4, 5].map((item) => <span className="bk-skeleton" key={item} />)}</div>
      : !day ? <p className="bk-empty"><CalendarDays size={20}/> Elegí una fecha para ver horarios.</p>
      : !slots.length ? <p className="bk-empty"><Clock3 size={20}/> No hay horarios disponibles ese día.</p>
      : <div className="bk-slots" role="group" aria-label="Horarios disponibles">{slots.map((item) => <button key={item.value} type="button" className={selected === item.value ? "on" : ""} aria-pressed={selected === item.value} onClick={() => onSelect(item.value)}>{item.label}</button>)}</div>}
  </div>;
}

export function BookingLoading({ label }: { label: string }) {
  return <section className="bk-card bk-loading" role="status"><span className="bk-skeleton bk-skeleton-avatar" /><span className="bk-skeleton bk-skeleton-title" /><span className="bk-skeleton bk-skeleton-line" /><span className="bk-skeleton bk-skeleton-line short" /><p>{label}</p></section>;
}

/** Full-card message for dead ends such as a profile that does not exist. */
export function BookingMessage({ title, children }: { title: string; children: ReactNode }) {
  return <section className="bk-card bk-card-center bk-message" role="alert"><span className="bk-mark bk-tone-neutral"><CalendarDays size={26}/></span><h1>{title}</h1><p className="bk-card-description">{children}</p></section>;
}

export function SuccessMark() {
  return <span className="bk-mark bk-tone-success"><Check size={28}/></span>;
}
