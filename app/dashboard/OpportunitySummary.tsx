"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import { fetchPages } from "../pacientes/crm";
import { detectOpportunities, hasAttention, type OpportunityOverview } from "../pacientes/opportunities";
import "../pacientes/crm-phase2.css";

export default function OpportunitySummary({ workspaceId }: { workspaceId: string }) {
  const [patients, setPatients] = useState<OpportunityOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { let cancelled = false;
    async function load() {
      try {
        const client = await getSupabase();
        const rows = await fetchPages<OpportunityOverview>(async (from, to) => await client.from("patient_follow_up_opportunities")
          .select("*").eq("workspace_id", workspaceId).order("id").range(from, to));
        if (!cancelled) setPatients(rows);
      } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : "No pudimos cargar las oportunidades."); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; };
  }, [workspaceId]);

  const attention = useMemo(() => patients.filter(hasAttention), [patients]);
  const rows = useMemo(() => attention.flatMap((patient) => detectOpportunities(patient).filter((item) => item.level === "attention").map((item) => ({ patient, item })))
    .sort((a, b) => a.item.priority - b.item.priority || a.patient.full_name.localeCompare(b.patient.full_name, "es-AR")).slice(0, 5), [attention]);
  return <section className="demo-panel crm-dashboard-opportunities"><div className="crm-section-head"><div><h2>Pendientes <span className="dashboard-count">{loading ? "…" : error ? "—" : attention.length}</span></h2><p className="crm-hint">Pagos, seguimientos y próximos turnos.</p></div><Link className="crm-dashboard-link" href="/seguimientos">Ver seguimientos <ArrowRight size={15}/></Link></div>
    {loading ? <p className="live-empty" role="status">Revisando pacientes…</p> : error ? <p className="live-error" role="alert">{error}</p> : <><div className="crm-dashboard-counts"><div><strong>{attention.length}</strong><span>Pacientes que requieren atención</span></div><div><strong>{patients.filter((item) => item.has_pending_payment).length}</strong><span>Con pago pendiente</span></div><div><strong>{patients.filter((item) => item.has_overdue_follow_up).length}</strong><span>Con seguimiento vencido</span></div><div><strong>{patients.filter((item) => item.without_next_turn).length}</strong><span>Sin próximo turno</span></div></div>
      {rows.length ? <div className="crm-dashboard-opportunity-list">{rows.map(({ patient, item }) => <Link key={`${patient.id}:${item.kind}`} href={`/pacientes/${patient.id}`}><span><b>{patient.full_name}</b><small>{item.title} · {item.reason}</small></span><ArrowRight size={16}/></Link>)}</div> : <p className="live-empty">No hay acciones pendientes detectadas.</p>}
    </>}
  </section>;
}
