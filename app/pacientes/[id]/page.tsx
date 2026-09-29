"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Check, Mail, MessageCircle, Pencil, Plus, X } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../CrmShell";
import { crmBirthDate, crmDate, crmMoney, errorMessage, fetchPages, loadCrmContext, statusLabels, type CrmContext, type PatientOverview, type PatientStatus } from "../crm";
import { buildPatientTimeline, followUpBucket, followUpLabels, priorityLabels, todayInTimezone, type Activity, type Appointment, type FollowUp, type Intent, type Note, type Payment } from "../timeline";

type Answer = { id: string; booking_intent_id: string; questionnaire_id: string; question_title: string; section_label: string; answer: unknown; created_at: string };
type Professional = { id: string; user_id: string | null; display_name: string };
type Details = { appointments: Appointment[]; intents: Intent[]; payments: Payment[]; answers: Answer[]; notes: Note[]; activities: Activity[]; followUps: FollowUp[]; services: { id: string; name: string }[]; professionals: Professional[]; questionnaires: { id: string; title: string }[] };
const emptyDetails: Details = { appointments: [], intents: [], payments: [], answers: [], notes: [], activities: [], followUps: [], services: [], professionals: [], questionnaires: [] };
const appointmentLabels: Record<string, string> = { scheduled: "Programado", completed: "Completado", cancelled: "Cancelado", refunded: "Reembolsado", awaiting_schedule: "Pendiente de horario" };
const paymentLabels: Record<string, string> = { pending: "Pendiente", approved: "Aprobado", rejected: "Rechazado", refunded: "Reembolsado", cancelled: "Cancelado", expired: "Vencido" };
const emptyFollowUp = { title: "", description: "", due_date: "", due_time: "", priority: "medium" as FollowUp["priority"] };
type ActivityType = "note" | Activity["type"];
function answerText(value: unknown): string { if (Array.isArray(value)) return value.map(answerText).join(", "); if (value === null || value === undefined) return "—"; if (typeof value === "object") return JSON.stringify(value); if (typeof value === "boolean") return value ? "Sí" : "No"; return String(value); }
function dateOnly(value: string): string { const [year, month, day] = value.split("-"); return `${day}/${month}/${year}`; }

export default function PatientDetailPage() {
  const params = useParams();
  const patientId = typeof params.id === "string" ? params.id : "";
  const [context, setContext] = useState<CrmContext | null>(null);
  const [patient, setPatient] = useState<PatientOverview | null>(null);
  const [details, setDetails] = useState<Details>(emptyDetails);
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityType, setActivityType] = useState<ActivityType>("note");
  const [activityTitle, setActivityTitle] = useState("");
  const [activityDescription, setActivityDescription] = useState("");
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [editingFollowUp, setEditingFollowUp] = useState<string | null>(null);
  const [followUpDraft, setFollowUpDraft] = useState(emptyFollowUp);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const nextContext = await loadCrmContext();
        if (!/^[0-9a-f-]{36}$/i.test(patientId)) throw new Error("No encontramos ese paciente.");
        const client = await getSupabase();
        const { data: auth } = await client.auth.getUser();
        const { data: person, error: patientError } = await client.from("patient_crm_overview").select("*")
          .eq("id", patientId).eq("workspace_id", nextContext.workspaceId).maybeSingle();
        if (patientError) throw patientError;
        if (!person) throw new Error("No encontramos ese paciente en tu espacio.");
        const workspace = nextContext.workspaceId;
        const [appointments, intents, answers, notes, activities, followUps] = await Promise.all([
          fetchPages<Appointment>(async (from, to) => await client.from("appointments").select("id,booking_intent_id,professional_id,starts_at,status,created_at,status_changed_at").eq("workspace_id", workspace).eq("patient_id", patientId).order("starts_at", { ascending: false }).range(from, to)),
          fetchPages<Intent>(async (from, to) => await client.from("booking_intents").select("id,service_id,professional_id,created_at").eq("workspace_id", workspace).eq("patient_id", patientId).order("created_at", { ascending: false }).range(from, to)),
          fetchPages<Answer>(async (from, to) => await client.from("questionnaire_answers").select("id,booking_intent_id,questionnaire_id,question_title,section_label,answer,created_at").eq("workspace_id", workspace).eq("patient_id", patientId).order("created_at", { ascending: false }).range(from, to)),
          fetchPages<Note>(async (from, to) => await client.from("patient_notes").select("id,author_id,content,created_at,updated_at").eq("workspace_id", workspace).eq("patient_id", patientId).order("created_at", { ascending: false }).range(from, to)),
          fetchPages<Activity>(async (from, to) => await client.from("patient_activities").select("id,professional_id,type,title,description,created_by,created_at").eq("workspace_id", workspace).eq("patient_id", patientId).order("created_at", { ascending: false }).range(from, to)),
          fetchPages<FollowUp>(async (from, to) => await client.from("patient_follow_ups").select("id,patient_id,professional_id,title,description,due_date,due_time,priority,status,completed_at,cancelled_at,created_by,created_at,updated_at").eq("workspace_id", workspace).eq("patient_id", patientId).order("due_date").range(from, to))
        ]);
        const payments: Payment[] = [];
        for (let i = 0; i < intents.length; i += 50) {
          const ids = intents.slice(i, i + 50).map((intent) => intent.id);
          payments.push(...await fetchPages<Payment>(async (from, to) => await client.from("payments").select("id,booking_intent_id,amount_minor,currency_code,status,created_at,approved_at").eq("workspace_id", workspace).in("booking_intent_id", ids).order("created_at", { ascending: false }).range(from, to)));
        }
        const [services, professionals, questionnaires] = await Promise.all([
          fetchPages<{ id: string; name: string }>(async (from, to) => await client.from("services").select("id,name").eq("workspace_id", workspace).range(from, to)),
          fetchPages<Professional>(async (from, to) => await client.from("professionals").select("id,user_id,display_name").eq("workspace_id", workspace).range(from, to)),
          fetchPages<{ id: string; title: string }>(async (from, to) => await client.from("questionnaires").select("id,title").eq("workspace_id", workspace).range(from, to))
        ]);
        if (!cancelled) {
          setContext(nextContext); setPatient(person as PatientOverview);
          setDetails({ appointments, intents, payments, answers, notes, activities, followUps, services, professionals, questionnaires });
          setUserId(auth.user?.id ?? "");
        }
      } catch (caught) {
        const message = errorMessage(caught);
        if (message === "onboarding_required") window.location.replace("/onboarding");
        else if (message.includes("sesión")) window.location.replace("/ingresar");
        else if (!cancelled) setError(message);
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [patientId]);

  const intentById = useMemo(() => new Map(details.intents.map((item) => [item.id, item])), [details.intents]);
  const serviceById = useMemo(() => new Map(details.services.map((item) => [item.id, item.name])), [details.services]);
  const professionalById = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of details.professionals) { names.set(item.id, item.display_name); if (item.user_id) names.set(item.user_id, item.display_name); }
    return names;
  }, [details.professionals]);
  const questionnaireById = useMemo(() => new Map(details.questionnaires.map((item) => [item.id, item.title])), [details.questionnaires]);
  const answerGroups = useMemo(() => {
    const groups = new Map<string, Answer[]>();
    for (const answer of details.answers) {
      const key = `${answer.booking_intent_id}:${answer.questionnaire_id}`;
      groups.set(key, [...(groups.get(key) ?? []), answer]);
    }
    return [...groups.values()].sort((a, b) => b[0].created_at.localeCompare(a[0].created_at));
  }, [details.answers]);
  const timeline = useMemo(() => patient && context ? buildPatientTimeline({
    patientCreatedAt: patient.created_at, appointments: details.appointments, intents: details.intents,
    payments: details.payments, notes: details.notes, activities: details.activities, followUps: details.followUps,
    services: serviceById, professionals: professionalById,
    money: (amount, currency) => crmMoney(amount, { ...context.market, currency })
  }) : [], [patient, context, details, serviceById, professionalById]);
  const today = context ? todayInTimezone(context.market.timezone) : "";
  const pendingFollowUps = details.followUps.filter((item) => item.status === "pending");
  const nextFollowUp = pendingFollowUps[0];
  const whatsappDigits = patient?.phone?.replace(/\D/g, "") ?? "";
  const whatsappUrl = whatsappDigits.startsWith("54") && whatsappDigits.length >= 12 && whatsappDigits.length <= 14
    ? `https://wa.me/${whatsappDigits}?text=${encodeURIComponent(`Hola ${patient?.first_name ?? ""}, ¿cómo estás? Te escribo para consultar cómo seguimos con tu próxima sesión.`)}` : null;

  async function saveStatus(status: PatientStatus) {
    if (!patient || !context) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const client = await getSupabase();
      const { data, error: saveError } = await client.from("patients").update({ status }).eq("id", patient.id).eq("workspace_id", context.workspaceId).select("status").single();
      if (saveError) throw saveError;
      setPatient({ ...patient, status: data.status as PatientStatus }); setNotice("Estado guardado.");
    } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }

  async function saveActivity() {
    if (!patient || !context || !userId || !activityDescription.trim() || (activityType === "note" && !activityTitle.trim())) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const client = await getSupabase();
      if (activityType === "note") {
        const content = `${activityTitle.trim()}\n\n${activityDescription.trim()}`;
        const result = editingNote
          ? await client.from("patient_notes").update({ content }).eq("id", editingNote).eq("workspace_id", context.workspaceId).eq("patient_id", patient.id).select("id,author_id,content,created_at,updated_at").single()
          : await client.from("patient_notes").insert({ workspace_id: context.workspaceId, patient_id: patient.id, author_id: userId, content }).select("id,author_id,content,created_at,updated_at").single();
        if (result.error || !result.data) throw result.error ?? new Error("No pudimos guardar la nota.");
        const saved = result.data as Note;
        setDetails((value) => ({ ...value, notes: editingNote ? value.notes.map((note) => note.id === saved.id ? saved : note) : [saved, ...value.notes] }));
      } else {
        const { data, error: saveError } = await client.from("patient_activities").insert({
          workspace_id: context.workspaceId, patient_id: patient.id, professional_id: context.professionalId,
          type: activityType, title: activityTitle.trim() || { call: "Llamada", email: "Email", whatsapp: "WhatsApp", other: "Interacción" }[activityType],
          description: activityDescription.trim(), created_by: userId
        }).select("id,professional_id,type,title,description,created_by,created_at").single();
        if (saveError || !data) throw saveError ?? new Error("No pudimos registrar la actividad.");
        setDetails((value) => ({ ...value, activities: [data as Activity, ...value.activities] }));
      }
      setActivityOpen(false); setActivityTitle(""); setActivityDescription(""); setEditingNote(null);
      setNotice(editingNote ? "Nota actualizada." : "Actividad registrada.");
    } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }

  function openFollowUp(item?: FollowUp) {
    setEditingFollowUp(item?.id ?? null);
    setFollowUpDraft(item ? { title: item.title, description: item.description, due_date: item.due_date, due_time: item.due_time?.slice(0, 5) ?? "", priority: item.priority } : emptyFollowUp);
    setFollowUpOpen(true);
  }

  async function saveFollowUp() {
    if (!patient || !context || !userId || !followUpDraft.title.trim() || !followUpDraft.due_date) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const client = await getSupabase();
      const values = { title: followUpDraft.title.trim(), description: followUpDraft.description.trim(), due_date: followUpDraft.due_date, due_time: followUpDraft.due_time || null, priority: followUpDraft.priority };
      const result = editingFollowUp
        ? await client.from("patient_follow_ups").update(values).eq("id", editingFollowUp).eq("patient_id", patient.id).eq("workspace_id", context.workspaceId).select("*").single()
        : await client.from("patient_follow_ups").insert({ ...values, workspace_id: context.workspaceId, patient_id: patient.id, professional_id: context.professionalId, created_by: userId }).select("*").single();
      if (result.error || !result.data) throw result.error ?? new Error("No pudimos guardar el seguimiento.");
      const saved = result.data as FollowUp;
      setDetails((value) => ({ ...value, followUps: (editingFollowUp ? value.followUps.map((item) => item.id === saved.id ? saved : item) : [...value.followUps, saved]).sort((a, b) => a.due_date.localeCompare(b.due_date)) }));
      setFollowUpOpen(false); setEditingFollowUp(null); setNotice("Seguimiento guardado.");
    } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }

  async function changeFollowUpStatus(item: FollowUp, status: "completed" | "cancelled") {
    if (!context) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const client = await getSupabase();
      const { data, error: saveError } = await client.from("patient_follow_ups").update({ status }).eq("id", item.id).eq("patient_id", item.patient_id).eq("workspace_id", context.workspaceId).select("*").single();
      if (saveError || !data) throw saveError ?? new Error("No pudimos actualizar el seguimiento.");
      setDetails((value) => ({ ...value, followUps: value.followUps.map((existing) => existing.id === item.id ? data as FollowUp : existing) }));
      setNotice(status === "completed" ? "Seguimiento completado." : "Seguimiento cancelado.");
    } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }

  return <CrmShell context={context} breadcrumb="Pacientes / Ficha">
    <Link className="crm-back" href="/pacientes"><ArrowLeft size={16}/> Volver a pacientes</Link>
    {loading ? <div className="demo-panel live-state" role="status">Cargando ficha del paciente…</div>
      : error && !patient ? <div className="demo-panel live-state" role="alert">{error}</div>
      : patient && context && <>
        <div className="demo-title-row"><div><p className="demo-date">FICHA DEL PACIENTE</p><h1>{patient.full_name}</h1><p>Historial de atención y seguimiento.</p></div><span className={`crm-badge crm-${patient.status}`}>{statusLabels[patient.status]}</span></div>
        {error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}
        <section className="demo-panel crm-overview"><div className="crm-summary">
          <div><span>Último turno</span><strong>{crmDate(patient.last_turn, context.market)}</strong></div>
          <div><span>Próximo turno</span><strong>{crmDate(patient.next_turn, context.market)}</strong></div>
          <div><span>Turnos</span><strong>{patient.turn_count}</strong></div>
          <div><span>Total pagado</span><strong>{crmMoney(patient.approved_total_minor, context.market)}</strong></div>
          <div><span>Seguimiento</span><strong>{nextFollowUp ? `${followUpLabels[followUpBucket(nextFollowUp.due_date, today)]} · ${dateOnly(nextFollowUp.due_date)}` : "Sin seguimiento"}</strong></div>
        </div></section>
        <div className="crm-detail-grid"><section className="demo-panel"><h2>Información</h2><dl className="crm-info">
          <div><dt>Nombre</dt><dd>{patient.first_name}</dd></div><div><dt>Apellido</dt><dd>{patient.last_name}</dd></div><div><dt>Email</dt><dd>{patient.email}</dd></div><div><dt>Teléfono</dt><dd>{patient.phone || "No informado"}</dd></div><div><dt>Fecha de nacimiento</dt><dd>{crmBirthDate(patient.date_of_birth, context.market)}</dd></div>
        </dl><label className="crm-status-field">Estado<select value={patient.status} disabled={saving} onChange={(event) => void saveStatus(event.target.value as PatientStatus)}>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <div className="crm-contact"><a href={`mailto:${patient.email}`}><Mail size={16}/> Enviar email</a>{whatsappUrl && <a href={whatsappUrl} target="_blank" rel="noreferrer"><MessageCircle size={16}/> WhatsApp</a>}</div>
          <p className="crm-hint">Abrir un enlace no registra un envío. Podés anotarlo como actividad después.</p>
        </section><section className="demo-panel"><div className="crm-section-head"><h2>Próximos seguimientos</h2><button className="demo-primary" onClick={() => openFollowUp()}><Plus size={16}/> Nuevo</button></div>
          {pendingFollowUps.length ? <div className="crm-follow-up-list">{pendingFollowUps.map((item) => <article key={item.id} className="crm-follow-up">
            <div><span className={`crm-badge crm-priority-${item.priority}`}>{priorityLabels[item.priority]}</span><span className={`crm-follow-up-state crm-${followUpBucket(item.due_date, today)}`}>{followUpLabels[followUpBucket(item.due_date, today)]}</span></div>
            <strong>{item.title}</strong><p>{item.description}</p><small>{dateOnly(item.due_date)}{item.due_time ? ` · ${item.due_time.slice(0, 5)}` : ""}</small>
            <div className="crm-follow-up-actions"><button disabled={saving} onClick={() => void changeFollowUpStatus(item, "completed")}><Check size={14}/> Completar</button><button disabled={saving} onClick={() => openFollowUp(item)}><Pencil size={14}/> Editar</button><button disabled={saving} onClick={() => void changeFollowUpStatus(item, "cancelled")}><X size={14}/> Cancelar</button></div>
          </article>)}</div> : <p className="live-empty">No hay seguimientos pendientes.</p>}
        </section></div>
        {followUpOpen && <section className="demo-panel crm-section"><h2>{editingFollowUp ? "Editar seguimiento" : "Nuevo seguimiento"}</h2><div className="crm-form-grid">
          <label>Título<input maxLength={160} value={followUpDraft.title} onChange={(e) => setFollowUpDraft({ ...followUpDraft, title: e.target.value })}/></label>
          <label>Fecha<input type="date" value={followUpDraft.due_date} onChange={(e) => setFollowUpDraft({ ...followUpDraft, due_date: e.target.value })}/></label>
          <label>Hora opcional<input type="time" value={followUpDraft.due_time} onChange={(e) => setFollowUpDraft({ ...followUpDraft, due_time: e.target.value })}/></label>
          <label>Prioridad<select value={followUpDraft.priority} onChange={(e) => setFollowUpDraft({ ...followUpDraft, priority: e.target.value as FollowUp["priority"] })}>{Object.entries(priorityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="crm-wide">Descripción opcional<textarea maxLength={3000} value={followUpDraft.description} onChange={(e) => setFollowUpDraft({ ...followUpDraft, description: e.target.value })}/></label>
        </div><div className="crm-note-actions"><button className="demo-primary" disabled={saving || !followUpDraft.title.trim() || !followUpDraft.due_date} onClick={() => void saveFollowUp()}>Guardar seguimiento</button><button className="live-secondary" onClick={() => setFollowUpOpen(false)}>Cerrar</button></div></section>}
        <section className="demo-panel crm-section"><div className="crm-section-head"><div><h2>Historial</h2><p className="crm-hint">Turnos, pagos, notas, actividades y seguimientos en orden cronológico.</p></div><button className="demo-primary" onClick={() => { setActivityOpen(true); setEditingNote(null); setActivityType("note"); setActivityTitle(""); setActivityDescription(""); }}><Plus size={16}/> Registrar actividad</button></div>
          {activityOpen && <div id="crm-activity-form" className="crm-activity-form"><div className="crm-form-grid">
            <label>Tipo<select value={activityType} onChange={(e) => setActivityType(e.target.value as ActivityType)}><option value="note">Nota</option><option value="call">Llamada</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="other">Otro</option></select></label>
            <label>Título<input maxLength={120} value={activityTitle} onChange={(e) => setActivityTitle(e.target.value)}/></label>
            <label className="crm-wide">Descripción<textarea maxLength={activityType === "note" ? 4800 : 3000} value={activityDescription} onChange={(e) => setActivityDescription(e.target.value)}/></label>
          </div><div className="crm-note-actions"><button className="demo-primary" disabled={saving || !activityDescription.trim() || (activityType === "note" && !activityTitle.trim())} onClick={() => void saveActivity()}>{editingNote ? "Guardar nota" : "Guardar actividad"}</button><button className="live-secondary" onClick={() => { setActivityOpen(false); setEditingNote(null); }}>Cerrar</button></div><p className="crm-hint">Registrá solo contactos realizados. Evitá datos sensibles innecesarios.</p></div>}
          <div className="crm-timeline">{timeline.map((event) => <article className="crm-timeline-item" key={event.id}><div className={`crm-timeline-dot crm-event-${event.kind}`}/><div><time>{crmDate(event.at, context.market)}{event.approximate ? " · fecha aproximada" : ""}</time><strong>{event.title}</strong><p>{event.description}</p>{event.actor && <small>{event.actor}</small>}</div></article>)}</div>
        </section>
        <section className="demo-panel crm-section"><h2>Historial de turnos</h2>{details.appointments.length ? <div className="crm-records">{details.appointments.map((item) => { const intent = intentById.get(item.booking_intent_id); const payment = details.payments.find((p) => p.booking_intent_id === item.booking_intent_id && p.status === "approved"); return <div className="crm-record" key={item.id}><strong>{crmDate(item.starts_at, context.market)}</strong><div><b>{serviceById.get(intent?.service_id ?? "") ?? "Servicio no disponible"}</b><small>{professionalById.get(item.professional_id) ?? "Profesional no disponible"}</small></div><span>{appointmentLabels[item.status] ?? item.status}</span><span>Pago: {payment ? paymentLabels[payment.status] : "Sin registro"}</span></div>; })}</div> : <p className="live-empty">Todavía no hay turnos para este paciente.</p>}</section>
        <section className="demo-panel crm-section"><h2>Pagos</h2>{details.payments.length ? <div className="crm-records">{[...details.payments].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((item) => <div className="crm-record" key={item.id}><strong>{crmDate(item.approved_at ?? item.created_at, context.market)}</strong><div><b>{serviceById.get(intentById.get(item.booking_intent_id)?.service_id ?? "") ?? "Servicio no disponible"}</b></div><span>{crmMoney(item.amount_minor, { ...context.market, currency: item.currency_code.trim() })}</span><span>{paymentLabels[item.status] ?? item.status}</span></div>)}</div> : <p className="live-empty">Todavía no hay pagos registrados.</p>}</section>
        <section className="demo-panel crm-section"><h2>Preconsultas</h2>{answerGroups.length ? answerGroups.map((answers) => { const first = answers[0]; const intent = intentById.get(first.booking_intent_id); return <div className="crm-preconsult" key={`${first.booking_intent_id}:${first.questionnaire_id}`}><div className="crm-preconsult-head"><div><b>{questionnaireById.get(first.questionnaire_id) ?? "Preconsulta"}</b><small>{serviceById.get(intent?.service_id ?? "") ?? "Servicio no disponible"}</small></div><span>{crmDate(intent?.created_at ?? first.created_at, context.market)}</span></div>{answers.map((answer) => <div className="live-answer" key={answer.id}><small>{answer.section_label}</small><b>{answer.question_title}</b><p>{answerText(answer.answer)}</p></div>)}</div>; }) : <p className="live-empty">Todavía no hay respuestas de preconsulta.</p>}</section>
        <section className="demo-panel crm-section"><h2>Notas</h2><p className="crm-hint">Solo el equipo autorizado puede verlas.</p>{details.notes.length ? <div className="crm-notes">{details.notes.map((note) => <article className="crm-note" key={note.id}><div><b>{professionalById.get(note.author_id) ?? "Nota del equipo"}</b><small>{crmDate(note.created_at, context.market)}{note.updated_at !== note.created_at ? " · Editada" : ""}</small></div><p>{note.content}</p>{note.author_id === userId && <button onClick={() => { const [title, ...body] = note.content.split("\n\n"); setActivityTitle(body.length ? title : "Nota"); setActivityDescription(body.join("\n\n") || note.content); setActivityType("note"); setEditingNote(note.id); setActivityOpen(true); setTimeout(() => document.getElementById("crm-activity-form")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0); }}><Pencil size={14}/> Editar</button>}</article>)}</div> : <p className="live-empty">Todavía no hay notas.</p>}</section>
      </>}
  </CrmShell>;
}
