"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import { dateBounds } from "../automatizaciones/ejecuciones/dateRange";

export default function AutomationSummary({ workspaceId, timezone }: { workspaceId: string; timezone: string }) {
  const [metrics, setMetrics] = useState({ active: 0, processed: 0, created: 0, skipped: 0, failed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { let cancelled = false;
    async function load() { try {
      const client = await getSupabase();
      const { start, end } = dateBounds("today", timezone, "", "");
      const base = () => client.from("automation_runs").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).gte("executed_at", start).lt("executed_at", end);
      const [rules, processed, created, skipped, failed] = await Promise.all([
        client.from("automation_rules").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("enabled", true),
        base(), base().eq("status", "completed"), base().eq("status", "skipped"), base().eq("status", "failed")
      ]);
      for (const item of [rules,processed,created,skipped,failed]) if (item.error) throw item.error;
      if (!cancelled) setMetrics({ active: rules.count ?? 0, processed: processed.count ?? 0, created: created.count ?? 0, skipped: skipped.count ?? 0, failed: failed.count ?? 0 });
    } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : "No pudimos cargar las automatizaciones."); }
    finally { if (!cancelled) setLoading(false); } }
    void load(); return () => { cancelled = true; };
  }, [workspaceId, timezone]);
  return <section className="demo-panel crm-dashboard-opportunities"><div className="crm-section-head"><div><h2>Automatizaciones</h2><p className="crm-hint">Actividad interna de hoy.</p></div><Link className="crm-dashboard-link" href="/automatizaciones/ejecuciones">Ver ejecuciones <ArrowRight size={15}/></Link></div>
    {loading ? <p className="live-empty">Cargando resumen…</p> : error ? <p className="live-error" role="alert">{error}</p> : <div className="crm-dashboard-counts">
      <div><strong>{metrics.active}</strong><span>Reglas activas</span></div><div><strong>{metrics.processed}</strong><span>Ejecuciones hoy</span></div>
      <div><strong>{metrics.created}</strong><span>Seguimientos creados</span></div><div><strong>{metrics.skipped}</strong><span>Acciones omitidas</span></div>
      <div><strong>{metrics.failed}</strong><span>Errores</span></div>
    </div>}
  </section>;
}
