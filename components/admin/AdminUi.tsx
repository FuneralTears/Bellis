"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, LayoutDashboard, Search, Sparkles, Users, type LucideIcon } from "lucide-react";
import BellisLogo from "@/components/brand/BellisLogo";
import { activeFilterCount, activityLine, adminDate, adminDateTime, bookingLine, daysAgo, daysRemainingLabel, defaultWorkspaceFilters, eventKind, eventLabel, lastValidDay,
  pageCount, paymentProviderLabels, planLine, share, shownCapabilities, signInLine, sortLabels, tierLabels,
  type AdminEvent, type AdminOverview, type AdminRole, type AdminWorkspaceDetail, type AdminWorkspaceFilters, type AdminWorkspaceRow } from "@/lib/admin";
import "./admin.css";

/**
 * The internal backoffice, as pure presentation: every component takes what it shows as props and reads nothing.
 * /admin feeds them from the admin RPCs (which check on the server that the caller is from the Bellis team);
 * /demo/admin feeds them mock data. Denser than the professional panel on purpose.
 */

export const adminSections = [
  { key: "Resumen", href: "/admin", icon: LayoutDashboard },
  { key: "Usuarios", href: "/admin/workspaces", icon: Users },
  { key: "Solicitudes Pro", href: "/admin/upgrades", icon: Sparkles },
] as const satisfies readonly { key: string; href: string; icon: LucideIcon }[];
export type AdminSection = (typeof adminSections)[number]["key"];

/**
 * "Hoy" for the relative dates ("hace 3 días"). The real backoffice uses the current time; the demo fixes it,
 * so its invented dates read the same whenever it is opened.
 */
export const AdminClock = createContext<Date | null>(null);
export function useClock(): Date {
  const fixed = useContext(AdminClock);
  return fixed ?? new Date();
}

/** How a workspace is opened: a link in the real backoffice, a state change in the demo. */
export type OpenWorkspace = { href?: (id: string) => string; onOpen?: (id: string) => void };
export function WorkspaceLink({ id, open, children, className }: { id: string; open: OpenWorkspace; children: ReactNode; className?: string }) {
  if (open.href) return <Link className={className} href={open.href(id)}>{children}</Link>;
  return <button type="button" className={className} onClick={() => open.onOpen?.(id)}>{children}</button>;
}

export function AdminFrame({ active, role, openRequests = 0, navigate, exit = { href: "/dashboard", label: "Volver a mi panel" }, banner, children }: {
  active: AdminSection; role?: AdminRole | null; openRequests?: number;
  /** Given in the demo, where sections are in-page state. Without it the entries are links. */
  navigate?: (section: AdminSection) => void; exit?: { href: string; label: string }; banner?: ReactNode; children: ReactNode;
}) {
  return <div className="bo-shell">
    <aside className="bo-side">
      <div className="bo-brand"><BellisLogo size="sm" /><span className="bo-brand-tag">Backoffice</span></div>
      <nav aria-label="Backoffice de Bellis">{adminSections.map(({ key, href, icon: Icon }) => {
        const content = <><Icon size={17} aria-hidden /><span>{key}</span>{key === "Solicitudes Pro" && openRequests > 0 && <b className="bo-count" aria-label={`${openRequests} abiertas`}>{openRequests}</b>}</>;
        const className = key === active ? "bo-nav active" : "bo-nav";
        return navigate ? <button key={key} type="button" className={className} aria-current={key === active ? "page" : undefined} onClick={() => navigate(key)}>{content}</button>
          : <Link key={key} className={className} aria-current={key === active ? "page" : undefined} href={href}>{content}</Link>;
      })}</nav>
      <div className="bo-side-foot">
        {role && <span className="bo-role">Equipo Bellis · {role === "admin" ? "Admin" : "Soporte"}</span>}
        <Link href={exit.href}><ArrowLeft size={15} aria-hidden /> {exit.label}</Link>
      </div>
    </aside>
    <main className="bo-main">{banner}{children}</main>
  </div>;
}

export function AdminHeader({ title, description, back, aside }: { title: string; description?: string; back?: ReactNode; aside?: ReactNode }) {
  return <header className="bo-head">{back}<div><h1>{title}</h1>{description && <p>{description}</p>}</div>{aside && <div className="bo-head-aside">{aside}</div>}</header>;
}
export function AdminState({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return <p className={`bo-state bo-state-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</p>;
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "sage" | "warn" }) {
  return <div className={`bo-stat${tone ? ` bo-stat-${tone}` : ""}`}><span>{label}</span><strong>{value.toLocaleString("es-AR")}</strong>{hint && <small>{hint}</small>}</div>;
}
/** The numbers of the product. Aggregates only: no names, no emails. */
export function OverviewCards({ overview }: { overview: AdminOverview }) {
  const o = overview;
  return <div className="bo-overview">
    <section aria-label="Cuentas"><h2>Cuentas</h2><div className="bo-stats">
      <Stat label="Usuarios registrados" value={o.total_users} hint={`+${o.registrations_last_7d} en 7 días · +${o.registrations_last_30d} en 30`} />
      <Stat label="Consultorios" value={o.total_workspaces} hint={`${o.onboarded_workspaces} con onboarding completo (${share(o.onboarded_workspaces, o.total_workspaces)})`} />
      <Stat label="Activos en 7 días" value={o.active_7d} hint={`${share(o.active_7d, o.onboarded_workspaces)} de los que completaron el onboarding`} tone="sage" />
      <Stat label="Activos en 30 días" value={o.active_30d} hint={`${share(o.active_30d, o.onboarded_workspaces)} de los que completaron el onboarding`} tone="sage" />
    </div></section>
    <section aria-label="Planes"><h2>Planes</h2><div className="bo-stats">
      <Stat label="En prueba de Pro" value={o.pro_trial_active} hint={`${o.trials_expiring_7d} vencen en los próximos 7 días`} />
      <Stat label="Pro" value={o.pro_active} />
      <Stat label="Free" value={o.free_active} hint="Incluye a quienes no terminaron el onboarding" />
      <Stat label="Solicitudes Pro abiertas" value={o.upgrade_requests_open} tone={o.upgrade_requests_open > 0 ? "warn" : undefined} />
    </div></section>
    <section aria-label="Para revisar"><h2>Para revisar</h2><div className="bo-stats">
      <Stat label="Reservas online en pausa" value={o.workspaces_with_booking_paused} hint="Página publicada, pero hoy nadie puede reservar" tone={o.workspaces_with_booking_paused > 0 ? "warn" : undefined} />
      <Stat label="Cuentas suspendidas" value={o.suspended_workspaces} />
    </div></section>
  </div>;
}

export function TierChip({ tier, suspended }: { tier: AdminWorkspaceRow["effective_tier"]; suspended?: boolean }) {
  if (suspended) return <span className="bo-chip bo-chip-off">Suspendida</span>;
  return <span className={`bo-chip bo-chip-${tier}`}>{tierLabels[tier]}</span>;
}

/** What happened lately. An event says what and where it came from, never who the patient is. */
export function EventList({ events, open, empty = "Todavía no hay actividad registrada." }: { events: AdminEvent[]; open?: OpenWorkspace; empty?: string }) {
  if (!events.length) return <AdminState>{empty}</AdminState>;
  return <ol className="bo-events">{events.map((event) => <li key={event.id} className={`bo-event bo-event-${eventKind(event.event_name)}`}>
    <span className="bo-event-dot" aria-hidden />
    <div><b>{eventLabel(event)}</b>
      {open && event.workspace_id && <WorkspaceLink id={event.workspace_id} open={open} className="bo-link">{event.workspace_name ?? "Consultorio"}</WorkspaceLink>}</div>
    <time dateTime={event.created_at}>{adminDateTime(event.created_at)}</time>
  </li>)}</ol>;
}

export function TrialsEnding({ rows, open }: { rows: AdminWorkspaceRow[]; open: OpenWorkspace }) {
  const clock = useClock();
  if (!rows.length) return <AdminState>No hay pruebas en curso.</AdminState>;
  return <ul className="bo-trials">{rows.map((row) => <li key={row.workspace_id}>
    <div><WorkspaceLink id={row.workspace_id} open={open} className="bo-link">{row.workspace_name}</WorkspaceLink><small>{row.owner_email ?? "Sin email"}</small></div>
    <div className="bo-trials-when"><b>Hasta el {lastValidDay(row.trial_ends_at)}</b><small>{row.active_7d ? "Activo esta semana" : `Última actividad: ${daysAgo(row.last_activity_at, clock)}`}</small></div>
  </li>)}</ul>;
}

export function WorkspaceFiltersBar({ filters, onChange }: { filters: AdminWorkspaceFilters; onChange: (next: AdminWorkspaceFilters) => void }) {
  const set = <K extends keyof AdminWorkspaceFilters>(key: K, value: AdminWorkspaceFilters[K]) => onChange({ ...filters, [key]: value });
  const count = activeFilterCount(filters);
  return <form className="bo-filters" role="search" onSubmit={(event) => event.preventDefault()}>
    <label className="bo-search"><Search size={16} aria-hidden /><span className="bo-sr">Buscar</span>
      <input type="search" value={filters.search} placeholder="Consultorio, email o profesión" onChange={(event) => set("search", event.target.value)} /></label>
    <label>Onboarding<select value={filters.onboarding} onChange={(event) => set("onboarding", event.target.value as AdminWorkspaceFilters["onboarding"])}>
      <option value="all">Todos</option><option value="complete">Completo</option><option value="incomplete">Sin terminar</option></select></label>
    <label>Plan<select value={filters.tier} onChange={(event) => set("tier", event.target.value as AdminWorkspaceFilters["tier"])}>
      <option value="all">Todos</option><option value="pro_trial">Prueba Pro</option><option value="pro">Pro</option><option value="free">Free</option></select></label>
    <label>Actividad<select value={filters.active} onChange={(event) => set("active", event.target.value as AdminWorkspaceFilters["active"])}>
      <option value="all">Cualquiera</option><option value="7d">Activos en 7 días</option><option value="30d">Activos en 30 días</option></select></label>
    <label>Orden<select value={filters.sort} onChange={(event) => set("sort", event.target.value as AdminWorkspaceFilters["sort"])}>
      {Object.entries(sortLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="bo-check"><input type="checkbox" checked={filters.upgradeRequested} onChange={(event) => set("upgradeRequested", event.target.checked)} /> Pidió Pro</label>
    <label className="bo-check"><input type="checkbox" checked={filters.bookingPaused} onChange={(event) => set("bookingPaused", event.target.checked)} /> Reservas en pausa</label>
    {count > 0 && <button type="button" className="bo-clear" onClick={() => onChange({ ...defaultWorkspaceFilters, sort: filters.sort })}>Limpiar filtros ({count})</button>}
  </form>;
}

function usageLine(row: AdminWorkspaceRow) {
  return `${row.patient_count} pacientes · ${row.appointment_count} turnos · ${row.public_booking_count} reservas públicas`;
}
/** A table on desktop; each row becomes a card on a phone. Counts and states only. */
export function WorkspaceTable({ rows, open }: { rows: AdminWorkspaceRow[]; open: OpenWorkspace }) {
  const clock = useClock();
  if (!rows.length) return <AdminState>Ningún consultorio coincide con estos filtros.</AdminState>;
  return <div className="bo-table-wrap"><table className="bo-table">
    <thead><tr><th>Consultorio</th><th>Registro</th><th>Plan</th><th>Último acceso del equipo</th><th>Última actividad</th><th>Uso</th><th>Reservas online</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.workspace_id}>
      <td data-label="Consultorio"><WorkspaceLink id={row.workspace_id} open={open} className="bo-link bo-name">{row.workspace_name}</WorkspaceLink>
        <small>{row.owner_email ?? "Sin email"}</small><small>{row.profession ?? "Sin profesión"}</small></td>
      <td data-label="Registro">{adminDate(row.registered_at)}<small>{row.onboarding_completed ? "Onboarding completo" : "Onboarding sin terminar"}</small></td>
      <td data-label="Plan"><TierChip tier={row.effective_tier} suspended={row.status === "suspended"} /><small>{planLine(row)}</small>
        {row.upgrade_request_open && <span className="bo-chip bo-chip-ask">Pidió Pro</span>}</td>
      <td data-label="Último acceso del equipo">{row.last_sign_in_at ? daysAgo(row.last_sign_in_at, clock) : "Sin ingresos todavía"}{row.last_sign_in_at && <small>{adminDate(row.last_sign_in_at)}</small>}</td>
      <td data-label="Última actividad">{daysAgo(row.last_activity_at, clock)}<small>{row.events_30d} eventos en 30 días</small></td>
      <td data-label="Uso">{usageLine(row)}<small>{row.followup_count} seguimientos · {row.automation_count} automatizaciones activas</small></td>
      <td data-label="Reservas online"><span className={row.booking_available ? "bo-ok" : row.booking_paused ? "bo-warn" : "bo-muted"}>{row.booking_available ? "Disponibles" : row.booking_paused ? "En pausa" : "Sin página"}</span>
        <small>{paymentProviderLabels[row.payment_provider] ?? row.payment_provider}</small></td>
    </tr>)}</tbody>
  </table></div>;
}

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (page: number) => void }) {
  const pages = pageCount(total, pageSize);
  return <div className="bo-pager"><span>{total.toLocaleString("es-AR")} {total === 1 ? "consultorio" : "consultorios"}</span>
    {pages > 1 && <div><button type="button" disabled={page <= 0} onClick={() => onPage(page - 1)} aria-label="Página anterior"><ChevronLeft size={16} aria-hidden /></button>
      <span>Página {page + 1} de {pages}</span>
      <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Página siguiente"><ChevronRight size={16} aria-hidden /></button></div>}
  </div>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="bo-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}
const yesNo = (value: boolean) => value ? "Sí" : "No";
/**
 * One workspace, in sections: account, what its plan includes, usage, payments, the commercial plan (given by the
 * caller, with its actions) and what happened lately.
 */
export function WorkspaceDetailView({ detail, commercial }: { detail: AdminWorkspaceDetail; commercial?: ReactNode }) {
  const d = detail; const remaining = daysRemainingLabel(d.days_remaining); const clock = useClock();
  return <div className="bo-detail">
    <section className="bo-card" aria-labelledby="bo-account"><h2 id="bo-account">Cuenta</h2><dl className="bo-facts">
      <Fact label="Consultorio">{d.workspace_name}</Fact>
      <Fact label="Email de quien la creó">{d.owner_email ?? "—"}</Fact>
      <Fact label="Profesión">{d.profession ?? "—"}</Fact>
      <Fact label="Registro">{adminDateTime(d.registered_at)}</Fact>
      <Fact label="Onboarding">{d.onboarding_completed ? `Completo el ${adminDate(d.onboarding_completed_at)}` : "Sin terminar"}</Fact>
      <Fact label="Estado">{d.status === "suspended" ? "Suspendida" : "Activa"}</Fact>
    </dl></section>
    <section className="bo-card" aria-labelledby="bo-plan"><h2 id="bo-plan">Lo que incluye hoy</h2>
      <p className="bo-plan-now"><TierChip tier={d.effective_tier} suspended={d.status === "suspended"} /><b>{planLine(d)}</b>{remaining && <span>{remaining}</span>}
        {d.upgrade_request_open && <span className="bo-chip bo-chip-ask">Pidió Pro el {adminDate(d.upgrade_requested_at)}</span>}</p>
      <div className="bo-caps" aria-label="Lo que incluye hoy">{shownCapabilities(d.capabilities).map((name) => <span key={name}>{name}</span>)}</div>
    </section>
    <section className="bo-card" aria-labelledby="bo-usage"><h2 id="bo-usage">Uso</h2>
      <dl className="bo-facts bo-when">
        <Fact label="Registro">{adminDate(d.registered_at)}<small>Cuándo creó la cuenta</small></Fact>
        <Fact label="Último acceso del equipo">{signInLine(d.last_sign_in_at, clock)}<small>Inicio de sesión más reciente de una persona de este espacio.</small></Fact>
        <Fact label="Última actividad">{activityLine(d.last_activity_at, clock)}<small>Última acción en el producto. Iniciar sesión no cuenta.</small></Fact>
      </dl>
      <div className="bo-stats bo-stats-small">
        <Stat label="Eventos en 7 días" value={d.events_7d} /><Stat label="Eventos en 30 días" value={d.events_30d} />
        <Stat label="Pacientes" value={d.patient_count} /><Stat label="Turnos" value={d.appointment_count} /><Stat label="Reservas públicas" value={d.public_booking_count} />
        <Stat label="Seguimientos" value={d.followup_count} /><Stat label="Automatizaciones activas" value={d.automation_count} />
      </div></section>
    <section className="bo-card" aria-labelledby="bo-pay"><h2 id="bo-pay">Cobros y reservas</h2><dl className="bo-facts">
      <Fact label="Medio de cobro">{paymentProviderLabels[d.payment_provider] ?? d.payment_provider}</Fact>
      <Fact label="Link externo cargado">{yesNo(d.external_link_configured)}</Fact>
      <Fact label="Mercado Pago conectado">{yesNo(d.mercado_pago_connected)}</Fact>
      <Fact label="Reservas online"><span className={d.booking_available ? "bo-ok" : d.booking_paused ? "bo-warn" : "bo-muted"}>{bookingLine(d)}</span></Fact>
    </dl></section>
    {commercial}
    <section className="bo-card bo-card-wide" aria-labelledby="bo-timeline"><h2 id="bo-timeline">Últimos eventos</h2>
      <p className="bo-note">Qué pasó y cuándo. Nunca el contenido: ni nombres de pacientes, ni notas, ni respuestas de formularios.</p>
      <EventList events={d.timeline} empty="Este consultorio todavía no tiene eventos." /></section>
  </div>;
}
