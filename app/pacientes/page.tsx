"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "./CrmShell";
import { crmDate, errorMessage, loadCrmContext, statusLabels, type CrmContext, type PatientStatus } from "./crm";
import { todayInTimezone } from "./timeline";
import { isSmartOpportunity, opportunityFilters, type OpportunityKind, type OpportunityOverview } from "./opportunities";
import { hasCapability } from "@/lib/entitlements";
import { PageHeader, PatientsTable } from "@/components/crm/CrmUi";
import { NewPatientForm, type NewPatientValues } from "@/components/crm/NewPatientForm";
import { createManualPatient, lookupPatientDuplicates } from "./manual-patient";
import { PatientFilters } from "@/components/crm/PatientFilters";
import type { FollowUpFilter } from "@/lib/patient-filters";

const PAGE_SIZE = 25;
type Sort = "last_turn" | "next_turn" | "full_name";
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

  const lookupDuplicates = (phone: string, email: string | null) => lookupPatientDuplicates(context!.workspaceId, phone, email);
  const createPatient = async (values: NewPatientValues) => { router.push(`/pacientes/${await createManualPatient(context!.workspaceId, values)}`); };

  const today = context ? todayInTimezone(context.market.timezone) : "";
  const smart = hasCapability(context?.access, "smart_followups");
  const filtered = Boolean(search) || status !== "all" || followUpFilter !== "all" || opportunityFilter !== "all";
  return <CrmShell context={context}>
    <PageHeader title="Pacientes" description="Información, turnos y seguimiento en un solo lugar."><Link className="crm-btn" href="/seguimientos">Ver seguimientos <ArrowRight size={16}/></Link><button className="demo-primary" type="button" disabled={!context || creating} onClick={() => setCreating(true)}><Plus size={16}/> Nuevo paciente</button></PageHeader>
    {creating && context && <NewPatientForm lookup={lookupDuplicates} onSave={createPatient} onCancel={() => setCreating(false)}
      renderOpen={(patient, content, variant) => <Link className={variant === "primary" ? "demo-primary" : "crm-link"} href={`/pacientes/${patient.id}`}>{content}</Link>}/>}
    <section className="crm-card">
      <PatientFilters query={query} onQuery={setQuery} sort={sort} onSort={(value) => { setSort(value as Sort); setPage(0); }}
        filters={{ status, followUp: followUpFilter, opportunity: opportunityFilter }}
        onFilters={(next) => { setStatus(next.status as PatientStatus | "all"); setFollowUpFilter(next.followUp); setOpportunityFilter(next.opportunity as OpportunityFilter); setPage(0); }}
        situations={opportunityFilters.filter((item) => item.column).map((item) => ({ value: item.kind, label: item.label, locked: !smart && isSmartOpportunity(item.kind) }))}/>
      {error && <p className="live-error" role="alert">{error} <button onClick={() => setReload((value) => value + 1)} aria-label="Reintentar">Reintentá la búsqueda</button></p>}
      {loading ? <p className="live-empty" role="status">Cargando pacientes…</p> : error ? null : patients.length === 0 ? <p className="live-empty">{filtered ? "No encontramos pacientes con esos filtros." : "Todavía no tenés pacientes."}</p> : <>
        <p className="crm-result-count">{total} {total === 1 ? "paciente" : "pacientes"}{filtered ? " con estos filtros" : ""}</p>
        <PatientsTable patients={patients} today={today} automaticIds={automaticPatients} smart={smart} formatDate={(value) => crmDate(value, context!.market)} statusLabel={(value) => statusLabels[value]}
          renderOpen={(patient, content, { className, label }) => <Link className={className} href={`/pacientes/${patient.id}`} aria-label={label}>{content}</Link>}/>
        <div className="crm-pagination"><span>Página {page + 1} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span><div><button disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button><button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Siguiente</button></div></div>
      </>}
    </section>
  </CrmShell>;
}
