"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, CircleCheck, Eye, EyeOff, Info } from "lucide-react";
import BellisLogo from "@/components/brand/BellisLogo";
import "./auth.css";

/**
 * Presentation of /ingresar, /registro and /recuperar. Nothing here talks to
 * Supabase or decides where to go: each page keeps its own auth logic.
 */

export function AuthShell({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return <div className="auth-shell">
    <header className="auth-header"><Link href="/" aria-label="Bellis, ir al inicio"><BellisLogo /></Link><p>Menos gestión, más pacientes.</p></header>
    <main className={wide ? "auth-card auth-card-wide" : "auth-card"}>{children}</main>
  </div>;
}

export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="auth-heading"><h1>{title}</h1>{children && <p>{children}</p>}</div>;
}

type Tone = "error" | "success" | "info";
const toneIcon = { error: AlertCircle, success: CircleCheck, info: Info };
/** Message inside a form. Errors are announced as alerts; the icon keeps the meaning without relying on color. */
export function AuthMessage({ tone, id, children }: { tone: Tone; id?: string; children: ReactNode }) {
  const Icon = toneIcon[tone];
  return <p id={id} className={`auth-message auth-${tone}`} role={tone === "error" ? "alert" : "status"}><Icon size={18} aria-hidden /><span>{children}</span></p>;
}

/** A whole-card outcome: what happened, what to do next, and the action. */
export function AuthNotice({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
  return <div className="auth-notice"><span className="auth-notice-mark"><CircleCheck size={26} aria-hidden /></span><h1>{title}</h1><div className="auth-notice-copy" role="status">{children}</div><div className="auth-actions">{actions}</div></div>;
}

export function AuthLoading({ children }: { children: ReactNode }) {
  return <p className="auth-loading" role="status">{children}</p>;
}

/** A value the person sees but does not choose. Looks like a field so it sits in the form grid; it is not a control. */
export function AuthFixedField({ label, value }: { label: string; value: string }) {
  const labelId = useId();
  return <div className="auth-field" role="group" aria-labelledby={labelId}><span id={labelId}>{label}</span><span className="auth-fixed">{value}</span></div>;
}

/** Password input with a show/hide control. It only switches the input type; the value and its handlers stay with the page. */
export function PasswordField({ label, hint, ...input }: { label: string; hint?: string } & Omit<React.ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  const hintId = useId();
  return <label className="auth-field">{label}
    <span className="auth-password">
      <input {...input} type={visible ? "text" : "password"} aria-describedby={hint ? hintId : undefined} />
      <button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"} aria-pressed={visible}>{visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}</button>
    </span>
    {hint && <small id={hintId}>{hint}</small>}
  </label>;
}

// Wording only. The auth helpers already classify the failure; these are the same cases said more plainly.
const rewording: Record<string, string> = {
  "No pudimos ingresar. Revisá el email y la contraseña.": "No pudimos iniciar sesión. Revisá tu email y contraseña.",
  "Ingresá un email válido.": "Revisá que el email esté escrito correctamente.",
  "Elegí una contraseña más segura, de al menos 8 caracteres.": "Usá una contraseña de al menos 8 caracteres.",
};
const technical = /fetch|network|load failed|jwt|token|unexpected|invalid|error|supabase|timeout|undefined|null/i;
/** What to show for an error text: reworded when it is a known case, generic when it is a raw technical message. */
export function friendlyAuthError(text: string): string {
  if (rewording[text]) return rewording[text];
  return technical.test(text) ? "No pudimos completar la acción. Intentá de nuevo." : text;
}
