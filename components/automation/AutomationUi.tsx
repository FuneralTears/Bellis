import type { ComponentType, ReactNode } from "react";
import { ArrowRight, CalendarPlus, Check, CircleAlert, Clock3, CreditCard, ListChecks, LoaderCircle, Minus, Settings2, UserX, X } from "lucide-react";
import { PatientAvatar, Tag, type Tone } from "@/components/crm/CrmUi";
import "./automation-ui.css";

/**
 * Presentation only. Shared by /automatizaciones, /notificaciones, the bell
 * and their /demo mirrors: callers keep their data, links and handlers.
 */

type Icon = ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
type Look = { tone: Tone; icon: Icon };

export type RuleKind = "first_consultation" | "inactive_patient" | "pending_payment";
const ruleIcons: Record<RuleKind, Icon> = { first_consultation: CalendarPlus, inactive_patient: UserX, pending_payment: CreditCard };

export function RuleRow({ kind, name, description, enabled, wait, action, toggle, children }: {
  kind: RuleKind; name: string; description: string; enabled: boolean; wait: string; action: string; toggle?: ReactNode; children?: ReactNode;
}) {
  const RuleIcon = ruleIcons[kind];
  return <article className={enabled ? "auto-rule" : "auto-rule is-off"}>
    <span className={`crm-signal-icon crm-tone-${enabled ? "sage" : "neutral"}`}><RuleIcon size={16} aria-hidden /></span>
    <div className="auto-rule-body">
      <div className="auto-rule-title"><h2>{name}</h2><Tag tone={enabled ? "sage" : "neutral"}>{enabled ? "Activa" : "Inactiva"}</Tag></div>
      <p>{description}</p>
      <div className="auto-rule-meta"><span><Clock3 size={13} aria-hidden /> Esperar {wait}</span><span><Settings2 size={13} aria-hidden /> {action}</span></div>
    </div>
    <div className="auto-rule-side">{toggle && <label className="auto-switch">{toggle}</label>}{children && <div className="auto-rule-actions">{children}</div>}</div>
  </article>;
}

export function DetailList({ items, columns = 2 }: { items: { label: string; value: ReactNode }[]; columns?: 2 | 4 }) {
  return <dl className={`auto-dl auto-dl-${columns}`}>{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

export type RunStatus = "scheduled" | "processing" | "completed" | "failed" | "cancelled" | "skipped";
const runLook: Record<RunStatus, Look> = {
  completed: { tone: "sage", icon: Check },
  failed: { tone: "coral", icon: CircleAlert },
  skipped: { tone: "neutral", icon: Minus },
  scheduled: { tone: "orange", icon: Clock3 },
  processing: { tone: "blue", icon: LoaderCircle },
  cancelled: { tone: "neutral", icon: X },
};
/** The one user-facing wording for run states, in the product and in /demo. Backend values stay as they are. */
export const runStatusLabels: Record<RunStatus, string> = { scheduled: "Programada", processing: "Procesando", completed: "Completada", failed: "Fallida", skipped: "Omitida", cancelled: "Cancelada" };
export function RunStatusTag({ status }: { status: RunStatus }) {
  return <Tag tone={runLook[status].tone} icon={runLook[status].icon}>{runStatusLabels[status]}</Tag>;
}

export type RunRow = { id: string; created: string; rule: string; patient: string; status: RunStatus; scheduled: string; executed: string; result: string };
export function RunsTable({ rows, onDetail }: { rows: RunRow[]; onDetail: (id: string) => void }) {
  return <div className="crm-table-wrap"><table className="crm-table crm-stack-table"><thead><tr><th>Automatización</th><th>Paciente</th><th>Estado</th><th>Registrada</th><th>Programada</th><th>Ejecutada</th><th>Resultado</th><th><span className="sr-only">Acciones</span></th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
    <td className="crm-cell-main auto-cell-rule"><b>{row.rule}</b></td>
    <td data-label="Paciente"><span className="auto-person"><PatientAvatar name={row.patient} />{row.patient}</span></td>
    <td data-label="Estado"><RunStatusTag status={row.status}/></td>
    <td data-label="Registrada">{row.created}</td>
    <td data-label="Programada">{row.scheduled}</td>
    <td data-label="Ejecutada">{row.executed}</td>
    <td data-label="Resultado" className="auto-cell-result">{row.result}</td>
    <td className="crm-cell-actions"><div className="crm-table-actions"><button className="run-detail-button" onClick={() => onDetail(row.id)}>Ver detalle <ArrowRight size={14} /></button></div></td>
  </tr>)}</tbody></table></div>;
}

export type NotificationKind = "created" | "failed" | "skipped" | "completed";
const notificationLook: Record<NotificationKind, Look> = {
  created: { tone: "petrol", icon: ListChecks },
  failed: { tone: "coral", icon: CircleAlert },
  skipped: { tone: "neutral", icon: Minus },
  completed: { tone: "sage", icon: Check },
};
export function notificationKind(type: string): NotificationKind {
  return type === "automation_failed" ? "failed" : type === "automation_skipped" ? "skipped" : type === "automation_completed" ? "completed" : "created";
}
/** One notification, in the full list or (compact) inside the bell dropdown. */
export function NotificationItem({ kind, title, message, time, unread, compact = false, onClick }: {
  kind: NotificationKind; title: string; message: string; time: string; unread: boolean; compact?: boolean; onClick: () => void;
}) {
  const look = notificationLook[kind]; const KindIcon = look.icon;
  return <button type="button" className={`notif-item${unread ? " unread" : ""}${compact ? " compact" : ""}`} onClick={onClick}>
    <span className={`notif-icon crm-tone-${look.tone}`}><KindIcon size={compact ? 14 : 16} aria-hidden /></span>
    <span className="notif-body"><strong>{title}</strong><span>{message}</span><time>{time}</time></span>
    {unread ? <span className="notif-dot" role="img" aria-label="No leída" /> : !compact && <ArrowRight className="notif-arrow" size={16} aria-hidden />}
  </button>;
}
