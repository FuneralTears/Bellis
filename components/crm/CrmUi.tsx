import type { ComponentType, ReactNode } from "react";
import {
  ArrowRight,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CalendarX,
  Check,
  CircleAlert,
  Clock3,
  CreditCard,
  ListChecks,
  MessageCircle,
  Minus,
  PenLine,
  Repeat,
  Settings2,
  StickyNote,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import {
  followUpBucket,
  followUpLabels,
  priorityLabels,
  type FollowUp,
  type TimelineEvent,
} from "@/app/pacientes/timeline";
import {
  detectOpportunities,
  type Opportunity,
  type OpportunityKind,
  type OpportunityOverview,
} from "@/app/pacientes/opportunities";
import "./crm-ui.css";

/**
 * Presentation only. Shared by the real CRM pages and the /demo showroom:
 * callers keep their own data, links and handlers and pass them in.
 */

type Icon = ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
export type Tone = "sage" | "blue" | "orange" | "coral" | "neutral" | "petrol" | "lilac";
type PatientStatus = OpportunityOverview["status"];
export type FollowUpView = Pick<FollowUp, "id" | "title" | "description" | "due_date" | "due_time" | "priority" | "status" | "source">;
type Bucket = ReturnType<typeof followUpBucket>;

export function dateOnly(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const text = (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "");
  return text.toUpperCase() || "?";
}
const avatarTones: Tone[] = ["sage", "blue", "lilac", "coral", "petrol"];

export function PatientAvatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const tone = avatarTones[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % avatarTones.length];
  return <span className={`crm-avatar crm-avatar-${size} crm-tone-${tone}`} aria-hidden="true">{initials(name)}</span>;
}

export function Tag({ tone = "neutral", icon: TagIcon, children }: { tone?: Tone; icon?: Icon; children: ReactNode }) {
  return <span className={`crm-tag crm-tone-${tone}`}>{TagIcon && <TagIcon size={12} aria-hidden />}{children}</span>;
}

const statusTones: Record<PatientStatus, Tone> = { new: "blue", active: "sage", follow_up: "orange", inactive: "neutral" };
export function StatusTag({ status, children }: { status: PatientStatus; children: ReactNode }) {
  return <Tag tone={statusTones[status]}>{children}</Tag>;
}

const bucketLook: Record<Bucket, { tone: Tone; icon: Icon }> = {
  overdue: { tone: "coral", icon: CircleAlert },
  today: { tone: "orange", icon: Clock3 },
  upcoming: { tone: "blue", icon: CalendarClock },
  none: { tone: "neutral", icon: Minus },
};
export function FollowUpBucketTag({ dueDate, today }: { dueDate: string | null; today: string }) {
  const bucket = followUpBucket(dueDate, today);
  return <Tag tone={bucketLook[bucket].tone} icon={bucketLook[bucket].icon}>{followUpLabels[bucket]}</Tag>;
}
/** Pending tasks show their due bucket; closed ones show how they ended. */
export function TaskStateTag({ item, today }: { item: Pick<FollowUp, "status" | "due_date">; today: string }) {
  if (item.status === "completed") return <Tag tone="sage" icon={Check}>Completado</Tag>;
  if (item.status === "cancelled") return <Tag tone="neutral" icon={X}>Cancelado</Tag>;
  return <FollowUpBucketTag dueDate={item.due_date} today={today} />;
}
export function OriginTag({ source }: { source: FollowUp["source"] }) {
  return source === "automation" ? <Tag tone="petrol" icon={Settings2}>Automático</Tag> : <Tag icon={PenLine}>Manual</Tag>;
}
const priorityTones: Record<FollowUp["priority"], Tone> = { high: "coral", medium: "orange", low: "neutral" };
export function PriorityTag({ priority, long = false }: { priority: FollowUp["priority"]; long?: boolean }) {
  return <Tag tone={priorityTones[priority]}>{long ? `Prioridad ${priorityLabels[priority].toLowerCase()}` : priorityLabels[priority]}</Tag>;
}

const opportunityLook: Record<OpportunityKind, { tone: Tone; icon: Icon }> = {
  pending_payment: { tone: "orange", icon: CreditCard },
  overdue_follow_up: { tone: "coral", icon: CircleAlert },
  first_without_next: { tone: "orange", icon: CalendarPlus },
  inactive: { tone: "neutral", icon: UserX },
  without_next: { tone: "orange", icon: CalendarX },
  upcoming: { tone: "sage", icon: CalendarCheck },
  new: { tone: "blue", icon: UserPlus },
  recurrent: { tone: "sage", icon: Repeat },
};
export function OpportunityTag({ item, more = 0 }: { item: Opportunity; more?: number }) {
  const look = opportunityLook[item.kind];
  return <Tag tone={look.tone} icon={look.icon}>{item.title}{more > 0 ? ` +${more}` : ""}</Tag>;
}
export function OpportunityRow({ item, patientName, children }: { item: Opportunity; patientName?: string; children?: ReactNode }) {
  const look = opportunityLook[item.kind];
  const KindIcon = look.icon;
  return <article className="crm-signal">
    <span className={`crm-signal-icon crm-tone-${look.tone}`}><KindIcon size={16} aria-hidden /></span>
    <div className="crm-signal-body">
      <strong>{patientName ? <>{patientName} <span aria-hidden="true">·</span> </> : null}{item.title}</strong>
      <p>{item.reason}</p>
    </div>
    <Tag tone={item.level === "attention" ? "orange" : "neutral"}>{item.level === "attention" ? "Atención pendiente" : "Información"}</Tag>
    {children && <div className="crm-signal-action">{children}</div>}
  </article>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="crm-page-head"><div><h1>{title}</h1><p>{description}</p></div>{children && <div className="crm-page-actions">{children}</div>}</div>;
}

export function KpiStrip({ items }: { items: { label: string; value: ReactNode; icon: Icon; tone: Tone }[] }) {
  return <div className={items.length === 5 ? "crm-kpis crm-kpis-5" : "crm-kpis"}>{items.map(({ label, value, icon: KpiIcon, tone }) => <div className="crm-kpi" key={label}>
    <span className={`crm-kpi-icon crm-tone-${tone}`}><KpiIcon size={16} aria-hidden /></span>
    <div><span>{label}</span><strong>{value}</strong></div>
  </div>)}</div>;
}

/** On phones the tab strip scrolls sideways: keep the active tab fully inside it (e.g. after a deep link). */
function revealTab(tab: HTMLButtonElement | null) {
  const strip = tab?.parentElement;
  if (!tab || !strip) return;
  const left = tab.offsetLeft - strip.offsetLeft;
  if (left < strip.scrollLeft) strip.scrollLeft = left;
  else if (left + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + tab.offsetWidth - strip.clientWidth;
}
export function Tabs<T extends string>({ label, tabs, active, onChange }: { label: string; tabs: { id: T; label: string; count?: number }[]; active: T; onChange: (id: T) => void }) {
  return <div className="crm-tabs" role="tablist" aria-label={label}>{tabs.map((tab) => <button key={tab.id} type="button" role="tab" id={`crm-tab-${tab.id}`} aria-selected={active === tab.id} className={active === tab.id ? "on" : ""} ref={active === tab.id ? revealTab : undefined} onClick={() => onChange(tab.id)}>{tab.label}{tab.count !== undefined && <span>{tab.count}</span>}</button>)}</div>;
}

export function ProfileHeader({ name, status, contact, actions, stats }: { name: string; status: ReactNode; contact: ReactNode; actions: ReactNode; stats: { label: string; value: ReactNode }[] }) {
  return <section className="crm-card crm-profile-head">
    <div className="crm-profile-top">
      <PatientAvatar name={name} size="lg" />
      <div className="crm-profile-identity"><div><h1>{name}</h1>{status}</div><div className="crm-profile-contact">{contact}</div></div>
      <div className="crm-profile-actions">{actions}</div>
    </div>
    <dl className="crm-profile-stats">{stats.map((stat) => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}</dl>
  </section>;
}

const eventLook: Record<TimelineEvent["kind"], { tone: Tone; icon: Icon }> = {
  patient: { tone: "blue", icon: UserPlus },
  appointment: { tone: "sage", icon: CalendarDays },
  payment: { tone: "orange", icon: CreditCard },
  note: { tone: "lilac", icon: StickyNote },
  activity: { tone: "neutral", icon: MessageCircle },
  follow_up: { tone: "petrol", icon: ListChecks },
};
/** Renders events exactly as built by buildPatientTimeline; only the look changes. */
export function Timeline({ events, formatAt, renderLinks }: { events: TimelineEvent[]; formatAt: (event: TimelineEvent) => string; renderLinks?: (event: TimelineEvent) => ReactNode }) {
  return <ol className="crm-tl">{events.map((event) => {
    const automatic = event.title.startsWith("⚙");
    const look = automatic ? { tone: "petrol" as Tone, icon: Settings2 } : eventLook[event.kind];
    const EventIcon = look.icon;
    return <li key={event.id}>
      <span className={`crm-tl-icon crm-tone-${look.tone}`}><EventIcon size={14} aria-hidden /></span>
      <div>
        <div className="crm-tl-head"><strong>{event.title.replace(/^⚙\s*/, "")}</strong><time>{formatAt(event)}</time></div>
        <p>{event.description}</p>
        {(event.actor || renderLinks) && <div className="crm-tl-meta">{event.actor && <small>{event.actor}</small>}{renderLinks?.(event)}</div>}
      </div>
    </li>;
  })}</ol>;
}

export function FollowUpCard({ item, today, children }: { item: FollowUpView; today: string; children?: ReactNode }) {
  return <article id={`seguimiento-${item.id}`} className="crm-task">
    <div className="crm-task-tags"><TaskStateTag item={item} today={today} />{item.status === "pending" && <PriorityTag priority={item.priority} long />}<OriginTag source={item.source} /></div>
    <strong>{item.title}</strong>
    {item.description && <p>{item.description}</p>}
    <small><CalendarDays size={13} aria-hidden /> {dateOnly(item.due_date)}{item.due_time ? ` · ${item.due_time.slice(0, 5)}` : ""}</small>
    {children && <div className="crm-task-actions">{children}</div>}
  </article>;
}

type Wrap<T> = (row: T, content: ReactNode, options: { className: string; label?: string }) => ReactNode;

export function PatientsTable({ patients, today, automaticIds, formatDate, statusLabel, renderOpen }: {
  patients: OpportunityOverview[]; today: string; automaticIds: Set<string>;
  formatDate: (value: string | null) => string; statusLabel: (status: PatientStatus) => string; renderOpen: Wrap<OpportunityOverview>;
}) {
  return <div className="crm-table-wrap"><table className="crm-table crm-stack-table"><thead><tr><th>Paciente</th><th>Teléfono</th><th>Último turno</th><th>Próximo turno</th><th>Turnos</th><th>Estado</th><th>Oportunidades</th><th>Seguimiento</th><th><span className="sr-only">Abrir</span></th></tr></thead><tbody>{patients.map((patient) => {
    const signals = detectOpportunities(patient);
    const primary = signals.find((signal) => signal.level === "attention") ?? signals[0];
    return <tr key={patient.id}>
      <td className="crm-cell-main">{renderOpen(patient, <><PatientAvatar name={patient.full_name} /><span><b>{patient.full_name}</b><small>{patient.email}</small></span></>, { className: "crm-person" })}</td>
      <td data-label="Teléfono">{patient.phone || "—"}</td>
      <td data-label="Último turno">{formatDate(patient.last_turn)}</td>
      <td data-label="Próximo turno">{formatDate(patient.next_turn)}</td>
      <td data-label="Turnos">{patient.turn_count}</td>
      <td data-label="Estado"><StatusTag status={patient.status}>{statusLabel(patient.status)}</StatusTag></td>
      <td data-label="Oportunidades">{primary ? <OpportunityTag item={primary} more={signals.length - 1} /> : "—"}</td>
      <td data-label="Seguimiento"><span className="crm-tag-group"><FollowUpBucketTag dueDate={patient.follow_up_due_date} today={today} />{automaticIds.has(patient.id) && <OriginTag source="automation" />}</span></td>
      <td className="crm-cell-open">{renderOpen(patient, <ArrowRight size={16} />, { className: "crm-open", label: `Ver ficha de ${patient.full_name}` })}</td>
    </tr>;
  })}</tbody></table></div>;
}

type FollowUpRow = FollowUpView & { patient_id: string };
export function FollowUpsTable<T extends FollowUpRow>({ items, today, patientName, renderPatient, renderActions }: {
  items: T[]; today: string; patientName: (item: T) => string | undefined; renderPatient: Wrap<T>; renderActions: (item: T) => ReactNode;
}) {
  return <div className="crm-table-wrap"><table className="crm-table crm-stack-table"><thead><tr><th>Paciente</th><th>Seguimiento</th><th>Fecha</th><th>Prioridad</th><th>Estado</th><th>Origen</th><th><span className="sr-only">Acciones</span></th></tr></thead><tbody>{items.map((item) => {
    const name = patientName(item);
    return <tr key={item.id}>
      <td className="crm-cell-main">{renderPatient(item, <><PatientAvatar name={name ?? ""} /><span><b>{name}</b></span></>, { className: "crm-person" })}</td>
      <td data-label="Seguimiento" className="crm-cell-task"><b>{item.title}</b>{item.description && <small className="crm-cell-description">{item.description}</small>}</td>
      <td data-label="Fecha">{dateOnly(item.due_date)}{item.due_time ? ` · ${item.due_time.slice(0, 5)}` : ""}</td>
      <td data-label="Prioridad"><PriorityTag priority={item.priority} /></td>
      <td data-label="Estado"><TaskStateTag item={item} today={today} /></td>
      <td data-label="Origen"><OriginTag source={item.source} /></td>
      <td className="crm-cell-actions"><div className="crm-table-actions">{renderActions(item)}</div></td>
    </tr>;
  })}</tbody></table></div>;
}
