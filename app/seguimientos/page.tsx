"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, CircleAlert, Clock3, ListChecks, Search } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../pacientes/CrmShell";
import { errorMessage, fetchPages, loadCrmContext, type CrmContext } from "../pacientes/crm";
import { followUpBucket, priorityLabels, todayInTimezone, type FollowUp } from "../pacientes/timeline";
import { FollowUpsTable, KpiStrip, OpportunityRow, PageHeader } from "@/components/crm/CrmUi";
import { detectOpportunities, hasAttention, opportunityFilters, type OpportunityKind, type OpportunityOverview } from "../pacientes/opportunities";

type PatientName = { id: string; full_name: string };
type StatusFilter = "pending" | "completed" | "cancelled" | "all";
type PriorityFilter = "all" | FollowUp["priority"];
type SourceFilter = "all" | FollowUp["source"];
type SignalFilter = OpportunityKind | "all" | "attention";

export default function FollowUpsPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [patients, setPatients] = useState<PatientName[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityOverview[]>([]);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState<PriorityFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [signalFilter, setSignalFilter] = useState<SignalFilter>("attention");
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
        const [tasks, overviews] = await Promise.all([
          fetchPages<FollowUp>(async (from, to) => await client.from("patient_follow_ups")
            .select("id,patient_id,professional_id,title,description,due_date,due_time,priority,status,source,automation_run_id,completed_at,cancelled_at,created_by,created_at,updated_at")
            .eq("workspace_id", nextContext.workspaceId).order("due_date").range(from, to)),
          fetchPages<OpportunityOverview>(async (from, to) => await client.from("patient_follow_up_opportunities")
            .select("*").eq("workspace_id", nextContext.workspaceId).order("id").range(from, to))
        ]);
        if (!cancelled) { setContext(nextContext); setFollowUps(tasks); setPatients(overviews.map(({ id, full_name }) => ({ id, full_name }))); setOpportunities(overviews); }
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
    if (source !== "all" && item.source !== source) return false;
    return patientById.get(item.patient_id)?.toLocaleLowerCase("es-AR").includes(search.trim().toLocaleLowerCase("es-AR")) ?? false;
  }).sort((a, b) => {
    const rank = { overdue: 0, today: 1, upcoming: 2, none: 3 };
    return rank[followUpBucket(a.due_date, today)] - rank[followUpBucket(b.due_date, today)]
      || a.due_date.localeCompare(b.due_date) || (a.due_time ?? "").localeCompare(b.due_time ?? "");
  }), [followUps, patientById, search, priority, source, status, today]);
  const signalRows = useMemo(() => opportunities.flatMap((patient) => detectOpportunities(patient)
    .filter((item) => signalFilter === "all" || (signalFilter === "attention" ? item.level === "attention" : item.kind === signalFilter))
    .map((item) => ({ patient, item }))).filter(({ patient }) => patient.full_name.toLocaleLowerCase("es-AR").includes(search.trim().toLocaleLowerCase("es-AR")))
    .sort((a, b) => a.item.priority - b.item.priority || a.patient.full_name.localeCompare(b.patient.full_name, "es-AR")), [opportunities, search, signalFilter]);
  const attentionPatients = opportunities.filter(hasAttention).length;

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
    <PageHeader title="Seguimientos" description="Lo que necesita atención en tu espacio profesional."/>
    {error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}
    <KpiStrip items={[
      { label: "Pendientes", value: loading ? "—" : counts.pending, icon: ListChecks, tone: "petrol" },
      { label: "Hoy", value: loading ? "—" : counts.today, icon: Clock3, tone: "orange" },
      { label: "Vencidos", value: loading ? "—" : counts.overdue, icon: CircleAlert, tone: "coral" },
      { label: "Completados", value: loading ? "—" : counts.completed, icon: Check, tone: "sage" },
    ]}/>
    <section className="crm-card"><div className="crm-card-head"><div><h2>Oportunidades detectadas</h2><p>{loading ? "Analizando registros…" : `${attentionPatients} ${attentionPatients === 1 ? "paciente necesita" : "pacientes necesitan"} atención.`} Las señales se actualizan con tus datos.</p></div><label className="crm-select">Mostrar <select value={signalFilter} onChange={(event) => setSignalFilter(event.target.value as SignalFilter)}>{opportunityFilters.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label></div>
      {loading ? <p className="live-empty" role="status">Buscando oportunidades…</p> : signalRows.length ? <div className="crm-signals">{signalRows.map(({ patient, item }) => <OpportunityRow key={`${patient.id}:${item.kind}`} item={item} patientName={patient.full_name}><Link className="crm-link" href={`/pacientes/${patient.id}`}>Ver paciente <ArrowRight size={15}/></Link></OpportunityRow>)}</div> : <p className="live-empty">No hay oportunidades con ese filtro.</p>}
    </section>
    <section className="crm-card"><div className="crm-card-head"><div><h2>Tareas de seguimiento</h2></div></div><div className="crm-filterbar">
      <label className="crm-search"><Search size={16}/><input aria-label="Buscar paciente" placeholder="Buscar paciente" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
      <label className="crm-select">Prioridad<select value={priority} onChange={(event) => setPriority(event.target.value as PriorityFilter)}><option value="all">Todas</option>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="crm-select">Estado<select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}><option value="pending">Pendientes</option><option value="completed">Completados</option><option value="cancelled">Cancelados</option><option value="all">Todos</option></select></label>
      <label className="crm-select">Origen<select value={source} onChange={(event) => setSource(event.target.value as SourceFilter)}><option value="all">Todos</option><option value="manual">Manuales</option><option value="automation">Automáticos</option></select></label>
    </div>
      {loading ? <p className="live-empty" role="status">Cargando seguimientos…</p> : visible.length ? <FollowUpsTable items={visible} today={today} patientName={(item) => patientById.get(item.patient_id)}
        renderPatient={(item, content, { className }) => <Link className={className} href={`/pacientes/${item.patient_id}`}>{content}</Link>}
        renderActions={(item) => <>{item.status === "pending" && <button disabled={savingId === item.id} onClick={() => void complete(item)}><Check size={14}/> Completar</button>}{item.automation_run_id && <Link href={`/automatizaciones/ejecuciones?run=${item.automation_run_id}`}>Ver automatización</Link>}<Link href={`/pacientes/${item.patient_id}`} aria-label={`Ver paciente ${patientById.get(item.patient_id)}`}><ArrowRight size={16}/></Link></>}/> : <p className="live-empty">No hay seguimientos con esos filtros.</p>}
    </section>
  </CrmShell>;
}
