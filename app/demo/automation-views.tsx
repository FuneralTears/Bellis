"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bell, BellOff, Check, CheckCheck, CircleAlert, Clock3, History, ListChecks, Minus, Settings2, ShieldCheck } from "lucide-react";
import { KpiStrip, PageHeader } from "@/components/crm/CrmUi";
import { DetailList, NotificationItem, RuleRow, RunStatusTag, RunsTable, runStatusLabels } from "@/components/automation/AutomationUi";
import { Switch } from "@/components/ui/switch";
import { priorityLabels } from "../pacientes/timeline";
import type { DemoNotification, DemoRule } from "./showroom-data";
import type { useShowroom } from "./showroom";

type State = ReturnType<typeof useShowroom>;
type Navigate = (section: "Seguimientos" | "Automatizaciones" | "Notificaciones") => void;
/** Same destinations as production: a run notification opens that run, a follow-up one opens the tasks. */
function openNotification(state: State, navigate: Navigate, item: DemoNotification) {
  state.read(item.id);
  if (item.runId) { state.setAutomation({ view: "runs", runId: item.runId }); navigate("Automatizaciones"); }
  else navigate("Seguimientos");
}

/** Showroom mirror of NotificationBell: same dropdown, mock items, no polling. */
export function DemoBell({ state, navigate }: { state: State; navigate: Navigate }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const count = state.notifications.filter((item) => !item.read).length;
  useEffect(() => {
    if (!open) return;
    const click = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", click);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  return <div className="bell-wrap" ref={wrap}>
    <button ref={trigger} type="button" className="bell-button" aria-label={count ? `Notificaciones: ${count} sin leer` : "Notificaciones"} aria-expanded={open} aria-controls="demo-notifications-dropdown" onClick={() => setOpen(!open)}><Bell size={18}/>{count > 0 && <span className="bell-count">{count}</span>}</button>
    {open && <section id="demo-notifications-dropdown" className="bell-dropdown" aria-label="Notificaciones de la demo">
      <div className="bell-dropdown-head"><span><strong>Notificaciones</strong>{count > 0 && <small>{count} sin leer</small>}</span><button onClick={() => { setOpen(false); navigate("Notificaciones"); }}>Ver todas</button></div>
      {state.notifications.length ? <div className="bell-list">{state.notifications.slice(0, 5).map((item) => <NotificationItem compact key={item.id} kind={item.kind} title={item.title} message={item.message} time={item.time} unread={!item.read} onClick={() => { setOpen(false); openNotification(state, navigate, item); }}/>)}</div> : <p className="bell-empty">Todavía no hay notificaciones.</p>}
    </section>}
  </div>;
}

/** Showroom mirror of /automatizaciones and /automatizaciones/ejecuciones. Nothing runs for real. */
export function DemoAutomations({ state, patient }: { state: State; patient: (name: string) => void }) {
  const { view, runId } = state.automation;
  const setView = (next: "rules" | "runs") => state.setAutomation({ view: next, runId: null });
  const setRunId = (id: string | null) => state.setAutomation({ view: "runs", runId: id });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DemoRule | null>(null);
  const { runs, setRuns } = state;
  const [status, setStatus] = useState("all");
  const [ruleFilter, setRuleFilter] = useState("all");
  const [notice, setNotice] = useState("");
  useEffect(() => { if (runId && view === "runs") document.getElementById("demo-run-detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [runId, view]);
  const ruleName = (id: string) => state.rules.find((rule) => rule.id === id)?.name ?? "Regla";
  const failed = runs.filter((run) => run.status === "failed").length;

  if (view === "runs") {
    const visible = runs.filter((run) => (status === "all" || run.status === status) && (ruleFilter === "all" || run.ruleId === ruleFilter));
    const run = runs.find((item) => item.id === runId);
    const today = runs.filter((item) => item.executed.startsWith("03/10/2026"));
    return <>
      <PageHeader title="Ejecuciones" description="Revisá qué hizo Bellis y qué quedó pendiente."><button className="crm-btn" onClick={() => { setView("rules"); setNotice(""); }}><ArrowLeft size={15}/> Reglas</button></PageHeader>
      {notice && <p className="live-success" role="status">{notice}</p>}
      <KpiStrip items={[
        { label: "Procesadas hoy", value: today.length, icon: ListChecks, tone: "petrol" },
        { label: "Completadas hoy", value: today.filter((item) => item.status === "completed").length, icon: Check, tone: "sage" },
        { label: "Omitidas hoy", value: today.filter((item) => item.status === "skipped").length, icon: Minus, tone: "neutral" },
        { label: "Fallidas hoy", value: today.filter((item) => item.status === "failed").length, icon: CircleAlert, tone: today.some((item) => item.status === "failed") ? "coral" : "neutral" },
        { label: "Pendientes", value: runs.filter((item) => item.status === "scheduled" || item.status === "processing").length, icon: Clock3, tone: "orange" },
      ]}/>
      <section className="crm-card"><div className="crm-filterbar">
        <label className="crm-select">Estado<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todas</option>{Object.entries(runStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="crm-select">Automatización<select value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value)}><option value="all">Todas</option>{state.rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label>
        <label className="crm-select">Fecha<select defaultValue="30d"><option value="30d">Últimos 30 días</option></select></label>
      </div>
        <p className="crm-hint">Historial de ejemplo: en la demo no se ejecuta ninguna regla real.</p>
        {visible.length ? <RunsTable onDetail={setRunId} rows={visible.map((item) => ({ id: item.id, created: item.created, rule: ruleName(item.ruleId), patient: item.patient, status: item.status, scheduled: item.scheduled, executed: item.executed, result: item.result }))}/> : <p className="live-empty">No hay ejecuciones con estos filtros.</p>}
      </section>
      {run && <section id="demo-run-detail" className="crm-card"><div className="crm-card-head"><div><h2>Detalle de ejecución</h2><p>{ruleName(run.ruleId)}</p></div><button className="crm-btn" onClick={() => setRunId(null)}>Cerrar</button></div>
        <DetailList items={[
          { label: "Paciente", value: <button type="button" onClick={() => patient(run.patient)}>{run.patient}</button> },
          { label: "Estado", value: <RunStatusTag status={run.status}/> },
          { label: "Programada", value: run.scheduled },
          { label: "Ejecutada", value: run.executed },
          { label: "Acción", value: "Crear seguimiento" },
          { label: "Intentos", value: run.attempts },
          { label: "Resultado", value: run.detail },
        ]}/>
        {(run.status === "completed" || (run.status === "failed" && state.rules.find((rule) => rule.id === run.ruleId)?.enabled)) && <div className="auto-detail-foot">{run.status === "completed" && <button className="crm-link" onClick={() => patient(run.patient)}>Ver seguimiento <ArrowRight size={15}/></button>}{run.status === "failed" && <button className="demo-primary" onClick={() => { setRuns(runs.map((item) => item.id === run.id ? { ...item, status: "scheduled", attempts: 0, executed: "—", result: "—", detail: "Pendiente de ejecución." } : item)); setNotice("Reintento programado en la demo."); }}>Reintentar ejecución</button>}</div>}
      </section>}
    </>;
  }

  const active = state.rules.filter((rule) => rule.enabled).length;
  const selected = state.rules.find((rule) => rule.id === selectedId);
  const history = runs.filter((run) => run.ruleId === selectedId);
  return <>
    <PageHeader title="Automatizaciones" description="Bellis crea tareas de seguimiento cuando se cumplen tus reglas."><button className="crm-btn" onClick={() => { setView("runs"); setStatus("all"); setNotice(""); }}><History size={15}/> Ver ejecuciones</button></PageHeader>
    {notice && <p className="live-success" role="status">{notice}</p>}
    <KpiStrip items={[
      { label: "Reglas", value: state.rules.length, icon: Settings2, tone: "petrol" },
      { label: "Activas", value: active, icon: Check, tone: "sage" },
      { label: "Inactivas", value: state.rules.length - active, icon: Minus, tone: "neutral" },
      { label: "Requieren revisión", value: failed, icon: CircleAlert, tone: failed > 0 ? "coral" : "neutral" },
    ]}/>
    {failed > 0 && <div className="auto-alert"><CircleAlert size={16}/><strong>Hay {failed} {failed === 1 ? "ejecución que requiere" : "ejecuciones que requieren"} revisión.</strong><button className="crm-link" onClick={() => { setView("runs"); setStatus("failed"); }}>Ver ejecuciones <ArrowRight size={15}/></button></div>}
    <p className="auto-note"><ShieldCheck size={15}/> <span>Las reglas empiezan desactivadas. No envían mensajes ni toman decisiones clínicas. En la demo, los cambios duran durante la visita.</span></p>
    <div className="auto-rules">{state.rules.map((rule) => <RuleRow key={rule.id} kind={rule.kind} name={rule.name} description={rule.description} enabled={rule.enabled} wait={`${rule.delay} ${rule.unit}`} action={`Crear seguimiento · prioridad ${priorityLabels[rule.priority].toLowerCase()}`}
      toggle={<Switch checked={rule.enabled} aria-label={`${rule.enabled ? "Desactivar" : "Activar"} ${rule.name}`} onCheckedChange={(enabled) => state.toggle(rule.id, enabled)}/>}>
      <button className="crm-link" onClick={() => { setSelectedId(rule.id); setDraft(null); }}>Ver detalle</button><button className="crm-link" onClick={() => { setSelectedId(rule.id); setDraft({ ...rule }); }}>Configurar</button>
    </RuleRow>)}</div>
    {selected && <section className="crm-card" style={{ marginTop: 12 }}><div className="crm-card-head"><div><h2>{selected.name}</h2><p>{selected.enabled ? "Activa" : "Inactiva"} · Regla de ejemplo</p></div><button className="crm-btn" onClick={() => { setSelectedId(null); setDraft(null); }}>Cerrar</button></div>
      <DetailList columns={4} items={[
        { label: "Se activa cuando", value: selected.trigger },
        { label: "Condición", value: selected.condition },
        { label: "Espera", value: `${selected.delay} ${selected.unit}` },
        { label: "Acción", value: `${selected.action} · prioridad ${priorityLabels[selected.priority].toLowerCase()}` },
      ]}/>
      {draft && <form className="auto-form" onSubmit={(event) => { event.preventDefault(); state.configure(draft); setDraft(null); setNotice("Configuración actualizada en la demo."); }}>
        <div className="crm-form-grid">
          <label>Nombre<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
          <label>Esperar ({draft.unit})<input type="number" required min={1} max={365} value={draft.delay} onChange={(event) => setDraft({ ...draft, delay: Number(event.target.value) })}/></label>
          <label className="crm-wide">Descripción<textarea maxLength={500} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })}/></label>
          <label>Título del seguimiento<input required maxLength={160} value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })}/></label>
          <label>Prioridad<select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as DemoRule["priority"] })}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <div className="crm-note-actions"><button className="demo-primary">Guardar en la demo</button><button type="button" className="live-secondary" onClick={() => setDraft(null)}>Cancelar</button></div>
      </form>}
      <h3 className="auto-subtitle">Historial de ejecuciones</h3>{history.length ? <div className="auto-history">{history.map((run) => <div key={run.id}><time>{run.executed === "—" ? run.scheduled : run.executed}</time><strong>{run.patient}{run.status === "skipped" && <small>{run.result}</small>}</strong><RunStatusTag status={run.status}/><button className="crm-link" onClick={() => { setStatus("all"); setRuleFilter("all"); setRunId(run.id); }}>Ver detalle <ArrowRight size={14}/></button></div>)}</div> : <p className="live-empty">Todavía no hay ejecuciones para esta regla.</p>}
    </section>}
  </>;
}

/** Showroom mirror of /notificaciones. */
export function DemoNotifications({ state, navigate }: { state: State; navigate: Navigate }) {
  const [filter, setFilter] = useState("all");
  const unread = state.notifications.filter((item) => !item.read).length;
  const visible = state.notifications.filter((item) => filter === "all" || (filter === "read" ? item.read : !item.read));
  return <>
    <PageHeader title="Notificaciones" description={unread ? `${unread} sin leer · Acciones de seguimiento que Bellis registró para vos.` : "Acciones de seguimiento que Bellis registró para vos."}/>
    <div className="notif-head"><div className="crm-chips" role="group" aria-label="Filtrar notificaciones">{[["all", "Todas"], ["unread", `No leídas${unread ? ` (${unread})` : ""}`], ["read", "Leídas"]].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} className={filter === value ? "on" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div><button className="crm-btn" disabled={!unread} onClick={() => state.read()}><CheckCheck size={15}/> Marcar todas como leídas</button></div>
    {visible.length ? <div className="notif-list">{visible.map((item) => <NotificationItem key={item.id} kind={item.kind} title={item.title} message={item.message} time={item.time} unread={!item.read} onClick={() => openNotification(state, navigate, item)}/>)}</div> : <div className="notif-empty"><BellOff size={22}/><strong>Sin notificaciones</strong><p>No hay notificaciones con este filtro.</p></div>}
  </>;
}
