"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../../pacientes/CrmShell";
import { crmDate, errorMessage, loadCrmContext, type CrmContext } from "../../pacientes/crm";
import { dateBounds } from "./dateRange";
import "./runs.css";

type Status = "scheduled" | "processing" | "completed" | "failed" | "cancelled" | "skipped";
type StatusFilter = "all" | Status;
type Period = "today" | "7d" | "30d" | "custom";
type Run = { id: string; workspace_id: string; automation_rule_id: string; patient_id: string; professional_id: string; triggered_at: string; scheduled_for: string; executed_at: string | null; created_at: string; status: Status; action_type: string; result: { reason?: string; follow_up_id?: string }; attempt_count: number; follow_up_id: string | null };
type Rule = { id: string; name: string; enabled: boolean };
type Patient = { id: string; first_name: string; last_name: string };
const labels: Record<Status,string> = { scheduled: "Programada", processing: "Procesando", completed: "Completada", failed: "Fallida", cancelled: "Cancelada", skipped: "Omitida" };
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

  const ruleNames = useMemo(() => new Map(rules.map((rule) => [rule.id, rule.name])), [rules]);
  const patientNames = useMemo(() => new Map(patients.map((patient) => [patient.id, `${patient.first_name} ${patient.last_name}`])), [patients]);
  const selectedRule = selected ? rules.find((rule) => rule.id === selected.automation_rule_id) : null;

  async function retry(run: Run) { setSaving(true); setError(""); setNotice(""); try {
    const client = await getSupabase();
    const { error: retryError } = await client.rpc("retry_failed_automation_run", { p_run: run.id });
    if (retryError) throw new Error("No se puede reintentar esta ejecución. Revisá la regla y los permisos.");
    setSelected({ ...run, status: "scheduled", attempt_count: 0, executed_at: null, scheduled_for: new Date().toISOString() });
    setRevision((value) => value + 1); setNotice("Reintento programado para el próximo ciclo.");
  } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); } }

  return <CrmShell context={context} breadcrumb="Ejecuciones">
    <div className="demo-title-row"><div><p className="demo-date">MONITOREO</p><h1>Ejecuciones</h1><p>Revisá qué hizo Bellis y qué quedó pendiente.</p></div><Link className="live-secondary" href="/automatizaciones"><ArrowLeft size={16}/> Reglas</Link></div>
    {error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}
    <div className="run-metrics">{[["Procesadas hoy",summary.today],["Completadas hoy",summary.completed],["Omitidas hoy",summary.skipped],["Fallidas hoy",summary.failed],["Pendientes",summary.pending]].map(([label,value]) => <div className="demo-panel" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <section className="demo-panel run-panel"><div className="run-filters"><label>Estado<select value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setPage(0); }}><option value="all">Todas</option>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Automatización<select value={ruleId} onChange={(event) => { setRuleId(event.target.value); setPage(0); }}><option value="all">Todas</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label><label>Fecha<select value={period} onChange={(event) => { setPeriod(event.target.value as Period); setPage(0); }}><option value="today">Hoy</option><option value="7d">Últimos 7 días</option><option value="30d">Últimos 30 días</option><option value="custom">Personalizado</option></select></label>{period === "custom" && <><label>Desde<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(0); }}/></label><label>Hasta<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(0); }}/></label></>}</div>
      <p className="crm-hint">El período filtra por fecha de registro, según la zona horaria de tu espacio.</p>
      {loading ? <p className="live-empty" role="status">Cargando ejecuciones…</p> : runs.length ? <><div className="run-table-wrap"><table className="crm-table"><thead><tr><th>Fecha</th><th>Automatización</th><th>Paciente</th><th>Estado</th><th>Programada</th><th>Ejecutada</th><th>Resultado</th><th/></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{context ? crmDate(run.created_at, context.market) : "—"}</td><td>{ruleNames.get(run.automation_rule_id) ?? "Regla"}</td><td>{patientNames.get(run.patient_id) ?? "Paciente"}</td><td><span className={`run-status run-${run.status}`}>{labels[run.status]}</span></td><td>{context ? crmDate(run.scheduled_for, context.market) : "—"}</td><td>{context ? crmDate(run.executed_at, context.market) : "—"}</td><td>{run.status === "failed" ? "Requiere revisión" : run.status === "skipped" ? run.result?.reason ?? "Condición no vigente" : run.follow_up_id ? "Seguimiento creado" : "—"}</td><td><button className="run-detail-button" onClick={() => { setSelected(run); setSelectedPatientName(patientNames.get(run.patient_id) ?? ""); }}>Ver detalle</button></td></tr>)}</tbody></table></div><div className="run-mobile-list">{runs.map((run) => <button type="button" className="run-mobile-card" key={run.id} onClick={() => { setSelected(run); setSelectedPatientName(patientNames.get(run.patient_id) ?? ""); }}><strong>{ruleNames.get(run.automation_rule_id) ?? "Regla"}</strong><span>{patientNames.get(run.patient_id) ?? "Paciente"} · {labels[run.status]}</span><small>{context ? crmDate(run.created_at, context.market) : ""}</small><span>Ver detalle <ArrowRight size={14}/></span></button>)}</div></> : <p className="live-empty">No hay ejecuciones con estos filtros.</p>}
      {!loading && total > pageSize && <div className="run-pagination"><button className="live-secondary" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize,total)} de {total}</span><button className="live-secondary" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((value) => value + 1)}>Siguiente</button></div>}
    </section>
    {selected && <section id={`ejecucion-${selected.id}`} className="demo-panel run-detail"><div className="crm-section-head"><div><h2>Detalle de ejecución</h2><p className="crm-hint">{ruleNames.get(selected.automation_rule_id) ?? "Automatización"}</p></div><button className="live-secondary" onClick={() => setSelected(null)}>Cerrar</button></div><dl><div><dt>Paciente</dt><dd><Link href={`/pacientes/${selected.patient_id}`}>{selectedPatientName || patientNames.get(selected.patient_id) || "Ver paciente"}</Link></dd></div><div><dt>Estado</dt><dd>{labels[selected.status]}</dd></div><div><dt>Programada</dt><dd>{context ? crmDate(selected.scheduled_for, context.market) : "—"}</dd></div><div><dt>Ejecutada</dt><dd>{context ? crmDate(selected.executed_at, context.market) : "—"}</dd></div><div><dt>Acción</dt><dd>Crear seguimiento</dd></div><div><dt>Resultado</dt><dd>{selected.status === "failed" ? "No se pudo crear el seguimiento. La ejecución quedó registrada para revisión." : selected.status === "skipped" ? selected.result?.reason ?? "La condición dejó de cumplirse." : selected.follow_up_id ? "Seguimiento creado correctamente." : "Pendiente de ejecución."}</dd></div><div><dt>Intentos</dt><dd>{selected.attempt_count}</dd></div></dl>{selected.follow_up_id && <Link className="crm-dashboard-link" href={`/pacientes/${selected.patient_id}#seguimiento-${selected.follow_up_id}`}>Ver seguimiento <ArrowRight size={15}/></Link>}{selected.status === "failed" && selectedRule?.enabled && <button className="demo-primary" disabled={saving} onClick={() => void retry(selected)}>Reintentar ejecución</button>}</section>}
  </CrmShell>;
}
