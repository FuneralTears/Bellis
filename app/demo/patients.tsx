"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Cake, CalendarDays, Check, Mail, MessageCircle, Phone, Plus, Search } from "lucide-react";
import { FollowUpCard, OpportunityRow, PageHeader, PatientsTable, ProfileHeader, StatusTag, Tabs, Tag, Timeline, dateOnly } from "@/components/crm/CrmUi";
import { formatDate, formatDateTime, formatMoney } from "@/lib/market";
import { detectOpportunities, hasAttention, opportunityFilters, type OpportunityOverview } from "../pacientes/opportunities";
import { buildPatientTimeline, followUpBucket, followUpLabels } from "../pacientes/timeline";
import { demoDetails, demoFollowUp, demoPatients, demoProfessional, demoServiceNames, demoStatusLabels } from "./crm-data";
import { demoToday, type DemoTask } from "./showroom-data";

type Showroom = { tasks: DemoTask[]; complete: (id: string) => void };
type Status = OpportunityOverview["status"];
const date = (value: string | null) => (value ? formatDateTime(value) : "—");
const money = (minor: number) => formatMoney(minor / 100);
const appointmentLabels: Record<string, string> = { scheduled: "Programado", completed: "Completado", cancelled: "Cancelado" };
const professionals = new Map([["pro", demoProfessional]]);

/** Showroom mirror of /pacientes and /pacientes/[id]. Mock data only; nothing is saved. */
export function DemoPatients({ state, profile, setProfile, followUps, automation }: { state: Showroom; profile: string | null; setProfile: (id: string | null) => void; followUps: () => void; automation: () => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");
  const [followUp, setFollowUp] = useState("all");
  const [opportunity, setOpportunity] = useState("all");
  const [sort, setSort] = useState("last_turn");
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const patients = useMemo(() => demoPatients(state.tasks).map((item) => ({ ...item, status: statuses[item.id] ?? item.status })), [state.tasks, statuses]);
  const automatic = new Set(state.tasks.filter((task) => task.status === "pending" && task.source === "automation").map((task) => patients.find((item) => item.full_name === task.patient)?.id ?? ""));
  const selected = patients.find((item) => item.id === profile);
  if (selected) return <DemoProfile key={selected.id} patient={selected} state={state} back={() => setProfile(null)} automation={automation} setStatus={(value) => setStatuses({ ...statuses, [selected.id]: value })}/>;

  const text = query.trim().toLocaleLowerCase("es-AR");
  const column = opportunityFilters.find((item) => item.kind === opportunity)?.column;
  const visible = patients.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (followUp === "with" && !item.follow_up_due_date) return false;
    if (followUp === "without" && item.follow_up_due_date) return false;
    if (followUp === "overdue" && !(item.follow_up_due_date && item.follow_up_due_date < demoToday)) return false;
    if (followUp === "today" && item.follow_up_due_date !== demoToday) return false;
    if (opportunity === "attention" && !hasAttention(item)) return false;
    if (column && item[column] !== true) return false;
    return !text || [item.full_name, item.email, item.phone ?? ""].some((value) => value.toLocaleLowerCase("es-AR").includes(text));
  }).sort((a, b) => sort === "full_name" ? a.full_name.localeCompare(b.full_name, "es-AR")
    : sort === "next_turn" ? (a.next_turn ?? "9").localeCompare(b.next_turn ?? "9") : (b.last_turn ?? "").localeCompare(a.last_turn ?? ""));
  const filtered = Boolean(text) || status !== "all" || followUp !== "all" || opportunity !== "all";

  return <>
    <PageHeader title="Pacientes" description="Información, turnos y seguimiento en un solo lugar."><button className="demo-primary" onClick={followUps}>Ver seguimientos <ArrowRight size={16}/></button></PageHeader>
    <section className="crm-card">
      <div className="crm-filterbar">
        <label className="crm-search"><Search size={16}/><input aria-label="Buscar pacientes" placeholder="Buscar por nombre, email o teléfono" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
        <label className="crm-select">Oportunidad <select aria-label="Oportunidad de seguimiento" value={opportunity} onChange={(event) => setOpportunity(event.target.value)}>{opportunityFilters.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label>
        <label className="crm-select">Ordenar por <select value={sort} onChange={(event) => setSort(event.target.value)}><option value="last_turn">Último turno</option><option value="next_turn">Próximo turno</option><option value="full_name">Nombre</option></select></label>
      </div>
      <div className="crm-chip-rows">
        <div className="crm-chip-row"><span id="demo-filter-status">Estado</span><div className="crm-chips" role="group" aria-labelledby="demo-filter-status">{([["all", "Todos"], ["new", "Nuevos"], ["active", "Activos"], ["follow_up", "Seguimiento"], ["inactive", "Inactivos"]] as const).map(([value, label]) => <button key={value} aria-pressed={status === value} className={status === value ? "on" : ""} onClick={() => setStatus(value)}>{label}</button>)}</div></div>
        <div className="crm-chip-row"><span id="demo-filter-follow-up">Seguimiento</span><div className="crm-chips" role="group" aria-labelledby="demo-filter-follow-up">{([["all", "Todos"], ["with", "Con seguimiento"], ["without", "Sin seguimiento"], ["overdue", "Vencidos"], ["today", "Hoy"]] as const).map(([value, label]) => <button key={value} aria-pressed={followUp === value} className={followUp === value ? "on" : ""} onClick={() => setFollowUp(value)}>{label}</button>)}</div></div>
      </div>
      {visible.length === 0 ? <p className="live-empty">{filtered ? "No encontramos pacientes con esos filtros." : "Todavía no tenés pacientes."}</p> : <>
        <p className="crm-result-count">{visible.length} {visible.length === 1 ? "paciente" : "pacientes"}{filtered ? " con estos filtros" : ""}</p>
        <PatientsTable patients={visible} today={demoToday} automaticIds={automatic} formatDate={date} statusLabel={(value) => demoStatusLabels[value]}
          renderOpen={(patient, content, { className, label }) => <button type="button" className={className} aria-label={label} onClick={() => setProfile(patient.id)}>{content}</button>}/>
        <div className="crm-pagination"><span>Página 1 de 1</span><div><button disabled>Anterior</button><button disabled>Siguiente</button></div></div>
      </>}
    </section>
  </>;
}

type ProfileTab = "resumen" | "seguimientos" | "turnos" | "cuestionarios";
function DemoProfile({ patient, state, back, automation, setStatus }: { patient: OpportunityOverview; state: Showroom; back: () => void; automation: () => void; setStatus: (status: Status) => void }) {
  const [tab, setTab] = useState<ProfileTab>("resumen");
  const [notice, setNotice] = useState("");
  const data = demoDetails[patient.id];
  const followUps = state.tasks.filter((task) => task.patient === patient.full_name).map(demoFollowUp).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const pending = followUps.filter((item) => item.status === "pending");
  const closed = followUps.filter((item) => item.status !== "pending");
  const opportunities = detectOpportunities(patient);
  const timeline = buildPatientTimeline({ patientCreatedAt: patient.created_at, appointments: data.appointments, intents: data.intents, payments: data.payments, notes: data.notes, activities: data.activities, followUps, services: demoServiceNames, professionals, money });
  const service = (intentId: string) => demoServiceNames.get(data.intents.find((item) => item.id === intentId)?.service_id ?? "") ?? "Servicio";
  const next = patient.next_turn ? data.appointments.find((item) => item.starts_at === patient.next_turn) : undefined;
  const sample = () => setNotice("Acción de ejemplo: en la demo no se crean registros nuevos.");
  const showFollowUp = (id: string) => { setTab("seguimientos"); setTimeout(() => document.getElementById(`seguimiento-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0); };
  const pendingList = pending.length ? <div className="crm-tasks">{pending.map((item) => <FollowUpCard key={item.id} item={item} today={demoToday}><button onClick={() => { state.complete(item.id); setNotice("Seguimiento completado en la demo."); }}><Check size={14}/> Completar</button>{item.source === "automation" && <button onClick={automation}>Ver automatización</button>}</FollowUpCard>)}</div> : <p className="live-empty">No hay seguimientos pendientes.</p>;

  return <>
    <button className="crm-back showroom-text-button" onClick={back}><ArrowLeft size={15}/> Volver a pacientes</button>
    <ProfileHeader name={patient.full_name} status={<StatusTag status={patient.status}>{demoStatusLabels[patient.status]}</StatusTag>}
      contact={<><span><Mail size={14}/> {patient.email}</span>{patient.phone && <span><Phone size={14}/> {patient.phone}</span>}{patient.date_of_birth && <span><Cake size={14}/> {formatDate(patient.date_of_birth)}</span>}</>}
      actions={<><button className="crm-btn" onClick={sample}><Plus size={15}/> Registrar actividad</button><button className="demo-primary" onClick={sample}><Plus size={15}/> Nuevo seguimiento</button></>}
      stats={[
        { label: "Último turno", value: date(patient.last_turn) },
        { label: "Próximo turno", value: date(patient.next_turn) },
        { label: "Turnos", value: patient.turn_count },
        { label: "Total pagado", value: money(patient.approved_total_minor) },
        { label: "Seguimiento", value: pending[0] ? `${followUpLabels[followUpBucket(pending[0].due_date, demoToday)]} · ${dateOnly(pending[0].due_date)}` : "Sin seguimiento" },
      ]}/>
    <Tabs label="Secciones de la ficha" active={tab} onChange={setTab} tabs={[
      { id: "resumen", label: "Resumen" },
      { id: "seguimientos", label: "Seguimientos", count: pending.length },
      { id: "turnos", label: "Turnos", count: data.appointments.length },
      { id: "cuestionarios", label: "Cuestionarios", count: data.answers.length ? 1 : 0 },
    ]}/>
    {notice && <p className="live-success" role="status">{notice}</p>}

    {tab === "resumen" && <div className="crm-two-col crm-stack" role="tabpanel" aria-labelledby="crm-tab-resumen">
      <div>
        <section className="crm-card"><div className="crm-card-head"><div><h2>Historial</h2><p>Turnos, pagos, notas, actividades y seguimientos en orden cronológico.</p></div></div>
          <Timeline events={timeline} formatAt={(event) => `${date(event.at)}${event.approximate ? " · fecha aproximada" : ""}`} renderLinks={(event) => event.followUpId ? <button onClick={() => showFollowUp(event.followUpId!)}>Ver seguimiento</button> : null}/>
        </section>
        <section className="crm-card"><div className="crm-card-head"><div><h2>Notas</h2><p>Solo el equipo autorizado puede verlas.</p></div></div>{data.notes.length ? <div className="crm-notes">{data.notes.map((note) => <article className="crm-note" key={note.id}><div><b>{demoProfessional}</b><small>{date(note.created_at)}</small></div><p>{note.content}</p></article>)}</div> : <p className="live-empty">Todavía no hay notas.</p>}</section>
        <section className="crm-card"><div className="crm-card-head"><h2>Próximos seguimientos</h2><button className="crm-link" onClick={() => setTab("seguimientos")}>Ver todos <ArrowRight size={14}/></button></div>{pendingList}</section>
      </div>
      <div>
        <section className="crm-card"><div className="crm-card-head"><h2>Próximo turno</h2></div>{patient.next_turn ? <div className="crm-next-turn"><span className="crm-signal-icon crm-tone-sage"><CalendarDays size={16}/></span><div><strong>{date(patient.next_turn)}</strong>{next && <small>{service(next.booking_intent_id)}</small>}</div></div> : <p className="live-empty">Sin próximo turno reservado.</p>}</section>
        <section className="crm-card"><div className="crm-card-head"><h2>Datos del paciente</h2></div><dl className="crm-info">
          <div><dt>Nombre</dt><dd>{patient.first_name}</dd></div><div><dt>Apellido</dt><dd>{patient.last_name}</dd></div><div><dt>Email</dt><dd>{patient.email}</dd></div><div><dt>Teléfono</dt><dd>{patient.phone || "No informado"}</dd></div><div><dt>Nacimiento</dt><dd>{patient.date_of_birth ? formatDate(patient.date_of_birth) : "No informada"}</dd></div>
        </dl><label className="crm-status-field">Estado<select value={patient.status} onChange={(event) => { setStatus(event.target.value as Status); setNotice("Estado actualizado en la demo."); }}>{Object.entries(demoStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></section>
        <section className="crm-card"><div className="crm-card-head"><h2>Preconsulta</h2></div>{data.answers.length ? <div className="crm-mini"><b>{data.answers[0].questionnaire}</b><small>{date(data.answers[0].date)} · {data.answers.length} {data.answers.length === 1 ? "respuesta" : "respuestas"}</small><button className="crm-link" onClick={() => setTab("cuestionarios")}>Ver respuestas <ArrowRight size={14}/></button></div> : <p className="live-empty">Todavía no hay respuestas de preconsulta.</p>}</section>
        <section className="crm-card"><div className="crm-card-head"><h2>Acciones rápidas</h2></div><div className="crm-quick-actions"><button className="crm-btn" onClick={sample}><Mail size={15}/> Enviar email</button>{patient.phone && <button className="crm-btn" onClick={sample}><MessageCircle size={15}/> WhatsApp</button>}</div>
          <p className="crm-hint">Abrir un enlace no registra un envío. Podés anotarlo como actividad después.</p></section>
      </div>
    </div>}

    {tab === "seguimientos" && <div className="crm-stack" role="tabpanel" aria-labelledby="crm-tab-seguimientos">
      <section className="crm-card"><div className="crm-card-head"><div><h2>Oportunidades de seguimiento</h2><p>Se actualizan según turnos, pagos y seguimientos. Revisá cada caso antes de actuar.</p></div></div>
        {opportunities.length ? <div className="crm-signals">{opportunities.map((item) => <OpportunityRow key={item.kind} item={item}>{item.level === "attention" && <button className="crm-link" onClick={sample}>Crear seguimiento</button>}</OpportunityRow>)}</div> : <p className="live-empty">No detectamos oportunidades de seguimiento en este momento.</p>}
      </section>
      <section className="crm-card"><div className="crm-card-head"><h2>Próximos seguimientos</h2><button className="crm-btn" onClick={sample}><Plus size={15}/> Nuevo</button></div>{pendingList}</section>
      {closed.length > 0 && <section className="crm-card"><div className="crm-card-head"><h2>Seguimientos anteriores</h2></div><div className="crm-tasks">{closed.map((item) => <FollowUpCard key={item.id} item={item} today={demoToday}/>)}</div></section>}
    </div>}

    {tab === "turnos" && <div className="crm-stack" role="tabpanel" aria-labelledby="crm-tab-turnos">
      <section className="crm-card"><div className="crm-card-head"><h2>Historial de turnos</h2></div><div className="crm-records">{data.appointments.map((item) => { const paid = data.payments.find((payment) => payment.booking_intent_id === item.booking_intent_id && payment.status === "approved"); return <div className="crm-record" key={item.id}><strong>{date(item.starts_at)}</strong><div><b>{service(item.booking_intent_id)}</b><small>{demoProfessional}</small></div><Tag tone={item.status === "completed" ? "sage" : "blue"}>{appointmentLabels[item.status] ?? item.status}</Tag><span>Pago: {paid ? "Aprobado" : "Sin registro"}</span></div>; })}</div></section>
      <section className="crm-card"><div className="crm-card-head"><h2>Pagos</h2></div>{data.payments.length ? <div className="crm-records">{[...data.payments].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((item) => <div className="crm-record" key={item.id}><strong>{date(item.approved_at ?? item.created_at)}</strong><div><b>{service(item.booking_intent_id)}</b></div><span>{money(item.amount_minor)}</span><Tag tone={item.status === "approved" ? "sage" : "orange"}>{item.status === "approved" ? "Aprobado" : "Pendiente"}</Tag></div>)}</div> : <p className="live-empty">Todavía no hay pagos registrados.</p>}</section>
    </div>}

    {tab === "cuestionarios" && <section className="crm-card" role="tabpanel" aria-labelledby="crm-tab-cuestionarios"><div className="crm-card-head"><h2>Preconsultas</h2></div>{data.answers.length ? <div className="crm-preconsult"><div className="crm-preconsult-head"><div><b>{data.answers[0].questionnaire}</b><small>{data.answers[0].service}</small></div><span>{date(data.answers[0].date)}</span></div>{data.answers.map((answer) => <div className="live-answer" key={answer.id}><small>{answer.section}</small><b>{answer.question}</b><p>{answer.answer}</p></div>)}</div> : <p className="live-empty">Todavía no hay respuestas de preconsulta.</p>}</section>}
  </>;
}
