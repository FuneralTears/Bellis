"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminFrame, AdminHeader, AdminState, EventList, OverviewCards, TrialsEnding } from "@/components/admin/AdminUi";
import { adminDateTime, defaultWorkspaceFilters, workspaceQuery, type AdminEvent, type AdminOverview, type AdminWorkspacePage } from "@/lib/admin";
import { adminRpc, useAdminData, useAdminRole } from "./AdminGate";

const open = { href: (id: string) => `/admin/workspaces/${id}` };

/** Resumen: the numbers of the product, what happened lately and the trials closest to their end. */
export default function AdminOverviewPage() {
  const role = useAdminRole();
  const { data, error, denied } = useAdminData(async () => {
    const [overview, events, trials] = await Promise.all([
      adminRpc<AdminOverview>("admin_overview"),
      adminRpc<AdminEvent[]>("admin_recent_activity", { p_limit: 20 }),
      adminRpc<AdminWorkspacePage>("admin_workspaces", workspaceQuery({ ...defaultWorkspaceFilters, tier: "pro_trial", sort: "trial_ending" }, 0, 8)),
    ]);
    return { overview, events, trials: trials.rows };
  }, "overview");
  if (denied) notFound();
  return <AdminFrame active="Resumen" role={role} openRequests={data?.overview.upgrade_requests_open}>
    <AdminHeader title="Resumen" description="Cómo está Bellis hoy: registros, uso y planes." aside={data && <>Actualizado {adminDateTime(data.overview.generated_at)}</>} />
    {error && <AdminState tone="error">{error}</AdminState>}
    {!data && !error && <AdminState>Cargando el resumen…</AdminState>}
    {data && <>
      <OverviewCards overview={data.overview} />
      <div className="bo-columns">
        <section className="bo-panel" aria-labelledby="bo-recent"><h2 id="bo-recent">Actividad reciente</h2><EventList events={data.events} open={open} /></section>
        <section className="bo-panel" aria-labelledby="bo-trials"><h2 id="bo-trials">Pruebas próximas a vencer</h2><TrialsEnding rows={data.trials} open={open} />
          <p className="bo-panel-foot"><Link className="bo-link" href="/admin/workspaces">Ver todos los consultorios</Link></p></section>
      </div>
    </>}
  </AdminFrame>;
}
