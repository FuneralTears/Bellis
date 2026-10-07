"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, CircleCheck, Info } from "lucide-react";
import "./payment-settings.css";

/**
 * Presentation of Perfil → Cobros y pagos. Nothing here talks to Supabase or to Mercado Pago:
 * the page owns the data and every action, and the demo drives the same screens with mock state.
 */

export type PaymentMethod = "mercado_pago_ar" | "external_link";
/** What the panel knows about the Mercado Pago account. `unavailable`: the status could not be read. `restricted`: this person may not see it. */
export type MercadoPagoConnection = {
  status: "loading" | "connected" | "disconnected" | "expired" | "error" | "unavailable" | "restricted";
  accountHint?: string | null; connectedAt?: string | null; environment?: string | null;
};
export type PaymentNotice = { tone: "success" | "info" | "error"; text: string };

/** Feedback for the ?mp= code the connection flow returns with. It never says whether the account is connected: the status does. */
export function mercadoPagoReturnNotice(code: string | null): PaymentNotice | null {
  if (code === "connected") return { tone: "success", text: "Mercado Pago quedó conectado." };
  if (code === "cancelled") return { tone: "info", text: "No se conectó ninguna cuenta. Podés intentarlo cuando quieras." };
  if (code === "invalid_state") return { tone: "error", text: "No pudimos validar la conexión. Iniciá el proceso nuevamente." };
  if (code === "error") return { tone: "error", text: "No pudimos conectar Mercado Pago. Intentá nuevamente." };
  return null;
}

const statusLabel: Record<MercadoPagoConnection["status"], string> = {
  loading: "Consultando…", connected: "Conectado", disconnected: "No conectado",
  expired: "La conexión necesita renovarse", error: "Necesita atención", unavailable: "No disponible", restricted: "No disponible",
};
const noticeIcon = { success: CircleCheck, info: Info, error: AlertCircle };

function Notice({ notice }: { notice: PaymentNotice }) {
  const Icon = noticeIcon[notice.tone];
  return <p className={`pay-notice pay-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}><Icon size={18} aria-hidden /><span>{notice.text}</span></p>;
}

function StatusBadge({ status }: { status: MercadoPagoConnection["status"] }) {
  const tone = status === "connected" ? "ok" : status === "expired" || status === "error" ? "attention" : "idle";
  const Icon = tone === "ok" ? CircleCheck : tone === "attention" ? AlertCircle : Info;
  return <span className={`pay-badge pay-badge-${tone}`}><Icon size={14} aria-hidden />{statusLabel[status]}</span>;
}

export default function PaymentSettings({ method, paymentUrl, hasServiceLinks, connection, canManage, notice, connecting, busy, pendingMercadoPago = 0, onConnect, onDisconnect, onSaveMethod, formatDate }: {
  /** The method saved for the workspace, and its saved link. */
  method: PaymentMethod; paymentUrl: string; hasServiceLinks: boolean;
  connection: MercadoPagoConnection; canManage: boolean; notice: PaymentNotice | null;
  connecting: boolean; busy: boolean;
  /** Mercado Pago payments still waiting for confirmation. Disconnecting leaves Bellis unable to check them. */
  pendingMercadoPago?: number;
  onConnect: () => void; onDisconnect: () => void; onSaveMethod: (method: PaymentMethod, url: string) => void;
  formatDate: (value: string) => string;
}) {
  const [choice, setChoice] = useState<PaymentMethod>(method);
  const [url, setUrl] = useState(paymentUrl);
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const connected = connection.status === "connected";
  const needsAttention = connection.status === "expired" || connection.status === "error";
  // The status could not be read (or is not this person's to see): nothing can be said about Mercado Pago either way.
  const unknown = connection.status === "unavailable" || connection.status === "restricted";
  const canConnect = canManage && connection.status !== "unavailable" && connection.status !== "restricted" && connection.status !== "loading";
  // Whether patients can pay today with what is saved.
  const configured = method === "mercado_pago_ar" ? connected : !!paymentUrl || hasServiceLinks;
  const urlInvalid = !!url && !url.startsWith("https://");
  const connectLabel = connecting ? "Conectando…" : needsAttention ? "Volver a conectar" : "Conectar Mercado Pago";
  const connectButton = (className: string) => <button type="button" className={className} disabled={connecting || busy} aria-busy={connecting} onClick={onConnect}>{connectLabel}</button>;

  return <div className="pay-root">
    <header className="pay-head"><h2>Cobros y pagos</h2><p>Elegí cómo querés recibir los pagos de tus pacientes.</p></header>
    {notice && <Notice notice={notice} />}
    {connection.status !== "loading" && !configured && <div className="pay-warning" role="status"><AlertCircle size={20} aria-hidden /><div>
      {method === "mercado_pago_ar" && needsAttention ? <><b>Tus pacientes no pueden pagar en este momento.</b><span>Volvé a conectar Mercado Pago o elegí otro método de cobro.</span></>
        : method === "mercado_pago_ar" && unknown ? <><b>No pudimos comprobar tu conexión con Mercado Pago.</b><span>Volvé a entrar en unos minutos. Si sigue igual, tus pacientes podrían no poder pagar.</span></>
        : <><b>Todavía no configuraste cómo recibir pagos.</b><span>Elegí un método de cobro para poder recibir reservas desde tu página.</span></>}
    </div></div>}

    <div className="pay-grid">
      <section className="demo-panel pay-panel" aria-labelledby={`${ids}-method`}>
        <h3 id={`${ids}-method`}>Método de cobro</h3>
        <fieldset className="pay-options" disabled={!canManage}>
          <legend>¿Cómo querés cobrar?</legend>
          <label className="pay-option"><input type="radio" name={`${ids}-choice`} checked={choice === "mercado_pago_ar"} onChange={() => setChoice("mercado_pago_ar")} />
            <span><b>Mercado Pago{method === "mercado_pago_ar" && configured && <em>En uso</em>}</b><small>Bellis genera y confirma el pago automáticamente.</small></span></label>
          <label className="pay-option"><input type="radio" name={`${ids}-choice`} checked={choice === "external_link"} onChange={() => setChoice("external_link")} />
            <span><b>Link de pago externo{method === "external_link" && configured && <em>En uso</em>}</b><small>Usá un link de cobro que ya tengas.</small></span></label>
        </fieldset>
        {choice === "mercado_pago_ar" && !connected && <div className="pay-hint" role="status"><p>Primero conectá tu cuenta de Mercado Pago.</p>{canConnect && connectButton("pay-secondary")}</div>}
        {choice === "external_link" && <label className="pay-field">Link de pago
          <input type="url" inputMode="url" placeholder="https://…" value={url} disabled={!canManage} onChange={(event) => setUrl(event.target.value)} aria-describedby={`${ids}-url-help`} aria-invalid={urlInvalid} />
          <small id={`${ids}-url-help`}>{urlInvalid ? "El link tiene que empezar con https://" : "Pegá el enlace que querés que tus pacientes usen para pagar. Vos verificás cada pago y lo registrás acá."}</small>
        </label>}
        {canManage ? <button type="button" className="pay-primary pay-save" disabled={busy || connecting || (choice === "mercado_pago_ar" ? !connected : urlInvalid)} onClick={() => onSaveMethod(choice, url)}>{busy ? "Guardando…" : "Guardar método de cobro"}</button>
          : <p className="pay-muted">Solo quien administra el espacio puede cambiar el método de cobro.</p>}
      </section>

      <section className="demo-panel pay-panel" aria-labelledby={`${ids}-mp`}>
        <div className="pay-panel-head"><h3 id={`${ids}-mp`}>{connected ? "Mercado Pago conectado" : "Mercado Pago"}</h3><StatusBadge status={connection.status} /></div>
        {connection.status === "loading" ? <p className="pay-muted" role="status">Consultando el estado de Mercado Pago…</p>
          : connection.status === "restricted" ? <p className="pay-muted">Solo quien administra el espacio puede ver esta conexión.</p>
          : connection.status === "unavailable" ? <p className="pay-muted">No pudimos consultar el estado de Mercado Pago en este momento. Volvé a intentar en unos minutos; mientras tanto podés cobrar con un link de pago.</p>
          : connected ? <>
            <dl className="pay-facts">
              {connection.accountHint && <div><dt>Cuenta</dt><dd>terminada en {connection.accountHint.replace(/\D/g, "")}</dd></div>}
              {connection.connectedAt && <div><dt>Conectada</dt><dd>{formatDate(connection.connectedAt)}</dd></div>}
              {connection.environment === "test" && <div><dt>Tipo</dt><dd>Cuenta de prueba</dd></div>}
            </dl>
            {method !== "mercado_pago_ar" && <p className="pay-muted">Para cobrar con esta cuenta, elegí Mercado Pago como método de cobro.</p>}
            {canManage && <button type="button" className="pay-secondary pay-danger" disabled={busy} onClick={() => dialog.current?.showModal()}>Desconectar Mercado Pago</button>}
          </> : needsAttention ? <>
            <p>{connection.status === "error" ? "Mercado Pago dejó de aceptar la conexión con Bellis. Suele pasar cuando se quita el permiso desde la cuenta de Mercado Pago o cambia su contraseña." : "La autorización de Mercado Pago venció."} Volvé a conectar tu cuenta para seguir recibiendo pagos automáticamente.</p>
            {canConnect && connectButton("pay-primary")}
          </> : <>
            <p>Conectá tu cuenta para que Bellis pueda generar y confirmar los pagos de tus pacientes automáticamente.</p>
            <ul className="pay-benefits">{["El paciente paga antes de reservar.", "Bellis recibe la confirmación del pago.", "No necesitás verificarlo manualmente."].map((item) => <li key={item}><Check size={16} aria-hidden />{item}</li>)}</ul>
            {canConnect && connectButton("pay-primary")}
          </>}
        {!canManage && connection.status !== "restricted" && connection.status !== "loading" && <p className="pay-muted">Solo quien administra el espacio puede conectar o desconectar Mercado Pago.</p>}
      </section>
    </div>

    <dialog className="pay-dialog" ref={dialog} aria-labelledby={`${ids}-confirm`} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div><h3 id={`${ids}-confirm`}>¿Desconectar Mercado Pago?</h3>
        <p>Bellis dejará de generar nuevos cobros con esta cuenta. Los pagos ya registrados no se eliminan.</p>
        {pendingMercadoPago > 0 && <p className="pay-notice pay-dialog-warning" role="alert"><AlertCircle size={18} aria-hidden /><span>{pendingMercadoPago === 1 ? "Hay 1 pago pendiente de confirmación." : `Hay ${pendingMercadoPago} pagos pendientes de confirmación.`} Si desconectás Mercado Pago ahora, Bellis no podrá verificar esos pagos hasta que vuelvas a conectarlo.</span></p>}
        <div className="pay-dialog-actions"><button type="button" className="pay-secondary" autoFocus onClick={() => dialog.current?.close()}>Cancelar</button><button type="button" className="pay-primary pay-confirm-danger" onClick={() => { dialog.current?.close(); onDisconnect(); }}>Desconectar</button></div>
      </div>
    </dialog>
  </div>;
}

/** Payments made through an external link, waiting for the professional to check them. Separate from the method on purpose. */
export function PendingPayments({ items, busy, onApprove, note }: {
  items: { id: string; patient: string; detail: string }[]; busy: boolean; onApprove: (id: string, reference: string) => void; note?: ReactNode;
}) {
  const [references, setReferences] = useState<Record<string, string>>({});
  return <section className="demo-panel pay-panel pay-pending">
    <h3>Pagos pendientes de verificar</h3>
    <p className="pay-muted">Los pagos por link externo quedan acá hasta que confirmes que los recibiste. Recién entonces el paciente puede elegir horario.</p>
    {note}
    {items.length ? <ul>{items.map((item) => <li key={item.id}>
      <div><b>{item.patient}</b><small>{item.detail}</small></div>
      <label className="pay-field">Referencia de la operación<input value={references[item.id] ?? ""} onChange={(event) => setReferences({ ...references, [item.id]: event.target.value })} placeholder="Número o comprobante que verificaste" /></label>
      <button type="button" className="pay-secondary" disabled={busy || (references[item.id]?.trim().length ?? 0) < 4} onClick={() => onApprove(item.id, references[item.id].trim())}>Registré este cobro</button>
    </li>)}</ul> : <p className="pay-empty">No hay pagos pendientes.</p>}
  </section>;
}
