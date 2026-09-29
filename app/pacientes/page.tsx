"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "./CrmShell";
import { crmDate, errorMessage, loadCrmContext, statusLabels, type CrmContext, type PatientOverview, type PatientStatus } from "./crm";
import { followUpBucket, followUpLabels, todayInTimezone } from "./timeline";

const PAGE_SIZE = 25;
type Sort = "last_turn" | "next_turn" | "full_name";
type FollowUpFilter = "all" | "with" | "without" | "overdue" | "today";

export default function PatientsPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  const [patients, setPatients] = useState<PatientOverview[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PatientStatus | "all">("all");
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpFilter>("all");
  const [sort, setSort] = useState<Sort>("last_turn");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { loadCrmContext().then(setContext).catch((caught) => {
    if (errorMessage(caught) === "onboarding_required") window.location.replace("/onboarding");
    else if (errorMessage(caught).includes("sesión")) window.location.replace("/ingresar");
    else { setError(errorMessage(caught)); setLoading(false); }
  }); }, []);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setPage(0); }, 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { if (!context) return; let cancelled = false;
    async function load() {
      setLoading(true); setError("");
      try {
        const client = await getSupabase();
        let request = client.from("patient_crm_overview").select("*", { count: "exact" }).eq("workspace_id", context!.workspaceId);
        if (status !== "all") request = request.eq("status", status);
        const today = todayInTimezone(context!.market.timezone);
        if (followUpFilter === "with") request = request.not("follow_up_due_date", "is", null);
        if (followUpFilter === "without") request = request.is("follow_up_due_date", null);
        if (followUpFilter === "overdue") request = request.lt("follow_up_due_date", today);
        if (followUpFilter === "today") request = request.eq("follow_up_due_date", today);
        if (search) {
          // PostgREST's OR filter has punctuation delimiters; remove those while retaining phone/email characters.
          const safe = search.replace(/[(),%*]/g, " ").trim();
          if (safe) request = request.or(`full_name.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`);
        }
        request = request.order(sort, { ascending: sort !== "last_turn", nullsFirst: false }).order("id").range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        const { data, count, error: queryError } = await request;
        if (queryError) throw queryError;
        if (!cancelled) { setPatients((data ?? []) as PatientOverview[]); setTotal(count ?? 0); }
      } catch (caught) { if (!cancelled) setError(errorMessage(caught)); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; };
  }, [context, search, status, followUpFilter, sort, page, reload]);

  const today = context ? todayInTimezone(context.market.timezone) : "";
  return <CrmShell context={context}><div className="demo-title-row"><div><p className="demo-date">ESPACIO PROFESIONAL · ARGENTINA</p><h1>Pacientes</h1><p>Información, turnos y seguimiento en un solo lugar.</p></div><Link className="demo-primary" href="/seguimientos">Ver seguimientos <ArrowRight size={16}/></Link></div><section className="demo-panel crm-list-panel"><div className="crm-toolbar"><label className="crm-search"><Search size={18}/><input aria-label="Buscar pacientes" placeholder="Buscar por nombre, email o teléfono" value={query} onChange={(event) => setQuery(event.target.value)}/></label><label className="crm-sort">Ordenar por <select value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(0); }}><option value="last_turn">Último turno</option><option value="next_turn">Próximo turno</option><option value="full_name">Nombre</option></select></label></div><div className="crm-filters" aria-label="Filtrar pacientes por estado">{([ ["all","Todos"], ["new","Nuevos"], ["active","Activos"], ["follow_up","Seguimiento"], ["inactive","Inactivos"] ] as const).map(([value,label]) => <button key={value} className={status === value ? "on" : ""} onClick={() => { setStatus(value); setPage(0); }}>{label}</button>)}</div><div className="crm-filters crm-follow-up-filters" aria-label="Filtrar pacientes por seguimiento">{([ ["all","Todos"], ["with","Con seguimiento"], ["without","Sin seguimiento"], ["overdue","Vencidos"], ["today","Hoy"] ] as const).map(([value,label]) => <button key={value} className={followUpFilter === value ? "on" : ""} onClick={() => { setFollowUpFilter(value); setPage(0); }}>{label}</button>)}</div>{error && <p className="live-error" role="alert">{error} <button onClick={() => setReload((value) => value + 1)} aria-label="Reintentar">Reintentá la búsqueda</button></p>}{loading ? <p className="live-empty" role="status">Cargando pacientes…</p> : error ? null : patients.length === 0 ? <p className="live-empty">{search || status !== "all" || followUpFilter !== "all" ? "No encontramos pacientes con esos filtros." : "Todavía no tenés pacientes."}</p> : <><div className="crm-table-wrap"><table className="crm-table"><thead><tr><th>Paciente</th><th>Teléfono</th><th>Último turno</th><th>Próximo turno</th><th>Turnos</th><th>Estado</th><th>Seguimiento</th><th><span className="sr-only">Abrir</span></th></tr></thead><tbody>{patients.map((patient) => <tr key={patient.id}><td><Link className="crm-person" href={`/pacientes/${patient.id}`}><b>{patient.full_name}</b><small>{patient.email}</small></Link></td><td>{patient.phone || "—"}</td><td>{crmDate(patient.last_turn, context!.market)}</td><td>{crmDate(patient.next_turn, context!.market)}</td><td>{patient.turn_count}</td><td><span className={`crm-badge crm-${patient.status}`}>{statusLabels[patient.status]}</span></td><td><span className={`crm-follow-up-state crm-${followUpBucket(patient.follow_up_due_date,today)}`}>{followUpLabels[followUpBucket(patient.follow_up_due_date,today)]}</span></td><td><Link className="crm-open" href={`/pacientes/${patient.id}`} aria-label={`Ver ficha de ${patient.full_name}`}><ArrowRight size={17}/></Link></td></tr>)}</tbody></table></div><div className="crm-pagination"><span>{total} {total === 1 ? "paciente" : "pacientes"} · Página {page + 1} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span><div><button disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button><button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Siguiente</button></div></div></>}</section></CrmShell>;
}
