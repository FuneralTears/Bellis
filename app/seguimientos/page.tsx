"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Search } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../pacientes/CrmShell";
import { errorMessage, fetchPages, loadCrmContext, type CrmContext } from "../pacientes/crm";
import { followUpBucket, followUpLabels, priorityLabels, todayInTimezone, type FollowUp } from "../pacientes/timeline";

type PatientName = { id: string; full_name: string };
type StatusFilter = "pending" | "completed" | "cancelled" | "all";
type PriorityFilter = "all" | FollowUp["priority"];
const statusLabels = { pending: "Pendiente", completed: "Completado", cancelled: "Cancelado" };
function dateOnly(value: string): string { const [year, month, day] = value.split("-"); return `${day}/${month}/${year}`; }

export default function FollowUpsPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [patients, setPatients] = useState<PatientName[]>([]);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState<PriorityFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const nextContext = await loadCrmContext();
        const client = await getSupabase();
        const [tasks, names] = await Promise.all([
          fetchPages<FollowUp>(async (from, to) => await client.from("patient_follow_ups")
            .select("id,patient_id,professional_id,title,description,due_date,due_time,priority,status,completed_at,cancelled_at,created_by,created_at,updated_at")
            .eq("workspace_id", nextContext.workspaceId).order("due_date").range(from, to)),
          fetchPages<PatientName>(async (from, to) => await client.from("patient_crm_overview")
            .select("id,full_name").eq("workspace_id", nextContext.workspaceId).order("id").range(from, to))
        ]);
        if (!cancelled) { setContext(nextContext); setFollowUps(tasks); setPatients(names); }
      } catch (caught) {
        const message = errorMessage(caught);
        if (message === "onboarding_required") window.location.replace("/onboarding");
        else if (message.includes("sesión")) window.location.replace("/ingresar");
        else if (!cancelled) setError(message);
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  const today = context ? todayInTimezone(context.market.timezone) : "";
  const patientById = useMemo(() => new Map(patients.map((item) => [item.id, item.full_name])), [patients]);
  const counts = useMemo(() => ({
    pending: followUps.filter((item) => item.status === "pending").length,
    today: followUps.filter((item) => item.status === "pending" && item.due_date === today).length,
    overdue: followUps.filter((item) => item.status === "pending" && item.due_date < today).length,
    completed: followUps.filter((item) => item.status === "completed").length
  }), [followUps, today]);
  const visible = useMemo(() => followUps.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (priority !== "all" && item.priority !== priority) return false;
    return patientById.get(item.patient_id)?.toLocaleLowerCase("es-AR").includes(search.trim().toLocaleLowerCase("es-AR")) ?? false;
  }).sort((a, b) => {
    const rank = { overdue: 0, today: 1, upcoming: 2, none: 3 };
    return rank[followUpBucket(a.due_date, today)] - rank[followUpBucket(b.due_date, today)]
      || a.due_date.localeCompare(b.due_date) || (a.due_time ?? "").localeCompare(b.due_time ?? "");
  }), [followUps, patientById, search, priority, status, today]);

  async function complete(item: FollowUp) {
    if (!context) return;
    setSavingId(item.id); setError(""); setNotice("");
    try {
      const client = await getSupabase();
      const { data, error: saveError } = await client.from("patient_follow_ups").update({ status: "completed" })
        .eq("workspace_id", context.workspaceId).eq("id", item.id).select("*").single();
      if (saveError || !data) throw saveError ?? new Error("No pudimos completar el seguimiento.");
      setFollowUps((items) => items.map((existing) => existing.id === item.id ? data as FollowUp : existing));
      setNotice("Seguimiento completado.");
    } catch (caught) { setError(errorMessage(caught)); } finally { setSavingId(null); }
  }

  return <CrmShell context={context} breadcrumb="Seguimientos">
    <div className="demo-title-row"><div><p className="demo-date">PRÓXIMAS ACCIONES</p><h1>Seguimientos</h1><p>Lo que necesita atención en tu espacio profesional.</p></div></div>
    {error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}
    <div className="crm-follow-up-metrics">
      <div className="demo-panel"><span>Pendientes</span><strong>{loading ? "—" : counts.pending}</strong></div>
      <div className="demo-panel"><span>Hoy</span><strong>{loading ? "—" : counts.today}</strong></div>
      <div className="demo-panel"><span>Vencidos</span><strong>{loading ? "—" : counts.overdue}</strong></div>
      <div className="demo-panel"><span>Completados</span><strong>{loading ? "—" : counts.completed}</strong></div>
    </div>
    <section className="demo-panel crm-list-panel"><div className="crm-toolbar">
      <label className="crm-search"><Search size={18}/><input aria-label="Buscar paciente" placeholder="Buscar paciente" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
      <label className="crm-sort">Prioridad<select value={priority} onChange={(event) => setPriority(event.target.value as PriorityFilter)}><option value="all">Todas</option>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="crm-sort">Estado<select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}><option value="pending">Pendientes</option><option value="completed">Completados</option><option value="cancelled">Cancelados</option><option value="all">Todos</option></select></label>
    </div>
      {loading ? <p className="live-empty" role="status">Cargando seguimientos…</p> : visible.length ? <div className="crm-table-wrap"><table className="crm-table"><thead><tr><th>Paciente</th><th>Seguimiento</th><th>Fecha</th><th>Prioridad</th><th>Estado</th><th><span className="sr-only">Acciones</span></th></tr></thead><tbody>{visible.map((item) => <tr key={item.id}>
        <td><Link className="crm-person" href={`/pacientes/${item.patient_id}`}><b>{patientById.get(item.patient_id)}</b></Link></td>
        <td><b>{item.title}</b>{item.description && <small className="crm-cell-description">{item.description}</small>}</td>
        <td>{dateOnly(item.due_date)}{item.due_time ? ` · ${item.due_time.slice(0, 5)}` : ""}</td>
        <td><span className={`crm-badge crm-priority-${item.priority}`}>{priorityLabels[item.priority]}</span></td>
        <td><span className={`crm-follow-up-state crm-${followUpBucket(item.due_date, today)}`}>{item.status === "pending" ? followUpLabels[followUpBucket(item.due_date, today)] : statusLabels[item.status]}</span></td>
        <td><div className="crm-table-actions">{item.status === "pending" && <button disabled={savingId === item.id} onClick={() => void complete(item)}><Check size={14}/> Completar</button>}<Link href={`/pacientes/${item.patient_id}`} aria-label={`Ver paciente ${patientById.get(item.patient_id)}`}><ArrowRight size={16}/></Link></div></td>
      </tr>)}</tbody></table></div> : <p className="live-empty">No hay seguimientos con esos filtros.</p>}
    </section>
  </CrmShell>;
}
