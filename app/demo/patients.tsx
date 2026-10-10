"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Cake, CalendarDays, Check, Mail, MessageCircle, Phone, Plus, Search } from "lucide-react";
import { FollowUpCard, OpportunityRow, PageHeader, PatientsTable, ProfileHeader, StatusTag, Tabs, Tag, Timeline, dateOnly } from "@/components/crm/CrmUi";
import { PatientNotes, type NoteDraft } from "@/components/crm/PatientNotes";
import { NewPatientForm, type NewPatientValues } from "@/components/crm/NewPatientForm";
import { useProfileTab } from "@/components/crm/useProfileTab";
import { formatDate, formatDateTime, formatMoney } from "@/lib/market";
import { detectOpportunities, hasAttention, opportunityFilters, type OpportunityOverview } from "../pacientes/opportunities";
import { buildPatientTimeline, followUpBucket, followUpLabels, type Note, type Payment } from "../pacientes/timeline";
import { demoDetails, demoFollowUp, demoNewPatient, demoPatients, demoProfessional, demoServiceNames, demoStatusLabels, emptyDemoDetails } from "./crm-data";
import { demoToday, type DemoTask } from "./showroom-data";
import { isLatePayment, latePaymentTag } from "@/lib/late-payments";
import { canRecordPayment, paymentLabel, type PaymentMethod } from "@/lib/manual-appointment";
import { RecordOfflinePayment } from "@/components/payments/RecordOfflinePayment";

type Showroom = { tasks: DemoTask[]; complete: (id: string) => void };
type Status = OpportunityOverview["status"];
const date = (value: string | null) => (value ? formatDateTime(value) : "—");
const money = (minor: number) => formatMoney(minor / 100);
const appointmentLabels: Record<string, string> = { scheduled: "Programado", completed: "Completado", cancelled: "Cancelado" };
const professionals = new Map([["pro", demoProfessional]]);

/** Showroom mirror of /pacientes and /pacientes/[id]. Mock data only; nothing is saved. */
export function DemoPatients({ state, profile, setProfile, fromFollowUps, followUps, automation }: { state: Showroom; profile: string | null; setProfile: (id: string | null) => void; fromFollowUps: boolean; followUps: () => void; automation: () => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");
  const [followUp, setFollowUp] = useState("all");
  const [opportunity, setOpportunity] = useState("all");
  const [sort, setSort] = useState("last_turn");
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  // Patients added by hand in the showroom. In memory only: nothing is saved and they go away with the visit.
  const [added, setAdded] = useState<{ patient: OpportunityOverview; notes: Note[] }[]>([]);
  const [creating, setCreating] = useState(false);
  const patients = useMemo(() => [...added.map((item) => item.patient), ...demoPatients(state.tasks)].map((item) => ({ ...item, status: statuses[item.id] ?? item.status })), [added, state.tasks, statuses]);
  const automatic = new Set(state.tasks.filter((task) => task.status === "pending" && task.source === "automation").map((task) => patients.find((item) => item.full_name === task.patient)?.id ?? ""));
  const selected = patients.find((item) => item.id === profile);
  if (selected) return <DemoProfile key={selected.id} patient={selected} initialNotes={added.find((item) => item.patient.id === selected.id)?.notes} state={state} back={fromFollowUps ? followUps : () => setProfile(null)} backLabel={fromFollowUps ? "Volver a seguimientos" : "Volver a pacientes"} automation={automation} setStatus={(value) => setStatuses({ ...statuses, [selected.id]: value })}/>;

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
    return !text || [item.full_name, item.email ?? "", item.phone ?? ""].some((value) => value.toLocaleLowerCase("es-AR").includes(text));
  }).sort((a, b) => sort === "full_name" ? a.full_name.localeCompare(b.full_name, "es-AR")
    : sort === "next_turn" ? (a.next_turn ?? "9").localeCompare(b.next_turn ?? "9") : (b.last_turn ?? "").localeCompare(a.last_turn ?? ""));
  const filtered = Boolean(text) || status !== "all" || followUp !== "all" || opportunity !== "all";
  // Same flow as the product, with the example patients standing in for the workspace.
  const createPatient = async (values: NewPatientValues) => {
    const now = new Date().toISOString();
    const patient = demoNewPatient(values);
    setAdded((list) => [{ patient, notes: values.note ? [{ id: `demo-note-${now}`, author_id: "pro", content: values.note, note_type: "general", created_at: now, updated_at: now }] : [] }, ...list]);
    setCreating(false); setProfile(patient.id);
  };

  return <>
    <PageHeader title="Pacientes" description="Información, turnos y seguimiento en un solo lugar."><button className="crm-btn" onClick={followUps}>Ver seguimientos <ArrowRight size={16}/></button><button className="demo-primary" type="button" disabled={creating} onClick={() => setCreating(true)}><Plus size={16}/> Nuevo paciente</button></PageHeader>
    {creating && <NewPatientForm lookup={async () => patients.map((item) => ({ id: item.id, full_name: item.full_name, phone: item.phone, email: item.email, created_at: item.created_at }))} onSave={createPatient} onCancel={() => setCreating(false)}
      renderOpen={(patient, content, variant) => <button type="button" className={variant === "primary" ? "demo-primary" : "crm-link"} onClick={() => { setCreating(false); setProfile(patient.id); }}>{content}</button>}/>}
    <section className="crm-card">
      <div className="crm-filterbar">
        <label className="crm-search"><Search size={16}/><input aria-label="Buscar pacientes" placeholder="Buscar por nombre, email o teléfono" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
        <label className="crm-select">Para revisar <select aria-label="Filtrar por sugerencia de seguimiento" value={opportunity} onChange={(event) => setOpportunity(event.target.value)}>{opportunityFilters.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label>
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

function DemoProfile({ patient, initialNotes, state, back, backLabel, automation, setStatus }: { patient: OpportunityOverview; initialNotes?: Note[]; state: Showroom; back: () => void; backLabel: string; automation: () => void; setStatus: (status: Status) => void }) {
  // Same navigation as the real record; the demo is one page, so its entries are cleared on leaving.
  const { tab, setTab, showFollowUp, clear } = useProfileTab(true);
  useEffect(() => clear, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [notice, setNotice] = useState("");
  const data = demoDetails[patient.id] ?? emptyDemoDetails;
  // Notes are editable in the showroom, but only in memory: they reset when the profile is closed.
  const [notes, setNotes] = useState<Note[]>(initialNotes ?? data.notes);
  const saveNote = async (draft: NoteDraft) => {
    const now = new Date().toISOString();
    setNotes((list) => draft.id ? list.map((item) => item.id === draft.id ? { ...item, content: draft.content, note_type: draft.note_type, updated_at: now } : item)
      : [{ id: `demo-note-${now}`, author_id: "pro", content: draft.content, note_type: draft.note_type, created_at: now, updated_at: now }, ...list]);
  };
  const deleteNote = async (id: string) => setNotes((list) => list.filter((item) => item.id !== id));
  // "Registrar pago" works in the showroom, in memory: the charge shows at once in turns, payments, history and totals.
  const [payments, setPayments] = useState<Payment[]>(data.payments);
  const unpaid = (list: Payment[]) => data.appointments.filter((item) => canRecordPayment({ source: data.intents.find((intent) => intent.id === item.booking_intent_id)?.source, appointmentStatus: item.status, hasPayment: list.some((payment) => payment.booking_intent_id === item.booking_intent_id) })).length;
  const charged = unpaid(data.payments) - unpaid(payments);
  const recorded = payments.filter((item) => item.provider === "offline").reduce((sum, item) => sum + item.amount_minor, 0);
  const recordPayment = async (intentId: string, method: PaymentMethod, amountMinor: number) => {
    const now = new Date().toISOString();
    setPayments((list) => [...list, { id: `demo-payment-${now}`, booking_intent_id: intentId, provider: "offline", method, amount_minor: amountMinor, currency_code: "ARS", status: "approved", created_at: now, approved_at: now }]);
    setNotice("Cobro registrado en la demo.");
  };
  const followUps = state.tasks.filter((task) => task.patient === patient.full_name).map(demoFollowUp).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const pending = followUps.filter((item) => item.status === "pending");
  const closed = followUps.filter((item) => item.status !== "pending");
  const opportunities = detectOpportunities({ ...patient, pending_payment_count: Math.max(0, patient.pending_payment_count - charged), has_pending_payment: patient.pending_payment_count - charged > 0 });
  const timeline = buildPatientTimeline({ patientCreatedAt: patient.created_at, appointments: data.appointments, intents: data.intents, payments, notes, activities: data.activities, followUps, services: demoServiceNames, professionals, money, paymentName: paymentLabel, isLatePayment });
  const service = (intentId: string) => demoServiceNames.get(data.intents.find((item) => item.id === intentId)?.service_id ?? "") ?? "Servicio";
  const next = patient.next_turn ? data.appointments.find((item) => item.starts_at === patient.next_turn) : undefined;
  const sample = () => setNotice("Acción de ejemplo: en la demo no se crean registros nuevos.");
  const pendingList = pending.length ? <div className="crm-tasks">{pending.map((item) => <FollowUpCard key={item.id} item={item} today={demoToday}><button onClick={() => { state.complete(item.id); setNotice("Seguimiento completado en la demo."); }}><Check size={14}/> Completar</button>{item.source === "automation" && <button onClick={automation}>Ver actividad</button>}</FollowUpCard>)}</div> : <p className="live-empty">No hay seguimientos pendientes.</p>;

  return <>
    <button className="crm-back showroom-text-button" onClick={back}><ArrowLeft size={15}/> {backLabel}</button>
    <ProfileHeader name={patient.full_name} status={<StatusTag status={patient.status}>{demoStatusLabels[patient.status]}</StatusTag>}
      contact={<>{patient.email && <span><Mail size={14}/> {patient.email}</span>}{patient.phone && <span><Phone size={14}/> {patient.phone}</span>}{patient.date_of_birth && <span><Cake size={14}/> {formatDate(patient.date_of_birth)}</span>}</>}
      actions={<><button className="crm-btn" onClick={sample}><Plus size={15}/> Registrar actividad</button><button className="demo-primary" onClick={sample}><Plus size={15}/> Nuevo seguimiento</button></>}
      stats={[
        { label: "Último turno", value: date(patient.last_turn) },
        { label: "Próximo turno", value: date(patient.next_turn) },
        { label: "Turnos", value: patient.turn_count },
        { label: "Total pagado", value: money(patient.approved_total_minor + recorded) },
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
        <PatientNotes notes={notes} authorName={() => demoProfessional} formatAt={date} canManage={() => true} onSave={saveNote} onDelete={deleteNote}/>
        <section className="crm-card"><div className="crm-card-head"><h2>Próximos seguimientos</h2><button className="crm-link" onClick={() => setTab("seguimientos")}>Ver todos <ArrowRight size={14}/></button></div>{pendingList}</section>
      </div>
      <div>
        <section className="crm-card"><div className="crm-card-head"><h2>Próximo turno</h2></div>{patient.next_turn ? <div className="crm-next-turn"><span className="crm-signal-icon crm-tone-sage"><CalendarDays size={16}/></span><div><strong>{date(patient.next_turn)}</strong>{next && <small>{service(next.booking_intent_id)}</small>}</div></div> : <p className="live-empty">Sin próximo turno reservado.</p>}</section>
        <section className="crm-card"><div className="crm-card-head"><h2>Datos del paciente</h2></div><dl className="crm-info">
          <div><dt>Nombre</dt><dd>{patient.first_name}</dd></div><div><dt>Apellido</dt><dd>{patient.last_name}</dd></div><div><dt>Email</dt><dd>{patient.email || "No informado"}</dd></div><div><dt>Teléfono</dt><dd>{patient.phone || "No informado"}</dd></div><div><dt>Nacimiento</dt><dd>{patient.date_of_birth ? formatDate(patient.date_of_birth) : "No informada"}</dd></div>
        </dl><label className="crm-status-field">Estado<select value={patient.status} onChange={(event) => { setStatus(event.target.value as Status); setNotice("Estado actualizado en la demo."); }}>{Object.entries(demoStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></section>
        <section className="crm-card"><div className="crm-card-head"><h2>Preconsulta</h2></div>{data.answers.length ? <div className="crm-mini"><b>{data.answers[0].questionnaire}</b><small>{date(data.answers[0].date)} · {data.answers.length} {data.answers.length === 1 ? "respuesta" : "respuestas"}</small><button className="crm-link" onClick={() => setTab("cuestionarios")}>Ver respuestas <ArrowRight size={14}/></button></div> : <p className="live-empty">Todavía no hay respuestas de preconsulta.</p>}</section>
        <section className="crm-card"><div className="crm-card-head"><h2>Acciones rápidas</h2></div><div className="crm-quick-actions">{patient.email && <button className="crm-btn" onClick={sample}><Mail size={15}/> Enviar email</button>}{patient.phone && <button className="crm-btn" onClick={sample}><MessageCircle size={15}/> WhatsApp</button>}</div>
          <p className="crm-hint">Abrir un enlace no registra un envío. Podés anotarlo como actividad después.</p></section>
      </div>
    </div>}

    {tab === "seguimientos" && <div className="crm-stack" role="tabpanel" aria-labelledby="crm-tab-seguimientos">
      <section className="crm-card"><div className="crm-card-head"><div><h2>Sugerencias de seguimiento</h2><p>Se actualizan según turnos, pagos y seguimientos. Revisá cada caso antes de actuar.</p></div></div>
        {opportunities.length ? <div className="crm-signals">{opportunities.map((item) => <OpportunityRow key={item.kind} item={item}>{item.level === "attention" && <button className="crm-link" onClick={sample}>Crear seguimiento</button>}</OpportunityRow>)}</div> : <p className="live-empty">No detectamos oportunidades de seguimiento en este momento.</p>}
      </section>
      <section className="crm-card"><div className="crm-card-head"><h2>Próximos seguimientos</h2><button className="crm-btn" onClick={sample}><Plus size={15}/> Nuevo</button></div>{pendingList}</section>
      {closed.length > 0 && <section className="crm-card"><div className="crm-card-head"><h2>Seguimientos anteriores</h2></div><div className="crm-tasks">{closed.map((item) => <FollowUpCard key={item.id} item={item} today={demoToday}/>)}</div></section>}
    </div>}

    {tab === "turnos" && <div className="crm-stack" role="tabpanel" aria-labelledby="crm-tab-turnos">
      <section className="crm-card"><div className="crm-card-head"><h2>Historial de turnos</h2></div><div className="crm-records">{data.appointments.map((item) => { const intent = data.intents.find((entry) => entry.id === item.booking_intent_id); const paid = payments.find((payment) => payment.booking_intent_id === item.booking_intent_id && payment.status === "approved") ?? payments.find((payment) => payment.booking_intent_id === item.booking_intent_id); return <div className="crm-record" key={item.id}><strong>{date(item.starts_at)}</strong><div><b>{service(item.booking_intent_id)}</b><small>{demoProfessional}</small></div><Tag tone={item.status === "completed" ? "sage" : "blue"}>{appointmentLabels[item.status] ?? item.status}</Tag><span>Pago: {paymentLabel(paid)}</span>{canRecordPayment({ source: intent?.source, appointmentStatus: item.status, hasPayment: !!paid }) && <div className="crm-record-wide"><RecordOfflinePayment priceMinor={intent?.price_minor ?? 0} formatMoney={money} onSave={(method, amountMinor) => recordPayment(item.booking_intent_id, method, amountMinor)}/></div>}</div>; })}</div></section>
      <section className="crm-card"><div className="crm-card-head"><h2>Pagos</h2></div>{payments.length ? <div className="crm-records">{[...payments].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((item) => <div className="crm-record" key={item.id}><strong>{date(item.approved_at ?? item.created_at)}</strong><div><b>{service(item.booking_intent_id)}</b><small>{paymentLabel(item)}</small></div><span>{money(item.amount_minor)}</span>{isLatePayment(item, data.intents.find((intent) => intent.id === item.booking_intent_id)) ? <Tag tone="orange">{latePaymentTag}</Tag> : <Tag tone={item.status === "approved" ? "sage" : "orange"}>{item.status === "approved" ? "Aprobado" : "Pendiente"}</Tag>}</div>)}</div> : <p className="live-empty">Todavía no hay pagos registrados.</p>}</section>
    </div>}

    {tab === "cuestionarios" && <section className="crm-card" role="tabpanel" aria-labelledby="crm-tab-cuestionarios"><div className="crm-card-head"><h2>Preconsultas</h2></div>{data.answers.length ? <div className="crm-preconsult"><div className="crm-preconsult-head"><div><b>{data.answers[0].questionnaire}</b><small>{data.answers[0].service}</small></div><span>{date(data.answers[0].date)}</span></div>{data.answers.map((answer) => <div className="live-answer" key={answer.id}><small>{answer.section}</small><b>{answer.question}</b><p>{answer.answer}</p></div>)}</div> : <p className="live-empty">Todavía no hay respuestas de preconsulta.</p>}</section>}
  </>;
}
