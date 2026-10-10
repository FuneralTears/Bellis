"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus, Search } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "./CrmShell";
import { crmDate, errorMessage, loadCrmContext, statusLabels, type CrmContext, type PatientStatus } from "./crm";
import { todayInTimezone } from "./timeline";
import { opportunityFilters, type OpportunityKind, type OpportunityOverview } from "./opportunities";
import { PageHeader, PatientsTable } from "@/components/crm/CrmUi";
import { NewPatientForm, type NewPatientValues } from "@/components/crm/NewPatientForm";
import { phoneKey, type DuplicateCandidate } from "@/lib/patient-duplicates";

const PAGE_SIZE = 25;
type Sort = "last_turn" | "next_turn" | "full_name";
type FollowUpFilter = "all" | "with" | "without" | "overdue" | "today";
type OpportunityFilter = OpportunityKind | "all" | "attention";

export default function PatientsPage() {
  const router = useRouter();
  const [context, setContext] = useState<CrmContext | null>(null);
  const [patients, setPatients] = useState<OpportunityOverview[]>([]);
  const [automaticPatients, setAutomaticPatients] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PatientStatus | "all">("all");
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpFilter>("all");
  const [opportunityFilter, setOpportunityFilter] = useState<OpportunityFilter>("all");
  const [sort, setSort] = useState<Sort>("last_turn");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

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
        let request = client.from("patient_follow_up_opportunities").select("*", { count: "exact" }).eq("workspace_id", context!.workspaceId);
        if (status !== "all") request = request.eq("status", status);
        if (opportunityFilter !== "all" && opportunityFilter !== "attention") {
          const column = opportunityFilters.find((item) => item.kind === opportunityFilter)?.column;
          if (column) request = request.eq(column, true);
        }
        const today = todayInTimezone(context!.market.timezone);
        if (followUpFilter === "with") request = request.not("follow_up_due_date", "is", null);
        if (followUpFilter === "without") request = request.is("follow_up_due_date", null);
        if (followUpFilter === "overdue") request = request.lt("follow_up_due_date", today);
        if (followUpFilter === "today") request = request.eq("follow_up_due_date", today);
        if (opportunityFilter === "attention") request = request.or("has_pending_payment.eq.true,has_overdue_follow_up.eq.true,without_next_turn.eq.true");
        const safe = search.replace(/[(),%*]/g, " ").trim();
        if (safe) request = request.or(`full_name.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`);
        request = request.order(sort, { ascending: sort !== "last_turn", nullsFirst: false }).order("id").range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        const { data, count, error: queryError } = await request;
        if (queryError) throw queryError;
        const ids = (data ?? []).map((patient) => patient.id);
        const automatic = ids.length ? await client.from("patient_follow_ups").select("patient_id")
          .eq("workspace_id", context!.workspaceId).eq("status", "pending").eq("source", "automation").in("patient_id", ids) : { data: [], error: null };
        if (automatic.error) throw automatic.error;
        if (!cancelled) { setPatients((data ?? []) as OpportunityOverview[]); setTotal(count ?? 0); setAutomaticPatients(new Set((automatic.data ?? []).map((row) => row.patient_id))); }
      } catch (caught) { if (!cancelled) setError(errorMessage(caught)); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; };
  }, [context, search, status, followUpFilter, opportunityFilter, sort, page, reload]);

  // Patients of this workspace that share the phone or the email. Two plain filters: nothing typed reaches a filter string.
  async function lookupDuplicates(phone: string, email: string | null): Promise<DuplicateCandidate[]> {
    const client = await getSupabase();
    const columns = "id,first_name,last_name,phone,email,created_at";
    const base = () => client.from("patients").select(columns).eq("workspace_id", context!.workspaceId).is("deleted_at", null).order("created_at", { ascending: false }).limit(50);
    const key = phoneKey(phone);
    const [byPhone, byEmail] = await Promise.all([key ? base().like("phone", `%${key}`) : null, email ? base().eq("email", email) : null]);
    if (byPhone?.error || byEmail?.error) throw new Error("No pudimos revisar si el paciente ya existe. Intentá de nuevo.");
    return [...(byPhone?.data ?? []), ...(byEmail?.data ?? [])].map((row) => ({ id: row.id, full_name: `${row.first_name} ${row.last_name}`, phone: row.phone, email: row.email, created_at: row.created_at }));
  }
  async function createPatient(values: NewPatientValues) {
    const client = await getSupabase();
    const { data, error: saveError } = await client.rpc("create_manual_patient", { p_workspace: context!.workspaceId, p_first_name: values.firstName, p_last_name: values.lastName, p_phone: values.phone, p_email: values.email, p_note: values.note });
    if (saveError || !data) {
      const code = saveError?.message ?? "";
      throw new Error(code.includes("patient_already_exists") ? "Ya existe una ficha con este mismo teléfono y email. Buscala en la lista de pacientes."
        : code.includes("not_authorized") ? "No tenés permiso para cargar pacientes en este espacio."
        : code.includes("invalid_patient") ? "Revisá el nombre, el apellido, el teléfono y el email."
        : code.includes("invalid_note") ? "La nota es demasiado larga." : "No pudimos guardar el paciente. Intentá de nuevo.");
    }
    router.push(`/pacientes/${data}`);
  }

  const today = context ? todayInTimezone(context.market.timezone) : "";
  const filtered = Boolean(search) || status !== "all" || followUpFilter !== "all" || opportunityFilter !== "all";
  return <CrmShell context={context}>
    <PageHeader title="Pacientes" description="Información, turnos y seguimiento en un solo lugar."><Link className="crm-btn" href="/seguimientos">Ver seguimientos <ArrowRight size={16}/></Link><button className="demo-primary" type="button" disabled={!context || creating} onClick={() => setCreating(true)}><Plus size={16}/> Nuevo paciente</button></PageHeader>
    {creating && context && <NewPatientForm lookup={lookupDuplicates} onSave={createPatient} onCancel={() => setCreating(false)}
      renderOpen={(patient, content, variant) => <Link className={variant === "primary" ? "demo-primary" : "crm-link"} href={`/pacientes/${patient.id}`}>{content}</Link>}/>}
    <section className="crm-card">
      <div className="crm-filterbar">
        <label className="crm-search"><Search size={16}/><input aria-label="Buscar pacientes" placeholder="Buscar por nombre, email o teléfono" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
        <label className="crm-select">Para revisar <select aria-label="Filtrar por sugerencia de seguimiento" value={opportunityFilter} onChange={(event) => { setOpportunityFilter(event.target.value as OpportunityFilter); setPage(0); }}>{opportunityFilters.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label>
        <label className="crm-select">Ordenar por <select value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(0); }}><option value="last_turn">Último turno</option><option value="next_turn">Próximo turno</option><option value="full_name">Nombre</option></select></label>
      </div>
      <div className="crm-chip-rows">
        <div className="crm-chip-row"><span id="crm-filter-status">Estado</span><div className="crm-chips" role="group" aria-labelledby="crm-filter-status">{([ ["all","Todos"], ["new","Nuevos"], ["active","Activos"], ["follow_up","Seguimiento"], ["inactive","Inactivos"] ] as const).map(([value,label]) => <button key={value} aria-pressed={status === value} className={status === value ? "on" : ""} onClick={() => { setStatus(value); setPage(0); }}>{label}</button>)}</div></div>
        <div className="crm-chip-row"><span id="crm-filter-follow-up">Seguimiento</span><div className="crm-chips" role="group" aria-labelledby="crm-filter-follow-up">{([ ["all","Todos"], ["with","Con seguimiento"], ["without","Sin seguimiento"], ["overdue","Vencidos"], ["today","Hoy"] ] as const).map(([value,label]) => <button key={value} aria-pressed={followUpFilter === value} className={followUpFilter === value ? "on" : ""} onClick={() => { setFollowUpFilter(value); setPage(0); }}>{label}</button>)}</div></div>
      </div>
      {error && <p className="live-error" role="alert">{error} <button onClick={() => setReload((value) => value + 1)} aria-label="Reintentar">Reintentá la búsqueda</button></p>}
      {loading ? <p className="live-empty" role="status">Cargando pacientes…</p> : error ? null : patients.length === 0 ? <p className="live-empty">{filtered ? "No encontramos pacientes con esos filtros." : "Todavía no tenés pacientes."}</p> : <>
        <p className="crm-result-count">{total} {total === 1 ? "paciente" : "pacientes"}{filtered ? " con estos filtros" : ""}</p>
        <PatientsTable patients={patients} today={today} automaticIds={automaticPatients} formatDate={(value) => crmDate(value, context!.market)} statusLabel={(value) => statusLabels[value]}
          renderOpen={(patient, content, { className, label }) => <Link className={className} href={`/pacientes/${patient.id}`} aria-label={label}>{content}</Link>}/>
        <div className="crm-pagination"><span>Página {page + 1} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span><div><button disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button><button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Siguiente</button></div></div>
      </>}
    </section>
  </CrmShell>;
}
