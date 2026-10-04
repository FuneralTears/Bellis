"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Clock3, ListChecks, Minus } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../../pacientes/CrmShell";
import { crmDate, errorMessage, loadCrmContext, type CrmContext } from "../../pacientes/crm";
import { dateBounds } from "./dateRange";
import { KpiStrip, PageHeader } from "@/components/crm/CrmUi";
import { ActivityDetail, ActivityList, RunStatusTag, runStatusLabels as labels, type RunRow } from "@/components/automation/AutomationUi";
import "./runs.css";

type Status = "scheduled" | "processing" | "completed" | "failed" | "cancelled" | "skipped";
type StatusFilter = "all" | Status;
type Period = "today" | "7d" | "30d" | "custom";
type Run = { id: string; workspace_id: string; automation_rule_id: string; patient_id: string; professional_id: string; triggered_at: string; scheduled_for: string; executed_at: string | null; created_at: string; status: Status; action_type: string; result: { reason?: string; follow_up_id?: string }; attempt_count: number; follow_up_id: string | null };
type Rule = { id: string; name: string; enabled: boolean };
type Patient = { id: string; first_name: string; last_name: string };
const pageSize = 20;

export default function AutomationRunsPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [ruleId, setRuleId] = useState("all");
  const [period, setPeriod] = useState<Period>("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Run | null>(null);
  const [selectedPatientName, setSelectedPatientName] = useState("");
  const [summary, setSummary] = useState({ today: 0, completed: 0, skipped: 0, failed: 0, pending: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => { let cancelled = false;
    async function load() { try {
      const next = await loadCrmContext();
      const client = await getSupabase();
      const { data, error: ruleError } = await client.from("automation_rules").select("id,name,enabled").eq("workspace_id", next.workspaceId).order("created_at");
      if (ruleError) throw ruleError;
      if (!cancelled) {
        const requested = new URLSearchParams(window.location.search).get("status");
        if (requested && requested in labels) setStatus(requested as Status);
        setContext(next); setRules((data ?? []) as Rule[]);
      }
    } catch (caught) {
      const message = errorMessage(caught);
      if (message === "onboarding_required") window.location.replace("/onboarding");
      else if (message.includes("sesión")) window.location.replace("/ingresar");
      else if (!cancelled) { setError(message); setLoading(false); }
    } }
    void load(); return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (!context) return; let cancelled = false;
    async function loadRuns() { setLoading(true); try {
      const client = await getSupabase();
      const bounds = dateBounds(period, context!.market.timezone, from, to);
      let query = client.from("automation_runs").select("id,workspace_id,automation_rule_id,patient_id,professional_id,triggered_at,scheduled_for,executed_at,created_at,status,action_type,result,attempt_count,follow_up_id", { count: "exact" })
        .eq("workspace_id", context!.workspaceId).gte("created_at", bounds.start).lt("created_at", bounds.end);
      if (status !== "all") query = query.eq("status", status);
      if (ruleId !== "all") query = query.eq("automation_rule_id", ruleId);
      const result = await query.order("created_at", { ascending: false }).range(page * pageSize, (page + 1) * pageSize - 1);
      if (result.error) throw result.error;
      const rows = (result.data ?? []) as Run[];
      const ids = [...new Set(rows.map((run) => run.patient_id))];
      const people = ids.length ? await client.from("patients").select("id,first_name,last_name").eq("workspace_id", context!.workspaceId).in("id", ids) : { data: [], error: null };
      if (people.error) throw people.error;
      if (!cancelled) { setRuns(rows); setPatients((people.data ?? []) as Patient[]); setTotal(result.count ?? 0); setError(""); }
    } catch (caught) { if (!cancelled) setError(errorMessage(caught)); }
    finally { if (!cancelled) setLoading(false); } }
    void loadRuns(); return () => { cancelled = true; };
  }, [context, status, ruleId, period, from, to, page, revision]);

  useEffect(() => { if (!context) return; let cancelled = false;
    async function loadSummary() { try {
      const client = await getSupabase();
      const { start, end } = dateBounds("today", context!.market.timezone, "", "");
      const base = () => client.from("automation_runs").select("id", { count: "exact", head: true }).eq("workspace_id", context!.workspaceId);
      const [today, completed, skipped, failed, pending] = await Promise.all([
        base().gte("executed_at", start).lt("executed_at", end),
        base().eq("status", "completed").gte("executed_at", start).lt("executed_at", end),
        base().eq("status", "skipped").gte("executed_at", start).lt("executed_at", end),
        base().eq("status", "failed").gte("executed_at", start).lt("executed_at", end),
        base().in("status", ["scheduled","processing"])
      ]);
      for (const item of [today,completed,skipped,failed,pending]) if (item.error) throw item.error;
      if (!cancelled) setSummary({ today: today.count ?? 0, completed: completed.count ?? 0, skipped: skipped.count ?? 0, failed: failed.count ?? 0, pending: pending.count ?? 0 });
    } catch (caught) { if (!cancelled) setError(errorMessage(caught)); } }
    void loadSummary(); return () => { cancelled = true; };
  }, [context, revision]);

  useEffect(() => { if (!context) return; const target = new URLSearchParams(window.location.search).get("run");
    if (!target || !/^[0-9a-f-]{36}$/i.test(target)) return;
    let cancelled = false;
    async function loadDeepLink() { try {
      const client = await getSupabase();
      const { data, error: detailError } = await client.from("automation_runs")
        .select("id,workspace_id,automation_rule_id,patient_id,professional_id,triggered_at,scheduled_for,executed_at,created_at,status,action_type,result,attempt_count,follow_up_id")
        .eq("workspace_id", context!.workspaceId).eq("id", target).maybeSingle();
      if (detailError) throw detailError;
      if (!cancelled && data) {
        setSelected(data as Run);
        const { data: person } = await client.from("patients").select("first_name,last_name")
          .eq("workspace_id", context!.workspaceId).eq("id", data.patient_id).maybeSingle();
        if (!cancelled && person) setSelectedPatientName(`${person.first_name} ${person.last_name}`);
      }
    } catch (caught) { if (!cancelled) setError(errorMessage(caught)); } }
    void loadDeepLink(); return () => { cancelled = true; };
  }, [context]);

  const selectedRunId = selected?.id;
  useEffect(() => { if (selectedRunId) document.getElementById(`ejecucion-${selectedRunId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [selectedRunId]);
  const ruleNames = useMemo(() => new Map(rules.map((rule) => [rule.id, rule.name])), [rules]);
  const patientNames = useMemo(() => new Map(patients.map((patient) => [patient.id, `${patient.first_name} ${patient.last_name}`])), [patients]);
  const selectedRule = selected ? rules.find((rule) => rule.id === selected.automation_rule_id) : null;

  async function retry(run: Run) { setSaving(true); setError(""); setNotice(""); try {
    const client = await getSupabase();
    const { error: retryError } = await client.rpc("retry_failed_automation_run", { p_run: run.id });
    if (retryError) throw new Error("No pudimos volver a intentarlo. Revisá que la automatización esté activa y que tengas permiso para hacerlo.");
    setSelected({ ...run, status: "scheduled", attempt_count: 0, executed_at: null, scheduled_for: new Date().toISOString() });
    setRevision((value) => value + 1); setNotice("Listo. Bellis lo va a intentar de nuevo en su próxima revisión automática.");
  } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); } }

  const stamp = (value: string | null) => context ? crmDate(value, context.market) : "—";
  const rows: RunRow[] = runs.map((run) => ({ id: run.id, rule: ruleNames.get(run.automation_rule_id) ?? "Automatización", patient: patientNames.get(run.patient_id) ?? "", status: run.status,
    when: run.executed_at ? stamp(run.executed_at) : `Previsto para el ${stamp(run.scheduled_for)}`, reason: run.result?.reason }));
  const showDetail = (id: string) => { const run = runs.find((item) => item.id === id); if (!run) return; setSelected(run); setSelectedPatientName(patientNames.get(run.patient_id) ?? ""); };

  return <CrmShell context={context} breadcrumb="Historial de actividad">
    <PageHeader title="Historial de actividad" description="Acá podés ver qué hizo Bellis automáticamente y si algo necesita tu atención."><Link className="crm-btn" href="/automatizaciones"><ArrowLeft size={15}/> Automatizaciones</Link></PageHeader>
    {error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}
    <KpiStrip items={[
      { label: "Actividad de hoy", value: summary.today, icon: ListChecks, tone: "petrol" },
      { label: "Hechas hoy", value: summary.completed, icon: Check, tone: "sage" },
      { label: "No fue necesario", value: summary.skipped, icon: Minus, tone: "neutral" },
      { label: "Para revisar", value: summary.failed, icon: CircleAlert, tone: summary.failed > 0 ? "coral" : "neutral" },
      { label: "Pendientes", value: summary.pending, icon: Clock3, tone: "orange" },
    ]}/>
    <section className="crm-card"><div className="crm-filterbar"><label className="crm-select">Estado<select value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setPage(0); }}><option value="all">Todas</option>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="crm-select">Automatización<select value={ruleId} onChange={(event) => { setRuleId(event.target.value); setPage(0); }}><option value="all">Todas</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label><label className="crm-select">Fecha<select value={period} onChange={(event) => { setPeriod(event.target.value as Period); setPage(0); }}><option value="today">Hoy</option><option value="7d">Últimos 7 días</option><option value="30d">Últimos 30 días</option><option value="custom">Personalizado</option></select></label>{period === "custom" && <><label className="crm-select">Desde<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(0); }}/></label><label className="crm-select">Hasta<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(0); }}/></label></>}</div>
      <p className="crm-hint">Las fechas usan la zona horaria de tu espacio.</p>
      {loading ? <p className="live-empty" role="status">Cargando actividad…</p> : runs.length ? <ActivityList rows={rows} onDetail={showDetail}/> : <p className="live-empty">{status === "all" && ruleId === "all" ? "Todavía no hay actividad automática para mostrar." : "No hay actividad con estos filtros."}</p>}
      {!loading && total > pageSize && <div className="auto-pagination"><button className="crm-btn" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize,total)} de {total}</span><button className="crm-btn" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((value) => value + 1)}>Siguiente</button></div>}
    </section>
    {selected && <ActivityDetail id={`ejecucion-${selected.id}`} status={selected.status} patient={selectedPatientName || patientNames.get(selected.patient_id) || ""} rule={ruleNames.get(selected.automation_rule_id)} ruleEnabled={selectedRule?.enabled} reason={selected.result?.reason} onClose={() => setSelected(null)} facts={[
        { label: "Estado", value: <RunStatusTag status={selected.status}/> },
        { label: "Automatización", value: ruleNames.get(selected.automation_rule_id) ?? "—" },
        { label: "Prevista para", value: stamp(selected.scheduled_for) },
        { label: "Realizada", value: stamp(selected.executed_at) },
        { label: "Qué hace", value: "Crear seguimiento" },
        { label: "Intentos", value: selected.attempt_count },
      ]}>
      {selected.status === "failed" && selectedRule?.enabled && <button className="demo-primary" disabled={saving} onClick={() => void retry(selected)}>Intentar de nuevo</button>}
      {selected.follow_up_id && <Link className="crm-btn" href={`/pacientes/${selected.patient_id}#seguimiento-${selected.follow_up_id}`}>Ver seguimiento <ArrowRight size={15}/></Link>}
      <Link className="crm-btn" href={`/pacientes/${selected.patient_id}`}>Ver paciente <ArrowRight size={15}/></Link>
    </ActivityDetail>}
  </CrmShell>;
}
