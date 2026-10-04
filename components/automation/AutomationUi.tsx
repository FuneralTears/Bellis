import type { ComponentType, ReactNode } from "react";
import { ArrowRight, CalendarPlus, Check, CircleAlert, CircleHelp, Clock3, CreditCard, ListChecks, LoaderCircle, Minus, UserX, X } from "lucide-react";
import { Tag, type Tone } from "@/components/crm/CrmUi";
import "./automation-ui.css";

/**
 * Presentation only. Shared by /automatizaciones, /notificaciones, the bell
 * and their /demo mirrors: callers keep their data, links and handlers.
 */

type Icon = ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
type Look = { tone: Tone; icon: Icon };

export type RuleKind = "first_consultation" | "inactive_patient" | "pending_payment";
const ruleIcons: Record<RuleKind, Icon> = { first_consultation: CalendarPlus, inactive_patient: UserX, pending_payment: CreditCard };
const ruleSentences: Record<RuleKind, string> = {
  first_consultation: "Avisame si un paciente tuvo su primera consulta y no reservó otra.",
  inactive_patient: "Avisame si un paciente lleva varios días sin volver.",
  pending_payment: "Avisame si hay un pago pendiente de revisar.",
};
/**
 * What each automation does, in the professional's words. The stored name stays as it is and is shown next to it.
 * `wait` is the configured delay as the caller already formats it ("60 días"): the inactivity sentence states it
 * when it is a real amount and stays generic otherwise.
 */
export function ruleSentence(kind: RuleKind, wait?: string): string {
  return kind === "inactive_patient" && wait && /^[1-9]/.test(wait) ? `Avisame si un paciente lleva ${wait} sin volver.` : ruleSentences[kind];
}
export const ruleStateLabel = (enabled: boolean) => enabled ? "Está funcionando" : "Está pausada";

export function RuleRow({ kind, name, description, enabled, wait, action, toggle, children }: {
  kind: RuleKind; name: string; description: string; enabled: boolean; wait: string; action: string; toggle?: ReactNode; children?: ReactNode;
}) {
  const RuleIcon = ruleIcons[kind];
  return <article className={enabled ? "auto-rule" : "auto-rule is-off"}>
    <span className={`crm-signal-icon crm-tone-${enabled ? "sage" : "neutral"}`}><RuleIcon size={16} aria-hidden /></span>
    <div className="auto-rule-body">
      <div className="auto-rule-title"><h2>{ruleSentence(kind, wait)}</h2><Tag tone={enabled ? "sage" : "neutral"}>{ruleStateLabel(enabled)}</Tag></div>
      <p><b>{name}.</b> {description}</p>
      <div className="auto-rule-meta"><span><Clock3 size={13} aria-hidden /> Bellis espera {wait}</span><span><ListChecks size={13} aria-hidden /> {action}</span></div>
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
/** The one user-facing wording for the states of automatic activity, in the product and in /demo. Backend values stay as they are. */
export const runStatusLabels: Record<RunStatus, string> = { scheduled: "Pendiente", processing: "En proceso", completed: "Hecho", failed: "Necesita revisión", skipped: "No fue necesario", cancelled: "Cancelada" };
export function RunStatusTag({ status }: { status: RunStatus }) {
  return <Tag tone={runLook[status].tone} icon={runLook[status].icon}>{runStatusLabels[status]}</Tag>;
}

/** What happened, as a sentence. An empty name reads as "un paciente". */
export function runHeadline(status: RunStatus, patient: string): string {
  const who = patient || "un paciente";
  switch (status) {
    case "completed": return `Bellis creó un seguimiento para ${who}.`;
    case "failed": return `No pudimos crear el seguimiento para ${who}.`;
    case "skipped": return `No fue necesario crear un seguimiento para ${who}.`;
    case "scheduled": return `Bellis va a revisar el caso de ${who}.`;
    case "processing": return `Bellis está revisando el caso de ${who}.`;
    case "cancelled": return `Se canceló la revisión del caso de ${who}.`;
  }
}
// Reasons arrive already written by the backend; only the ones that use internal wording are rephrased here.
const reasonCopy: Record<string, string> = {
  "Regla desactivada o reactivada después del evento": "La automatización estaba pausada cuando ocurrió.",
};
/** Why it matters or what to expect next. `reason` is the backend's own explanation, when there is one. */
export function runExplanation(status: RunStatus, reason?: string): string {
  switch (status) {
    case "completed": return "Ya podés verlo en la ficha del paciente.";
    case "failed": return "Bellis intentó hacerlo automáticamente, pero ocurrió un problema.";
    case "skipped": return reason ? reasonCopy[reason] ?? `${reason.replace(/\.$/, "")}.` : "La situación cambió y ya no hacía falta.";
    case "scheduled": return "Todavía no hace falta que hagas nada.";
    case "processing": return "En unos minutos vas a ver el resultado.";
    case "cancelled": return "Bellis no hizo ningún cambio.";
  }
}

export type RunRow = { id: string; rule: string; patient: string; status: RunStatus; when: string; reason?: string };
/** Automatic activity as a list: what happened and to whom first; the technical data lives in the detail. */
export function ActivityList({ rows, onDetail }: { rows: RunRow[]; onDetail: (id: string) => void }) {
  return <div className="auto-activity">{rows.map((row) => {
    const look = runLook[row.status]; const StatusIcon = look.icon;
    return <article key={row.id} className="auto-activity-item">
      <span className={`crm-signal-icon crm-tone-${look.tone}`}><StatusIcon size={16} aria-hidden /></span>
      <div className="auto-activity-body">
        <strong>{runHeadline(row.status, row.patient)}</strong>
        <p>{runExplanation(row.status, row.reason)}</p>
        <small>{row.rule} · {row.when}</small>
      </div>
      <RunStatusTag status={row.status}/>
      <button className="crm-link" onClick={() => onDetail(row.id)}>Ver detalle <ArrowRight size={14} /></button>
    </article>;
  })}</div>;
}

/** One activity opened: what happened, why it is shown and what can be done; `facts` are the technical data, kept at the bottom. */
export function ActivityDetail({ id, status, patient, rule, ruleEnabled, reason, facts, onClose, children }: {
  id?: string; status: RunStatus; patient: string; rule?: string; ruleEnabled?: boolean; reason?: string; facts: { label: string; value: ReactNode }[]; onClose: () => void; children?: ReactNode;
}) {
  return <section id={id} className="crm-card auto-detail">
    <div className="crm-card-head"><div><h2>{runHeadline(status, patient)}</h2><p>{runExplanation(status, reason)}</p></div><button className="crm-btn" onClick={onClose}>Cerrar</button></div>
    {rule && <WhyThis>Bellis te lo muestra porque configuraste la automatización «{rule}»{ruleEnabled === false ? ", que ahora está pausada" : ""}.</WhyThis>}
    {children && <div className="auto-detail-foot">{children}</div>}
    <details className="auto-facts"><summary>Más información</summary><DetailList items={facts}/></details>
  </section>;
}

/** "¿Por qué veo esto?": only rendered by callers that have the reason at hand. */
export function WhyThis({ children }: { children: ReactNode }) {
  return <p className="auto-why"><CircleHelp size={14} aria-hidden /><span><b>¿Por qué veo esto?</b> {children}</span></p>;
}

export type NotificationKind = "created" | "failed" | "skipped" | "completed";
type NotificationGroup = "review" | "follow_ups" | "activity";
const notificationLook: Record<NotificationKind, Look> = {
  created: { tone: "petrol", icon: ListChecks },
  failed: { tone: "coral", icon: CircleAlert },
  skipped: { tone: "neutral", icon: Minus },
  completed: { tone: "sage", icon: Check },
};
/** Wording per notification type. The stored title and message use internal terms, so the screen writes its own. */
const notificationCopy: Record<NotificationKind, { title: string; message: string; action: string; group: NotificationGroup }> = {
  failed: { title: "No pudimos completar una tarea automática.", message: "Bellis intentó hacerlo, pero ocurrió un problema. Revisalo cuando puedas.", action: "Revisar", group: "review" },
  created: { title: "Bellis creó un seguimiento para este paciente.", message: "Abrilo para ver qué conviene hacer.", action: "Ver seguimiento", group: "follow_ups" },
  completed: { title: "Bellis completó una tarea automáticamente.", message: "No hace falta que hagas nada.", action: "Ver actividad", group: "activity" },
  skipped: { title: "Bellis revisó un caso y no fue necesario hacer nada.", message: "La situación ya había cambiado.", action: "Ver actividad", group: "activity" },
};
const notificationGroups: { key: NotificationGroup; label: string }[] = [{ key: "review", label: "Para revisar" }, { key: "follow_ups", label: "Seguimientos" }, { key: "activity", label: "Actividad de Bellis" }];
export function notificationKind(type: string): NotificationKind {
  return type === "automation_failed" ? "failed" : type === "automation_skipped" ? "skipped" : type === "automation_completed" ? "completed" : "created";
}
export type NotificationView = { id: string; kind: NotificationKind; patient?: string; time: string; unread: boolean; onClick: () => void };
/** One notification, in the full list or (compact) inside the bell dropdown. */
export function NotificationItem({ kind, patient, time, unread, compact = false, onClick }: Omit<NotificationView, "id"> & { compact?: boolean }) {
  const look = notificationLook[kind]; const KindIcon = look.icon; const copy = notificationCopy[kind];
  return <button type="button" className={`notif-item${unread ? " unread" : ""}${compact ? " compact" : ""}`} onClick={onClick}>
    <span className={`notif-icon crm-tone-${look.tone}`}><KindIcon size={compact ? 14 : 16} aria-hidden /></span>
    <span className="notif-body"><strong>{copy.title}</strong><span>{patient ? `${patient} · ` : ""}{copy.message}</span><time>{time}</time></span>
    {unread && <span className="notif-dot" role="img" aria-label="No leída" />}
    {!compact && <span className="notif-action">{copy.action} <ArrowRight size={14} aria-hidden /></span>}
  </button>;
}
/** The full list, grouped by what the professional has to do with each notification. Types are not changed, only arranged. */
export function NotificationGroups({ items }: { items: NotificationView[] }) {
  return <>{notificationGroups.map((group) => {
    const members = items.filter((item) => notificationCopy[item.kind].group === group.key);
    return members.length ? <section className="notif-group" key={group.key} aria-label={group.label}><h2>{group.label} <span>{members.length}</span></h2><div className="notif-list">{members.map(({ id, ...item }) => <NotificationItem key={id} {...item}/>)}</div></section> : null;
  })}</>;
}
