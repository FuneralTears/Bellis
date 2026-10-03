"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock3, Settings2, ShieldCheck } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../pacientes/CrmShell";
import { crmDate, errorMessage, loadCrmContext, type CrmContext } from "../pacientes/crm";
import { priorityLabels } from "../pacientes/timeline";
import "./automations.css";

type Rule = { id: string; workspace_id: string; rule_key: "first_consultation" | "inactive_patient" | "pending_payment"; name: string; description: string; trigger_type: string; condition_type: string; action_title: string; action_priority: "low" | "medium" | "high"; delay_minutes: number; enabled: boolean; enabled_at: string | null; updated_at: string };
type Run = { id: string; automation_rule_id: string; patient_id: string; triggered_at: string; scheduled_for: string; executed_at: string | null; status: "scheduled" | "processing" | "completed" | "failed" | "cancelled" | "skipped"; result: { reason?: string; follow_up_id?: string }; attempt_count: number; follow_up_id: string | null };
type Patient = { id: string; first_name: string; last_name: string };
const descriptions: Record<Rule["rule_key"], { trigger: string; condition: string; unit: "días" | "horas"; factor: number }> = {
  first_consultation: { trigger: "Se completa la primera consulta", condition: "No hay próximo turno y sigue siendo la única consulta completada", unit: "días", factor: 1440 },
  inactive_patient: { trigger: "Se completa un turno", condition: "Pasa el plazo sin otro turno completado ni uno próximo", unit: "días", factor: 1440 },
  pending_payment: { trigger: "Se registra un pago pendiente", condition: "El pago y la reserva siguen pendientes", unit: "horas", factor: 60 }
};
const runLabels: Record<Run["status"], string> = { scheduled: "Programada", processing: "En proceso", completed: "Seguimiento creado", failed: "Error", cancelled: "Cancelada", skipped: "Omitida" };

export default function AutomationsPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Rule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [failedCount, setFailedCount] = useState(0);

  useEffect(() => { let cancelled = false;
    async function load() {
      try {
        const nextContext = await loadCrmContext();
        const client = await getSupabase();
        const { data: auth } = await client.auth.getUser();
        const [ruleRows, membership, failures] = await Promise.all([
          client.from("automation_rules").select("*").eq("workspace_id", nextContext.workspaceId).order("created_at"),
          client.from("workspace_members").select("role").eq("workspace_id", nextContext.workspaceId).eq("user_id", auth.user?.id ?? "").maybeSingle(),
          client.from("automation_runs").select("id", { count: "exact", head: true }).eq("workspace_id", nextContext.workspaceId).eq("status", "failed")
        ]);
        if (ruleRows.error) throw ruleRows.error;
        if (failures.error) throw failures.error;
        if (!cancelled) { setContext(nextContext); setRules(ruleRows.data as Rule[] ?? []); setCanEdit(["owner", "admin"].includes(membership.data?.role ?? "")); setFailedCount(failures.count ?? 0); }
      } catch (caught) {
        const message = errorMessage(caught);
        if (message === "onboarding_required") window.location.replace("/onboarding");
        else if (message.includes("sesión")) window.location.replace("/ingresar");
        else if (!cancelled) setError(message);
      } finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (!context || !selectedId) return; let cancelled = false;
    async function loadHistory() { try {
      const client = await getSupabase();
      const { data, error: historyError } = await client.from("automation_runs")
        .select("id,automation_rule_id,patient_id,triggered_at,scheduled_for,executed_at,status,result,attempt_count,follow_up_id")
        .eq("workspace_id", context!.workspaceId).eq("automation_rule_id", selectedId).order("created_at", { ascending: false }).limit(50);
      if (historyError) throw historyError;
      const rows = (data ?? []) as Run[];
      const ids = [...new Set(rows.map((run) => run.patient_id))];
      const people = ids.length ? await client.from("patients").select("id,first_name,last_name").eq("workspace_id", context!.workspaceId).in("id", ids) : { data: [], error: null };
      if (people.error) throw people.error;
      if (!cancelled) { setRuns(rows); setPatients((people.data ?? []) as Patient[]); }
    } catch (caught) { if (!cancelled) setError(errorMessage(caught)); } }
    void loadHistory(); return () => { cancelled = true; };
  }, [context, selectedId]);

  const selected = rules.find((rule) => rule.id === selectedId) ?? null;
  const nameById = useMemo(() => new Map(patients.map((patient) => [patient.id, `${patient.first_name} ${patient.last_name}`])), [patients]);
  const history = runs.filter((run) => run.automation_rule_id === selectedId).slice(0, 50);

  async function save(rule: Rule, patch: Partial<Rule>) {
    if (!context || !canEdit) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const client = await getSupabase();
      const { data, error: saveError } = await client.from("automation_rules").update(patch)
        .eq("workspace_id", context.workspaceId).eq("id", rule.id).select("*").single();
      if (saveError || !data) throw saveError ?? new Error("No se pudo guardar la automatización.");
      setRules((items) => items.map((item) => item.id === rule.id ? data as Rule : item));
      setDraft(null); setNotice("Automatización actualizada.");
    } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }

  return <CrmShell context={context} breadcrumb="Automatizaciones">
    <div className="demo-title-row"><div><p className="demo-date">SEGUIMIENTO INTERNO</p><h1>Automatizaciones</h1><p>Bellis crea tareas de seguimiento cuando se cumplen tus reglas.</p></div></div>
    <p className="crm-hint automation-intro">Las reglas empiezan desactivadas. No envían mensajes ni toman decisiones clínicas. Al activarlas, se consideran los eventos nuevos desde ese momento.</p>
    {error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}
    {failedCount > 0 && <div className="demo-panel automation-alert"><strong>⚠ Hay {failedCount} {failedCount === 1 ? "ejecución que requiere" : "ejecuciones que requieren"} revisión.</strong><Link href="/automatizaciones/ejecuciones?status=failed">Ver ejecuciones <ArrowRight size={15}/></Link></div>}
    <Link className="crm-dashboard-link" href="/automatizaciones/ejecuciones">Ver todas las ejecuciones <ArrowRight size={15}/></Link>
    {loading ? <p className="live-empty" role="status">Cargando automatizaciones…</p> : <>
      <div className="automation-cards">{rules.map((rule) => { const info = descriptions[rule.rule_key]; return <article className="demo-panel automation-card" key={rule.id}>
        <div className="automation-card-heading"><div><h2>{rule.name}</h2><p>{rule.description}</p></div><span className={rule.enabled ? "automation-state enabled" : "automation-state"}>{rule.enabled ? "Activa" : "Desactivada"}</span></div>
        <div className="automation-steps"><span><Clock3 size={16}/> Esperar {rule.delay_minutes / info.factor} {info.unit}</span><span><Settings2 size={16}/> Crear seguimiento · {priorityLabels[rule.action_priority]}</span></div>
        <div className="automation-actions"><button className="live-secondary" onClick={() => { setSelectedId(rule.id); setDraft(null); }}>Ver detalle</button>{canEdit && <><button className="live-secondary" onClick={() => { setSelectedId(rule.id); setDraft({ ...rule }); }}>Configurar</button><button className="demo-primary" disabled={saving} onClick={() => void save(rule, { enabled: !rule.enabled })}>{rule.enabled ? "Desactivar" : "Activar"}</button></>}</div>
      </article>; })}</div>
      {!canEdit && <p className="crm-hint automation-permission"><ShieldCheck size={15}/> Solo quienes administran este espacio pueden cambiar las reglas.</p>}
      {selected && <section className="demo-panel automation-detail"><div className="crm-section-head"><div><h2>{selected.name}</h2><p className="crm-hint">{selected.enabled ? "Activa" : "Desactivada"} · Última actualización: {context ? crmDate(selected.updated_at, context.market) : "—"}</p></div><button className="live-secondary" onClick={() => { setSelectedId(null); setDraft(null); }}>Cerrar</button></div>
        <div className="automation-definition"><div><small>SE ACTIVA CUANDO</small><strong>{descriptions[selected.rule_key].trigger}</strong></div><div><small>CONDICIÓN</small><strong>{descriptions[selected.rule_key].condition}</strong></div><div><small>ESPERA</small><strong>{selected.delay_minutes / descriptions[selected.rule_key].factor} {descriptions[selected.rule_key].unit}</strong></div><div><small>ACCIÓN</small><strong>{selected.action_title} · prioridad {priorityLabels[selected.action_priority].toLowerCase()}</strong></div></div>
        {draft && canEdit && <form className="automation-form" onSubmit={(event) => { event.preventDefault(); const unit = Number((event.currentTarget.elements.namedItem("delay") as HTMLInputElement).value); if (!Number.isInteger(unit) || unit < 1 || unit * descriptions[draft.rule_key].factor > 525600) { setError("Ingresá un plazo válido."); return; } void save(draft, { name: draft.name.trim(), description: draft.description.trim(), action_title: draft.action_title.trim(), action_priority: draft.action_priority, delay_minutes: unit * descriptions[draft.rule_key].factor }); }}>
          <label>Nombre<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
          <label>Descripción<textarea maxLength={500} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })}/></label>
          <label>Esperar ({descriptions[draft.rule_key].unit})<input name="delay" type="number" required min={1} max={Math.floor(525600 / descriptions[draft.rule_key].factor)} defaultValue={draft.delay_minutes / descriptions[draft.rule_key].factor}/></label>
          <label>Título del seguimiento<input required maxLength={160} value={draft.action_title} onChange={(event) => setDraft({ ...draft, action_title: event.target.value })}/></label>
          <label>Prioridad<select value={draft.action_priority} onChange={(event) => setDraft({ ...draft, action_priority: event.target.value as Rule["action_priority"] })}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className="automation-actions"><button className="demo-primary" disabled={saving}>Guardar cambios</button><button type="button" className="live-secondary" onClick={() => setDraft(null)}>Cancelar</button></div>
          <p className="crm-hint">El nuevo plazo se aplicará a los eventos futuros. Las tareas ya programadas conservan su fecha.</p>
        </form>}
        <h3>Historial de ejecuciones</h3>{history.length ? <div className="automation-history">{history.map((run) => <div key={run.id}><span>{context ? crmDate(run.executed_at ?? run.scheduled_for, context.market) : "—"}</span><div><strong>{nameById.get(run.patient_id) ?? "Paciente no disponible"}</strong><small>{runLabels[run.status]}{run.result?.reason ? ` · ${run.result.reason}` : ""}</small></div><Link href={`/automatizaciones/ejecuciones?run=${run.id}`}>Ver detalle <ArrowRight size={14}/></Link></div>)}</div> : <p className="live-empty">Todavía no hay ejecuciones para esta regla.</p>}
      </section>}
    </>}
  </CrmShell>;
}
