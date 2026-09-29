"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Mail, MessageCircle, Pencil } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../CrmShell";
import { crmBirthDate, crmDate, crmMoney, errorMessage, fetchPages, loadCrmContext, statusLabels, type CrmContext, type PatientOverview, type PatientStatus } from "../crm";

type Appointment = { id: string; booking_intent_id: string; professional_id: string; starts_at: string; status: string };
type Intent = { id: string; service_id: string; professional_id: string; created_at: string };
type Payment = { id: string; booking_intent_id: string; amount_minor: number; currency_code: string; status: string; created_at: string; approved_at: string | null };
type Answer = { id: string; booking_intent_id: string; questionnaire_id: string; question_title: string; section_label: string; answer: unknown; created_at: string };
type Note = { id: string; author_id: string; content: string; created_at: string; updated_at: string };
type Details = { appointments: Appointment[]; intents: Intent[]; payments: Payment[]; answers: Answer[]; notes: Note[]; services: { id: string; name: string }[]; professionals: { id: string; display_name: string }[]; questionnaires: { id: string; title: string }[] };
const emptyDetails: Details = { appointments: [], intents: [], payments: [], answers: [], notes: [], services: [], professionals: [], questionnaires: [] };
const appointmentLabels: Record<string,string> = { scheduled: "Programado", completed: "Completado", cancelled: "Cancelado", refunded: "Reembolsado", awaiting_schedule: "Pendiente de horario" };
const paymentLabels: Record<string,string> = { pending: "Pendiente", approved: "Aprobado", rejected: "Rechazado", refunded: "Reembolsado", cancelled: "Cancelado", expired: "Vencido" };
function answerText(value: unknown): string { if (Array.isArray(value)) return value.map(answerText).join(", "); if (value === null || value === undefined) return "—"; if (typeof value === "object") return JSON.stringify(value); if (typeof value === "boolean") return value ? "Sí" : "No"; return String(value); }

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
  const [draft, setDraft] = useState("");
  const [editingNote, setEditingNote] = useState<string | null>(null);

  useEffect(() => { let cancelled = false;
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
        const [appointments, intents, answers, notes] = await Promise.all([
          fetchPages<Appointment>(async (from,to) => await client.from("appointments").select("id,booking_intent_id,professional_id,starts_at,status").eq("workspace_id",workspace).eq("patient_id",patientId).order("starts_at",{ascending:false}).range(from,to)),
          fetchPages<Intent>(async (from,to) => await client.from("booking_intents").select("id,service_id,professional_id,created_at").eq("workspace_id",workspace).eq("patient_id",patientId).order("created_at",{ascending:false}).range(from,to)),
          fetchPages<Answer>(async (from,to) => await client.from("questionnaire_answers").select("id,booking_intent_id,questionnaire_id,question_title,section_label,answer,created_at").eq("workspace_id",workspace).eq("patient_id",patientId).order("created_at",{ascending:false}).range(from,to)),
          fetchPages<Note>(async (from,to) => await client.from("patient_notes").select("id,author_id,content,created_at,updated_at").eq("workspace_id",workspace).eq("patient_id",patientId).order("created_at",{ascending:false}).range(from,to))
        ]);
        const payments: Payment[] = [];
        for (let i=0;i<intents.length;i+=50) {
          const ids = intents.slice(i,i+50).map((intent) => intent.id);
          payments.push(...await fetchPages<Payment>(async (from,to) => await client.from("payments").select("id,booking_intent_id,amount_minor,currency_code,status,created_at,approved_at").eq("workspace_id",workspace).in("booking_intent_id",ids).order("created_at",{ascending:false}).range(from,to)));
        }
        const [services, professionals, questionnaires] = await Promise.all([
          fetchPages<{id:string;name:string}>(async (from,to) => await client.from("services").select("id,name").eq("workspace_id",workspace).range(from,to)),
          fetchPages<{id:string;display_name:string}>(async (from,to) => await client.from("professionals").select("id,display_name").eq("workspace_id",workspace).range(from,to)),
          fetchPages<{id:string;title:string}>(async (from,to) => await client.from("questionnaires").select("id,title").eq("workspace_id",workspace).range(from,to))
        ]);
        if (!cancelled) { setContext(nextContext); setPatient(person as PatientOverview); setDetails({appointments,intents,payments,answers,notes,services,professionals,questionnaires}); setUserId(auth.user?.id ?? ""); }
      } catch (caught) {
        const message = errorMessage(caught);
        if (message === "onboarding_required") window.location.replace("/onboarding");
        else if (message.includes("sesión")) window.location.replace("/ingresar");
        else if (!cancelled) setError(message);
      } finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; };
  }, [patientId]);

  const intentById = useMemo(() => new Map(details.intents.map((item) => [item.id,item])), [details.intents]);
  const serviceById = useMemo(() => new Map(details.services.map((item) => [item.id,item.name])), [details.services]);
  const professionalById = useMemo(() => new Map(details.professionals.map((item) => [item.id,item.display_name])), [details.professionals]);
  const questionnaireById = useMemo(() => new Map(details.questionnaires.map((item) => [item.id,item.title])), [details.questionnaires]);
  const answerGroups = useMemo(() => { const groups = new Map<string,Answer[]>(); for (const answer of details.answers) { const key = `${answer.booking_intent_id}:${answer.questionnaire_id}`; groups.set(key,[...(groups.get(key) ?? []),answer]); } return [...groups.values()].sort((a,b) => b[0].created_at.localeCompare(a[0].created_at)); }, [details.answers]);
  const paymentFor = (intentId: string) => details.payments.filter((item) => item.booking_intent_id === intentId).sort((a,b) => Number(b.status === "approved") - Number(a.status === "approved") || b.created_at.localeCompare(a.created_at))[0];
  const whatsappDigits = patient?.phone?.replace(/\D/g, "") ?? "";
  const whatsappUrl = whatsappDigits.startsWith("54") && whatsappDigits.length >= 12 && whatsappDigits.length <= 14 ? `https://wa.me/${whatsappDigits}?text=${encodeURIComponent(`Hola ${patient?.first_name ?? ""}, te escribo desde mi consultorio.`)}` : null;

  async function saveStatus(status: PatientStatus) {
    if (!patient || !context) return; setSaving(true); setError(""); setNotice("");
    try { const client = await getSupabase(); const { data, error: saveError } = await client.from("patients").update({status}).eq("id",patient.id).eq("workspace_id",context.workspaceId).select("status").single(); if (saveError) throw saveError; setPatient({...patient,status:data.status as PatientStatus}); setNotice("Estado guardado."); }
    catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }
  async function saveNote() {
    if (!patient || !context || !draft.trim() || !userId) return; setSaving(true); setError(""); setNotice("");
    try { const client = await getSupabase(); const content = draft.trim();
      const result = editingNote ? await client.from("patient_notes").update({content}).eq("id",editingNote).eq("patient_id",patient.id).eq("workspace_id",context.workspaceId).select("id,author_id,content,created_at,updated_at").single()
        : await client.from("patient_notes").insert({workspace_id:context.workspaceId,patient_id:patient.id,author_id:userId,content}).select("id,author_id,content,created_at,updated_at").single();
      if (result.error || !result.data) throw result.error ?? new Error("No pudimos guardar la nota.");
      const saved = result.data as Note;
      setDetails((value) => ({...value,notes:editingNote ? value.notes.map((note) => note.id === saved.id ? saved : note) : [saved,...value.notes]})); setDraft(""); setEditingNote(null); setNotice("Nota guardada.");
    } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }

  return <CrmShell context={context} breadcrumb="Pacientes / Ficha"><Link className="crm-back" href="/pacientes"><ArrowLeft size={16}/> Volver a pacientes</Link>{loading ? <div className="demo-panel live-state" role="status">Cargando ficha del paciente…</div> : error && !patient ? <div className="demo-panel live-state" role="alert">{error}</div> : patient && context && <><div className="demo-title-row"><div><p className="demo-date">FICHA DEL PACIENTE</p><h1>{patient.full_name}</h1><p>Historial de atención y seguimiento.</p></div><span className={`crm-badge crm-${patient.status}`}>{statusLabels[patient.status]}</span></div>{error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}<div className="crm-detail-grid"><section className="demo-panel"><h2>Información</h2><dl className="crm-info"><div><dt>Nombre</dt><dd>{patient.first_name}</dd></div><div><dt>Apellido</dt><dd>{patient.last_name}</dd></div><div><dt>Email</dt><dd>{patient.email}</dd></div><div><dt>Teléfono</dt><dd>{patient.phone || "No informado"}</dd></div><div><dt>Fecha de nacimiento</dt><dd>{crmBirthDate(patient.date_of_birth,context.market)}</dd></div></dl><label className="crm-status-field">Estado<select value={patient.status} disabled={saving} onChange={(event) => void saveStatus(event.target.value as PatientStatus)}>{Object.entries(statusLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="crm-contact"><a href={`mailto:${patient.email}`}><Mail size={16}/> Enviar email</a>{whatsappUrl && <a href={whatsappUrl} target="_blank" rel="noreferrer"><MessageCircle size={16}/> Contactar por WhatsApp</a>}</div></section><section className="demo-panel"><h2>Resumen</h2><div className="crm-summary"><div><span>Último turno</span><strong>{crmDate(patient.last_turn,context.market)}</strong></div><div><span>Próximo turno</span><strong>{crmDate(patient.next_turn,context.market)}</strong></div><div><span>Cantidad de turnos</span><strong>{patient.turn_count}</strong></div><div><span>Total pagado</span><strong>{crmMoney(patient.approved_total_minor,context.market)}</strong></div></div><p className="crm-hint">Total calculado con pagos aprobados en {patient.currency_code.trim()}.</p></section></div><section className="demo-panel crm-section"><h2>Historial de turnos</h2>{details.appointments.length ? <div className="crm-records">{details.appointments.map((item) => { const intent = intentById.get(item.booking_intent_id); const payment = paymentFor(item.booking_intent_id); return <div className="crm-record" key={item.id}><strong>{crmDate(item.starts_at,context.market)}</strong><div><b>{serviceById.get(intent?.service_id ?? "") ?? "Servicio no disponible"}</b><small>{professionalById.get(item.professional_id) ?? "Profesional no disponible"}</small></div><span>{appointmentLabels[item.status] ?? item.status}</span><span>Pago: {payment ? (paymentLabels[payment.status] ?? payment.status) : "Sin registro"}</span></div>; })}</div> : <p className="live-empty">Todavía no hay turnos para este paciente.</p>}</section><section className="demo-panel crm-section"><h2>Pagos</h2>{details.payments.length ? <div className="crm-records">{[...details.payments].sort((a,b) => b.created_at.localeCompare(a.created_at)).map((item) => <div className="crm-record" key={item.id}><strong>{crmDate(item.approved_at ?? item.created_at,context.market)}</strong><div><b>{serviceById.get(intentById.get(item.booking_intent_id)?.service_id ?? "") ?? "Servicio no disponible"}</b></div><span>{crmMoney(item.amount_minor,{...context.market,currency:item.currency_code.trim()})}</span><span>{paymentLabels[item.status] ?? item.status}</span></div>)}</div> : <p className="live-empty">Todavía no hay pagos registrados.</p>}</section><section className="demo-panel crm-section"><h2>Preconsultas</h2>{answerGroups.length ? answerGroups.map((answers) => { const first=answers[0]; const intent=intentById.get(first.booking_intent_id); return <div className="crm-preconsult" key={`${first.booking_intent_id}:${first.questionnaire_id}`}><div className="crm-preconsult-head"><div><b>{questionnaireById.get(first.questionnaire_id) ?? "Preconsulta"}</b><small>{serviceById.get(intent?.service_id ?? "") ?? "Servicio no disponible"}</small></div><span>{crmDate(intent?.created_at ?? first.created_at,context.market)}</span></div>{answers.map((answer) => <div className="live-answer" key={answer.id}><small>{answer.section_label}</small><b>{answer.question_title}</b><p>{answerText(answer.answer)}</p></div>)}</div>; }) : <p className="live-empty">Todavía no hay respuestas de preconsulta.</p>}</section><section className="demo-panel crm-section"><h2>Notas</h2><p className="crm-hint">Solo el equipo autorizado puede ver estas notas. Evitá registrar información sensible innecesaria.</p><label className="crm-note-label">{editingNote ? "Editar nota" : "Nueva nota"}<textarea value={draft} maxLength={5000} onChange={(event) => setDraft(event.target.value)} placeholder="Escribí una nota de seguimiento…"/></label><div className="crm-note-actions"><button className="demo-primary" disabled={saving || !draft.trim()} onClick={() => void saveNote()}>{saving ? "Guardando…" : editingNote ? "Guardar cambios" : "Guardar nota"}</button>{editingNote && <button className="live-secondary" onClick={() => {setEditingNote(null);setDraft("");}}>Cancelar</button>}</div>{details.notes.length ? <div className="crm-notes">{details.notes.map((note) => <article className="crm-note" key={note.id}><div><b>{note.author_id === userId ? "Tu nota" : "Nota del equipo"}</b><small>{crmDate(note.created_at,context.market)}{note.updated_at !== note.created_at ? " · Editada" : ""}</small></div><p>{note.content}</p>{note.author_id === userId && <button onClick={() => {setEditingNote(note.id);setDraft(note.content);}}><Pencil size={14}/> Editar</button>}</article>)}</div> : <p className="live-empty">Todavía no hay notas.</p>}</section></>}</CrmShell>;
}
