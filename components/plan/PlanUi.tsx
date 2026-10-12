"use client";

import { useState, type ReactNode } from "react";
import { Check, CircleCheck, Info, Lock, Sparkles } from "lucide-react";
import { describeUpgradeError, planNotice, planNoticeKey, planStatus, proBenefits, proPrice, upgradeRequestMessage, bookingsPausedCopy, type WorkspaceAccess } from "@/lib/entitlements";
import "./plan-ui.css";

/**
 * How the plan shows in the panel and in its demo: the notice of the trial, the locked state of what belongs to
 * Bellis Pro, and the Bellis Pro page. Presentation only. What the plan includes is decided on the server and
 * read through lib/entitlements; nothing here looks at dates or plan codes.
 */

/** "Bellis Pro" with a lock: text and icon, never colour alone. */
export function ProBadge() {
  return <span className="plan-badge"><Lock size={13} aria-hidden /> Bellis Pro</span>;
}

/** A part of the product that is waiting for Bellis Pro: what it is, why it helps, and where to learn more. */
export function ProLock({ title, text, action, compact = false }: { title: string; text: string; action?: ReactNode; compact?: boolean }) {
  return <section className={compact ? "plan-lock plan-lock-compact" : "plan-lock"} aria-label={`${title}. Disponible con Bellis Pro.`}>
    <div className="plan-lock-head"><h3>{title}</h3><ProBadge /></div>
    <p>{text}</p>
    {action && <div className="plan-actions">{action}</div>}
  </section>;
}

/**
 * The one card of the plan in the summary. While the trial runs it says how long is left. Once it ended it is
 * said once: "Entendido" puts that away on this device and the card goes back to a quiet line with the plan.
 * Bellis Pro shows without a call to action: there is nothing to sell to who already has it.
 */
export function PlanNoticeCard({ access, usesMercadoPago, action }: { access: WorkspaceAccess | null; usesMercadoPago?: boolean; action?: ReactNode }) {
  const key = access ? `bellis-plan-notice:${planNoticeKey(access)}` : "";
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return typeof window === "undefined" ? null : window.localStorage.getItem("bellis-plan-notice"); } catch { return null; } });
  const notice = planNotice(access, { usesMercadoPago, endedSeen: dismissed === key });
  if (!notice) return null;
  const quiet = notice.kind === "free" || notice.kind === "pro";
  const dismiss = () => { setDismissed(key); try { window.localStorage.setItem("bellis-plan-notice", key); } catch { /* Shown again next time: nothing is lost. */ } };
  const Icon = notice.kind === "trial_ended" ? Info : notice.kind === "pro" ? CircleCheck : Sparkles;
  return <section className={`plan-notice plan-notice-${notice.kind}${quiet ? " plan-notice-quiet" : ""}`} role="status" aria-label="Tu plan">
    <span className="plan-notice-icon"><Icon size={18} aria-hidden /></span>
    <div><b>{notice.title}</b>{notice.text && <p>{notice.text}</p>}</div>
    {(notice.kind !== "pro" || notice.dismissible) && <div className="plan-actions">{notice.kind !== "pro" && action}{notice.dismissible && <button type="button" className="plan-quiet" onClick={dismiss}>Entendido</button>}</div>}
  </section>;
}

/** One notice, in the summary: online bookings are on hold and what can be done about it. */
export function BookingsPausedNotice({ useLink, learn }: { useLink: ReactNode; learn: ReactNode }) {
  return <section className="plan-notice plan-notice-paused" role="status">
    <span className="plan-notice-icon"><Info size={18} aria-hidden /></span>
    <div><b>{bookingsPausedCopy.title}</b><p>{bookingsPausedCopy.short}</p></div>
    <div className="plan-actions">{useLink}{learn}</div>
  </section>;
}

/**
 * The Bellis Pro page: what the plan is today, what Pro adds and how to ask for it. There is no checkout: the
 * button leaves a request and someone writes back. `onRequest` returns what the server answered.
 */
export function ProOverview({ access, canRequest, onRequest }: {
  access: WorkspaceAccess | null;
  /** Only who manages the workspace can ask for the plan. */
  canRequest: boolean;
  onRequest: () => Promise<{ created?: boolean }>;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>(access?.upgrade_requested ? upgradeRequestMessage({ created: false }) : "");
  const [error, setError] = useState("");
  const status = planStatus(access);
  const isPro = access?.tier === "pro";
  async function request() {
    if (busy) return;
    setBusy(true); setError("");
    try { setSent(upgradeRequestMessage(await onRequest())); }
    catch (caught) { setError(describeUpgradeError(caught instanceof Error ? caught.message : String(caught))); }
    finally { setBusy(false); }
  }
  return <div className="plan-page">
    {access && <section className="plan-status" aria-label="Tu plan"><CircleCheck size={20} aria-hidden /><div><b>{status.title}</b>{status.detail && <p>{status.detail}</p>}</div></section>}
    <section className="plan-hero">
      <h2>Bellis Pro</h2>
      <p className="plan-price">{proPrice}</p>
      <p className="plan-claim">Automatizá tareas y ahorrá tiempo en la gestión de tu práctica.</p>
      <ul className="plan-benefits">{proBenefits.map((item) => <li key={item.capability}><Check size={18} aria-hidden /><div><b>{item.title}</b><span>{item.text}</span></div></li>)}</ul>
      <p className="plan-free">Bellis Free es gratis para siempre: agenda, pacientes, turnos y cobros manuales, notas, seguimientos y tu página pública con link de pago.</p>
      {!isPro && <div className="plan-request">
        {sent ? <p className="plan-sent" role="status"><CircleCheck size={18} aria-hidden /> {sent}</p>
          : canRequest ? <button type="button" className="demo-primary plan-cta" disabled={busy} aria-busy={busy} onClick={() => void request()}>{busy ? "Enviando…" : "Quiero Bellis Pro"}</button>
          : <p className="plan-muted">Solo quien administra el espacio puede pedir Bellis Pro.</p>}
        {error && <p className="live-error" role="alert">{error} <button type="button" onClick={() => void request()}>Reintentar</button></p>}
        {!sent && canRequest && <p className="plan-muted">No se pide tarjeta ni se cobra nada ahora. Te escribimos al email de tu cuenta para activarlo.</p>}
      </div>}
    </section>
  </div>;
}
