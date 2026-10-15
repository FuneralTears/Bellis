"use client";

import { useId, useRef, type ReactNode } from "react";
import { AlertCircle, CalendarDays, CircleCheck, Info, CirclePause } from "lucide-react";
import { ProBadge } from "@/components/plan/PlanUi";
import type { GoogleCalendarState } from "@/lib/google-calendar";
import "@/components/payments/payment-settings.css";
import "./integrations.css";

/**
 * Presentation of Perfil → Integraciones. Nothing here talks to Supabase or to Google: the page owns the data and
 * every action, and the demo drives the same card with mock state. Whether Google Calendar is available is the
 * server's answer (`available`); this card never works it out from the plan.
 */

export type IntegrationNotice = { tone: "success" | "info" | "error"; text: string };

export const googleCalendarCopy = "Bellis crea un calendario llamado Turnos Bellis. Tus turnos van a aparecer ahí. Tus eventos personales no se leen.";

/** Feedback for the ?gc= code the connection flow returns with. The status, read from the server, says what is true. */
export function googleCalendarReturnNotice(code: string | null): IntegrationNotice | null {
  if (code === "connected") return { tone: "success", text: "Google Calendar quedó conectado." };
  if (code === "cancelled") return { tone: "info", text: "No se conectó ninguna cuenta. Podés intentarlo cuando quieras." };
  if (code === "invalid_state") return { tone: "error", text: "No pudimos validar la conexión. Iniciá el proceso nuevamente." };
  if (code === "scopes_missing") return { tone: "error", text: "Para conectar Google Calendar tenés que aceptar los dos permisos de calendario que pide Bellis. No se conectó ninguna cuenta." };
  if (code === "plan_required") return { tone: "info", text: "Google Calendar es parte de Bellis Pro. No se conectó ninguna cuenta." };
  if (code === "not_enabled") return { tone: "info", text: "Google Calendar todavía no está disponible para tu cuenta. No se conectó ninguna cuenta." };
  if (code === "error") return { tone: "error", text: "No pudimos conectar Google Calendar. Intentá nuevamente." };
  return null;
}

const noticeIcon = { success: CircleCheck, info: Info, error: AlertCircle };
function Notice({ notice }: { notice: IntegrationNotice }) {
  const Icon = noticeIcon[notice.tone];
  return <p className={`pay-notice pay-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}><Icon size={18} aria-hidden /><span>{notice.text}</span></p>;
}
const badges = {
  connected: { tone: "ok", Icon: CircleCheck, label: "Conectado" },
  needs_reconnect: { tone: "attention", Icon: AlertCircle, label: "Necesita volver a conectarse" },
  paused: { tone: "idle", Icon: CirclePause, label: "En pausa" },
  disconnected: { tone: "idle", Icon: Info, label: "No conectado" },
} as const;
function StatusBadge({ status }: { status: keyof typeof badges }) {
  const { tone, Icon, label } = badges[status];
  return <span className={`pay-badge pay-badge-${tone}`}><Icon size={14} aria-hidden />{label}</span>;
}

export default function GoogleCalendarSettings({ state, notice, connecting, busy, proAction, onConnect, onDisconnect, formatDate }: {
  state: GoogleCalendarState; notice: IntegrationNotice | null; connecting: boolean; busy: boolean;
  /** Where to learn about Bellis Pro: a link in the product, a button in the demo. */
  proAction?: ReactNode;
  onConnect: () => void; onDisconnect: () => void; formatDate: (value: string) => string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const stored = state.status === "connected" || state.status === "needs_reconnect" || state.status === "paused";
  const locked = !state.available && state.unavailableReason === "plan_required";
  const connectButton = (className: string, label: string) => <button type="button" className={className} disabled={connecting || busy} aria-busy={connecting} onClick={onConnect}>{connecting ? "Conectando…" : label}</button>;
  const disconnectButton = <button type="button" className="pay-secondary pay-danger" disabled={busy || connecting} onClick={() => dialog.current?.showModal()}>Desconectar</button>;
  const account = state.email && <dl className="pay-facts">
    <div><dt>Conectado como</dt><dd className="int-email">{state.email}</dd></div>
    {state.calendarLabel && <div><dt>Calendario</dt><dd>{state.calendarLabel}</dd></div>}
    {state.connectedAt && state.status === "connected" && <div><dt>Desde</dt><dd>{formatDate(state.connectedAt)}</dd></div>}
  </dl>;

  return <div className="pay-root">
    <header className="pay-head"><h2>Integraciones</h2><p>Conectá Bellis con otras herramientas que ya usás.</p></header>
    {notice && <Notice notice={notice} />}
    <section className="demo-panel pay-panel int-panel" aria-labelledby={`${ids}-gc`}>
      <div className="pay-panel-head">
        <h3 id={`${ids}-gc`} className="int-title"><CalendarDays size={18} aria-hidden />Google Calendar</h3>
        {locked && !stored ? <ProBadge /> : state.status !== "loading" && state.status !== "unavailable" && <StatusBadge status={state.status} />}
      </div>
      {state.status === "loading" ? <p className="pay-muted" role="status">Consultando el estado de Google Calendar…</p>
        : state.status === "unavailable" ? <p className="pay-muted">No pudimos consultar el estado de Google Calendar en este momento. Volvé a intentar en unos minutos.</p>
        : !state.available ? <>
          {stored ? <>
            {account}
            <p>{locked ? "Tu conexión está guardada, pero Google Calendar es parte de Bellis Pro. Mientras tanto Bellis no usa tu cuenta de Google." : "Tu conexión está guardada. Por ahora Bellis no usa tu cuenta de Google."}</p>
          </> : <>
            <p><b>Disponible en Bellis Pro.</b></p>
            <p className="pay-muted">{googleCalendarCopy}</p>
          </>}
          {locked && proAction && <div className="plan-actions">{proAction}</div>}
          {stored && <div className="int-actions">{disconnectButton}</div>}
        </> : state.status === "connected" ? <>
          {account}
          <p className="pay-muted">{googleCalendarCopy}</p>
          <div className="int-actions">{connectButton("pay-secondary", "Volver a conectar")}{disconnectButton}</div>
        </> : state.status === "needs_reconnect" ? <>
          {account}
          <p>Google dejó de aceptar la conexión con Bellis. Suele pasar cuando se quita el permiso desde tu cuenta de Google o cambia tu contraseña. Volvé a conectar para seguir usando Google Calendar.</p>
          <div className="int-actions">{connectButton("pay-primary", "Volver a conectar")}{disconnectButton}</div>
        </> : <>
          <p>{googleCalendarCopy}</p>
          <div className="int-actions">{connectButton("pay-primary", "Conectar Google Calendar")}</div>
        </>}
    </section>

    <dialog className="pay-dialog" ref={dialog} aria-labelledby={`${ids}-confirm`} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div><h3 id={`${ids}-confirm`}>¿Desconectar Google Calendar?</h3>
        <p>Bellis deja de usar tu cuenta de Google. El calendario Turnos Bellis queda en tu Google Calendar: si querés, podés borrarlo desde ahí.</p>
        <div className="pay-dialog-actions"><button type="button" className="pay-secondary" autoFocus onClick={() => dialog.current?.close()}>No desconectar</button><button type="button" className="pay-primary pay-confirm-danger" onClick={() => { dialog.current?.close(); onDisconnect(); }}>Sí, desconectar</button></div>
      </div>
    </dialog>
  </div>;
}
