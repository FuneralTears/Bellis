"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { AdminClock, AdminFrame, AdminHeader, AdminState, EventList, OverviewCards, Pager, TrialsEnding, UpgradeRequestList, WorkspaceDetailView, WorkspaceFiltersBar, WorkspaceTable,
  type AdminSection } from "@/components/admin/AdminUi";
import { adminDateTime, adminPageSize, defaultWorkspaceFilters, type AdminWorkspaceFilters } from "@/lib/admin";
import { demoDetail, demoEvents, demoFilter, demoNow, demoOverview, demoWorkspaces } from "./admin-data";

/**
 * Showroom of the internal backoffice. Same components as /admin, fed with invented data: no Supabase, no session,
 * no admin check. Nothing here can be changed either, the same as the real one today.
 */
export default function DemoAdminPage() {
  const [section, setSection] = useState<AdminSection>("Resumen");
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<AdminWorkspaceFilters>(defaultWorkspaceFilters);
  const open = { onOpen: (id: string) => { setSection("Usuarios"); setSelected(id); window.scrollTo(0, 0); } };
  const navigate = (next: AdminSection) => { setSection(next); setSelected(null); window.scrollTo(0, 0); };
  const detail = selected ? demoDetail(selected) : null;
  const rows = demoFilter(filters);
  const trials = demoFilter({ ...defaultWorkspaceFilters, tier: "pro_trial", sort: "trial_ending" });
  const requests = demoWorkspaces.filter((item) => item.upgrade_request_open);

  return <AdminClock.Provider value={demoNow}><AdminFrame active={section} role="support" openRequests={demoOverview.upgrade_requests_open} navigate={navigate} exit={{ href: "/demo", label: "Volver a la demo" }}
    banner={<p className="bo-banner" role="note">Demo del backoffice interno con datos ficticios. No se conecta a ninguna cuenta real.</p>}>
    {section === "Resumen" && <>
      <AdminHeader title="Resumen" description="Cómo está Bellis hoy: registros, uso y planes." aside={<>Actualizado {adminDateTime(demoOverview.generated_at)}</>} />
      <OverviewCards overview={demoOverview} />
      <div className="bo-columns">
        <section className="bo-panel" aria-labelledby="bo-recent"><h2 id="bo-recent">Actividad reciente</h2><EventList events={demoEvents} open={open} /></section>
        <section className="bo-panel" aria-labelledby="bo-trials"><h2 id="bo-trials">Pruebas próximas a vencer</h2><TrialsEnding rows={trials} open={open} />
          <p className="bo-panel-foot"><button type="button" className="bo-link" onClick={() => navigate("Usuarios")}>Ver todos los consultorios</button></p></section>
      </div>
    </>}
    {section === "Usuarios" && !detail && <>
      <AdminHeader title="Usuarios" description="Quién se registró, en qué plan está y cuánto usa Bellis." />
      <WorkspaceFiltersBar filters={filters} onChange={setFilters} />
      <WorkspaceTable rows={rows} open={open} />
      <Pager page={0} total={rows.length} pageSize={adminPageSize} onPage={() => undefined} />
    </>}
    {section === "Usuarios" && detail && <>
      <AdminHeader title={detail.workspace_name} description={detail.owner_email ?? undefined}
        back={<button type="button" className="bo-back" onClick={() => setSelected(null)}><ArrowLeft size={16} aria-hidden /> Usuarios</button>} />
      <WorkspaceDetailView detail={detail} />
    </>}
    {section === "Solicitudes Pro" && <>
      <AdminHeader title="Solicitudes Pro" description="Quién pidió Bellis Pro y está esperando respuesta. Primero, la que más espera." />
      <AdminState>Por ahora esta pantalla es de consulta: los cambios de plan todavía no se hacen desde acá.</AdminState>
      <UpgradeRequestList rows={requests} open={open} />
    </>}
  </AdminFrame></AdminClock.Provider>;
}
