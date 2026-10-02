"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import { fetchPages } from "../pacientes/crm";
import { todayInTimezone } from "../pacientes/timeline";

type Run = { id: string; executed_at: string | null; status: string; follow_up_id: string | null };
export default function AutomationSummary({ workspaceId, timezone }: { workspaceId: string; timezone: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { let cancelled = false;
    async function load() { try {
      const client = await getSupabase();
      const [ruleCount, recent] = await Promise.all([
        client.from("automation_rules").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("enabled", true),
        fetchPages<Run>(async (from, to) => await client.from("automation_runs").select("id,executed_at,status,follow_up_id")
          .eq("workspace_id", workspaceId).gte("executed_at", new Date(Date.now() - 48 * 3600000).toISOString())
          .order("executed_at", { ascending: false }).range(from, to))
      ]);
      if (ruleCount.error) throw ruleCount.error;
      if (!cancelled) { setActive(ruleCount.count ?? 0); setRuns(recent); }
    } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : "No pudimos cargar las automatizaciones."); }
    finally { if (!cancelled) setLoading(false); } }
    void load(); return () => { cancelled = true; };
  }, [workspaceId]);
  const today = todayInTimezone(timezone);
  const todaysRuns = useMemo(() => runs.filter((run) => run.executed_at && todayInTimezone(timezone, new Date(run.executed_at)) === today), [runs, timezone, today]);
  return <section className="demo-panel crm-dashboard-opportunities"><div className="crm-section-head"><div><h2>Automatizaciones</h2><p className="crm-hint">Tareas internas creadas por reglas activas.</p></div><Link className="crm-dashboard-link" href="/automatizaciones">Ver automatizaciones <ArrowRight size={15}/></Link></div>
    {loading ? <p className="live-empty">Cargando resumen…</p> : error ? <p className="live-error" role="alert">{error}</p> : <div className="crm-dashboard-counts">
      <div><strong>{active}</strong><span>Reglas activas</span></div><div><strong>{todaysRuns.length}</strong><span>Ejecuciones hoy</span></div>
      <div><strong>{todaysRuns.filter((run) => run.status === "completed" && run.follow_up_id).length}</strong><span>Seguimientos creados hoy</span></div>
      <div><strong>{todaysRuns.filter((run) => run.status === "skipped").length}</strong><span>Acciones omitidas hoy</span></div>
      <div><strong>{todaysRuns.filter((run) => run.status === "failed").length}</strong><span>Errores hoy</span></div>
    </div>}
  </section>;
}
