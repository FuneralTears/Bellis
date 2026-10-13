"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { adminDate, adminDateTime, daysAgo, daysRemainingLabel, lastValidDay, planLine, type AdminRole, type AdminWorkspaceDetail } from "@/lib/admin";
import { actorLine, addToDay, argentinaDay, dayLabel, describePlanError, downgradeCopy, downgradeTrialNote, lastDayProblem, lastValidDayOf, mercadoPagoKeptCopy, periodBase,
  planActions, planChangeLabel, planDialogCopy, planShortcuts, proEndsAtForLastDay, requestActions, requestStatusLabels, resolutionLabel,
  type AdminPlanChange, type AdminUpgradeRequest, type PlanDialogMode, type PlanSubject, type RequestAction, type RequestStatus } from "@/lib/admin-plans";
import { AdminState, Fact, TierChip, WorkspaceLink, useClock, type OpenWorkspace } from "./AdminUi";

/**
 * Commercial actions of the backoffice, as pure presentation: activating, extending and removing Bellis Pro, and
 * closing upgrade requests. Every component takes what it shows and a callback; none of them talks to the server.
 * The buttons are only drawn for the 'admin' role, and that is a courtesy: the server refuses everyone else.
 */

function Dialog({ title, onClose, busy, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const id = useId(); const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("input, button:not(.bo-dialog-close)")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); };
    // Opened once per dialog: `busy` and `onClose` are read when the key is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="bo-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="bo-dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={box}>
      <div className="bo-dialog-head"><h2 id={id}>{title}</h2><button type="button" className="bo-dialog-close" onClick={onClose} disabled={busy} aria-label="Cerrar"><X size={18} aria-hidden /></button></div>
      {children}
    </div>
  </div>;
}

/**
 * Activate, extend or remove Bellis Pro for one workspace. For the first two the admin picks the last valid day;
 * `onConfirm` receives the instant the plan ends (or null when going back to Free) and may reject with the
 * server's error code.
 */
export function PlanDialog({ mode, subject, onConfirm, onClose }: { mode: PlanDialogMode; subject: PlanSubject; onConfirm: (proEndsAt: string | null) => Promise<void>; onClose: () => void }) {
  const clock = useClock(); const copy = planDialogCopy[mode];
  const base = periodBase(mode, subject, clock);
  const [day, setDay] = useState(() => addToDay(base, planShortcuts[0]));
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const current = lastValidDayOf(subject.pro_ends_at);
  const problem = mode === "downgrade" ? null : lastDayProblem(mode, day, subject, clock);
  const trialNote = mode === "downgrade" ? downgradeTrialNote(subject, clock) : null;
  async function confirm() {
    if (problem) return;
    setBusy(true); setError("");
    try { await onConfirm(mode === "downgrade" ? null : proEndsAtForLastDay(day)); }
    catch (caught) { setError(describePlanError(caught instanceof Error ? caught.message : "")); setBusy(false); }
  }
  return <Dialog title={copy.title} onClose={onClose} busy={busy}>
    <p className="bo-dialog-who">{subject.workspace_name}</p>
    {mode === "downgrade" ? <>
      <p>{downgradeCopy}</p>
      {trialNote && <p className="bo-dialog-note">{trialNote}</p>}
      {subject.mercado_pago_connected && <p className="bo-dialog-note">{mercadoPagoKeptCopy}</p>}
    </> : <>
      <div className="bo-shortcuts" role="group" aria-label={mode === "extend" ? "Cuánto extender" : "Por cuánto tiempo"}>{planShortcuts.map((shortcut) => {
        const target = addToDay(base, shortcut);
        return <button key={shortcut.key} type="button" className={target === day ? "active" : ""} aria-pressed={target === day} disabled={busy} onClick={() => { setDay(target); setError(""); }}>{mode === "extend" ? `+${shortcut.label}` : shortcut.label}</button>;
      })}</div>
      <label className="bo-field">{mode === "extend" ? "Nuevo último día de Bellis Pro" : "Último día de Bellis Pro"}
        <input type="date" value={day} min={argentinaDay(clock)} disabled={busy} onChange={(event) => { setDay(event.target.value); setError(""); }} /></label>
      <dl className="bo-dialog-dates">
        {mode === "extend" && <div><dt>Actual</dt><dd>{dayLabel(current)}</dd></div>}
        <div><dt>{mode === "extend" ? "Nuevo vencimiento" : "Bellis Pro hasta el"}</dt><dd>{problem ? "—" : dayLabel(day)}</dd></div>
      </dl>
      {mode === "extend" && <p className="bo-dialog-note">Se cuenta desde el vencimiento actual, no desde hoy: el tiempo que ya tenía no se pierde.</p>}
    </>}
    {(error || problem) && <p className="bo-dialog-error" role="alert">{error || problem}</p>}
    <div className="bo-dialog-actions">
      <button type="button" className="bo-button" onClick={onClose} disabled={busy}>Cancelar</button>
      <button type="button" className={mode === "downgrade" ? "bo-button bo-button-danger" : "bo-button bo-button-primary"} onClick={() => void confirm()} disabled={busy || !!problem} aria-busy={busy}>{busy ? "Guardando…" : copy.cta}</button>
    </div>
  </Dialog>;
}

/** Closing a request without changing the plan: resolved by hand, or dismissed. */
export function RequestDialog({ action, request, onConfirm, onClose }: { action: Exclude<RequestAction, "activate">; request: Pick<AdminUpgradeRequest, "workspace_name">; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const resolve = action === "resolve";
  async function confirm() { setBusy(true); setError(""); try { await onConfirm(); } catch (caught) { setError(describePlanError(caught instanceof Error ? caught.message : "")); setBusy(false); } }
  return <Dialog title={resolve ? "Resolver sin activar" : "Descartar solicitud"} onClose={onClose} busy={busy}>
    <p className="bo-dialog-who">{request.workspace_name}</p>
    <p>{resolve ? "La solicitud queda resuelta y el plan del consultorio no cambia. Usalo cuando ya lo hablaste con la persona y no corresponde activar Bellis Pro ahora."
      : "La solicitud queda descartada y el plan del consultorio no cambia. El consultorio puede volver a pedir Bellis Pro cuando quiera."}</p>
    {error && <p className="bo-dialog-error" role="alert">{error}</p>}
    <div className="bo-dialog-actions">
      <button type="button" className="bo-button" onClick={onClose} disabled={busy}>Cancelar</button>
      <button type="button" className="bo-button bo-button-primary" onClick={() => void confirm()} disabled={busy} aria-busy={busy}>{busy ? "Guardando…" : resolve ? "Marcar como resuelta" : "Descartar solicitud"}</button>
    </div>
  </Dialog>;
}

const actionLabels: Record<PlanDialogMode, string> = { activate: "Activar Pro", extend: "Extender Pro", downgrade: "Volver a Free" };
/** "Plan comercial" of one workspace: where it stands, what can be done about it and what was done before. */
export function PlanCommercialPanel({ detail, changes, role, notice, onAction }: {
  detail: AdminWorkspaceDetail; changes: AdminPlanChange[]; role: AdminRole | null; notice?: string; onAction: (mode: PlanDialogMode) => void;
}) {
  const d = detail; const actions = planActions(d, role); const remaining = daysRemainingLabel(d.days_remaining);
  return <section className="bo-card bo-card-wide" aria-labelledby="bo-commercial"><h2 id="bo-commercial">Plan comercial</h2>
    <p className="bo-plan-now"><TierChip tier={d.effective_tier} suspended={d.status === "suspended"} /><b>{planLine(d)}</b>{remaining && <span>{remaining}</span>}</p>
    {notice && <p className="bo-notice" role="status">{notice}</p>}
    <dl className="bo-facts">
      <Fact label="Plan guardado">{d.plan_code === "pro" ? "Pro" : "Free"}</Fact>
      <Fact label="Prueba termina">{d.trial_ends_at ? lastValidDay(d.trial_ends_at) : "Todavía no empezó"}</Fact>
      <Fact label="Pro desde">{d.pro_started_at ? adminDate(d.pro_started_at) : "—"}</Fact>
      <Fact label="Pro hasta">{d.pro_ends_at ? lastValidDay(d.pro_ends_at) : "—"}</Fact>
      <Fact label="Días restantes">{d.days_remaining === null || d.days_remaining === undefined ? "—" : d.days_remaining}</Fact>
      <Fact label="Solicitud de Pro abierta">{d.upgrade_request_open ? `Sí, del ${adminDate(d.upgrade_requested_at)}` : "No"}</Fact>
    </dl>
    {actions.length > 0 ? <div className="bo-actions">{actions.map((mode) => <button key={mode} type="button" className={mode === "downgrade" ? "bo-button" : "bo-button bo-button-primary"} onClick={() => onAction(mode)}>{actionLabels[mode]}</button>)}</div>
      : role === "support" && <p className="bo-note">Los cambios de plan los hace una persona con rol admin.</p>}
    <h3 className="bo-subhead">Cambios comerciales</h3>
    {changes.length ? <ol className="bo-events">{changes.map((change) => <li key={change.id} className="bo-event bo-event-plan"><span className="bo-event-dot" aria-hidden />
      <div><b>{planChangeLabel(change)}</b><small className="bo-muted bo-actor">{actorLine(change)}</small></div><time dateTime={change.created_at}>{adminDateTime(change.created_at)}</time></li>)}</ol>
      : <p className="bo-note">Todavía no hubo cambios hechos por el equipo.</p>}
  </section>;
}

/** Solicitudes Pro: filter by state, the oldest open one first, and what can be done with each. */
export function UpgradeRequestsView({ rows, status, onStatus, role, open, notice, onAct }: {
  rows: AdminUpgradeRequest[] | null; status: RequestStatus; onStatus: (status: RequestStatus) => void; role: AdminRole | null; open: OpenWorkspace; notice?: string;
  onAct: (request: AdminUpgradeRequest, action: RequestAction) => void;
}) {
  const clock = useClock();
  return <>
    <div className="bo-tabs" role="tablist" aria-label="Estado de las solicitudes">{(Object.keys(requestStatusLabels) as RequestStatus[]).map((key) =>
      <button key={key} type="button" role="tab" aria-selected={key === status} className={key === status ? "active" : ""} onClick={() => onStatus(key)}>{requestStatusLabels[key]}</button>)}</div>
    {notice && <p className="bo-notice" role="status">{notice}</p>}
    {role === "support" && status === "open" && <AdminState>Podés ver las solicitudes. Activar Bellis Pro, resolverlas o descartarlas lo hace una persona con rol admin.</AdminState>}
    {rows === null ? <AdminState>Cargando solicitudes…</AdminState> : !rows.length ? <AdminState>{status === "open" ? "No hay solicitudes abiertas." : status === "resolved" ? "No hay solicitudes resueltas." : "No hay solicitudes descartadas."}</AdminState>
      : <ul className="bo-requests">{rows.map((row) => { const actions = requestActions(row, role);
        return <li key={row.request_id} className="bo-card">
          <div className="bo-request-head"><div><WorkspaceLink id={row.workspace_id} open={open} className="bo-link bo-name">{row.workspace_name}</WorkspaceLink>
            <small>{row.owner_email ?? "Sin email"} · {row.profession ?? "Sin profesión"}</small></div>
            <TierChip tier={row.effective_tier} suspended={row.workspace_status === "suspended"} /></div>
          <dl className="bo-facts">
            <Fact label="Pidió">Bellis Pro</Fact>
            <Fact label="Cuándo">{adminDateTime(row.requested_at)} ({daysAgo(row.requested_at, clock)})</Fact>
            <Fact label="Plan actual">{planLine({ effective_tier: row.effective_tier, trial_ends_at: row.trial_ends_at, pro_ends_at: row.pro_ends_at, status: row.workspace_status === "suspended" ? "suspended" : "active" })}</Fact>
            <Fact label="Estado">{resolutionLabel(row)}{row.resolved_at && <small>{adminDate(row.resolved_at)}</small>}</Fact>
            <Fact label="Último acceso del equipo">{row.last_sign_in_at ? daysAgo(row.last_sign_in_at, clock) : "Sin ingresos todavía"}</Fact>
            <Fact label="Última actividad">{daysAgo(row.last_activity_at, clock)}</Fact>
            <Fact label="Uso">{row.patient_count} pacientes · {row.appointment_count} turnos · {row.public_booking_count} reservas públicas</Fact>
          </dl>
          {actions.length > 0 && <div className="bo-actions">
            <button type="button" className="bo-button bo-button-primary" onClick={() => onAct(row, "activate")}>Activar Pro</button>
            <button type="button" className="bo-button" onClick={() => onAct(row, "resolve")}>Resolver sin activar</button>
            <button type="button" className="bo-button" onClick={() => onAct(row, "dismiss")}>Descartar</button>
          </div>}
        </li>; })}</ul>}
  </>;
}
