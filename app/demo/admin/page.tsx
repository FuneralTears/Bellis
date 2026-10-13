"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { AdminClock, AdminFrame, AdminHeader, EventList, OverviewCards, Pager, TrialsEnding, WorkspaceDetailView, WorkspaceFiltersBar, WorkspaceTable,
  type AdminSection } from "@/components/admin/AdminUi";
import { PlanCommercialPanel, PlanDialog, RequestDialog, UpgradeRequestsView } from "@/components/admin/AdminPlans";
import { adminDateTime, adminPageSize, defaultWorkspaceFilters, type AdminRole, type AdminWorkspaceFilters } from "@/lib/admin";
import { lastValidDayOf, planChangeNotice, requestNotice, type AdminUpgradeRequest, type PlanDialogMode, type RequestAction, type RequestStatus } from "@/lib/admin-plans";
import { demoChangePlan, demoCommercialStart, demoDetail, demoEvents, demoFilter, demoNow, demoOverview, demoResolveRequest, type DemoCommercialState } from "./admin-data";

/**
 * Showroom of the internal backoffice. Same components as /admin, fed with invented data: no Supabase, no session,
 * no admin check. Plan changes and requests are simulated in memory and go back to the start on reload.
 */
export default function DemoAdminPage() {
  const [section, setSection] = useState<AdminSection>("Resumen");
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<AdminWorkspaceFilters>(defaultWorkspaceFilters);
  const [role, setRole] = useState<AdminRole>("admin");
  const [state, setState] = useState<DemoCommercialState>(demoCommercialStart);
  const [dialog, setDialog] = useState<PlanDialogMode | null>(null);
  const [acting, setActing] = useState<{ request: AdminUpgradeRequest; action: RequestAction } | null>(null);
  const [status, setStatus] = useState<RequestStatus>("open");
  const [notice, setNotice] = useState("");
  const open = { onOpen: (id: string) => { setSection("Usuarios"); setSelected(id); setNotice(""); window.scrollTo(0, 0); } };
  const navigate = (next: AdminSection) => { setSection(next); setSelected(null); setNotice(""); window.scrollTo(0, 0); };
  const detail = selected ? demoDetail(selected, state.workspaces) : null;
  const rows = demoFilter(filters, state.workspaces);
  const trials = demoFilter({ ...defaultWorkspaceFilters, tier: "pro_trial", sort: "trial_ending" }, state.workspaces);
  const openRequests = state.requests.filter((item) => item.status === "open").length;
  const requests = state.requests.filter((item) => item.status === status)
    .sort((a, b) => status === "open" ? a.requested_at.localeCompare(b.requested_at) : (b.resolved_at ?? "").localeCompare(a.resolved_at ?? ""));
  const overview = { ...demoOverview, upgrade_requests_open: openRequests, pro_active: state.workspaces.filter((item) => item.effective_tier === "pro").length,
    pro_trial_active: state.workspaces.filter((item) => item.effective_tier === "pro_trial").length, free_active: state.workspaces.filter((item) => item.effective_tier === "free").length };

  // What the server would answer, applied to the mock rows.
  async function changePlan(proEndsAt: string | null) {
    if (!detail || !dialog) return;
    const next = demoChangePlan(state, detail.workspace_id, dialog, proEndsAt); const after = next.workspaces.find((item) => item.workspace_id === detail.workspace_id)!;
    setState(next); setDialog(null);
    setNotice(planChangeNotice({ action: dialog === "downgrade" ? "downgraded_to_free" : dialog === "extend" ? "pro_extended" : "pro_activated", pro_ends_at: after.pro_ends_at, effective_tier: after.effective_tier }));
  }
  async function act(proEndsAt: string | null) {
    if (!acting) return;
    setState(demoResolveRequest(state, acting.request.request_id, acting.action, proEndsAt)); setNotice(requestNotice(acting.action, proEndsAt)); setActing(null);
  }

  return <AdminClock.Provider value={demoNow}><AdminFrame active={section} role={role} openRequests={openRequests} navigate={navigate} exit={{ href: "/demo", label: "Volver a la demo" }}
    banner={<div className="bo-banner" role="note"><span>Demo del backoffice interno con datos ficticios. No se conecta a ninguna cuenta real: los cambios de plan se simulan y se pierden al recargar.</span>
      <span className="bo-demo-role" role="group" aria-label="Ver la demo como">Ver como
        {(["admin", "support"] as AdminRole[]).map((key) => <button key={key} type="button" className={key === role ? "active" : ""} aria-pressed={key === role} onClick={() => { setRole(key); setNotice(""); }}>{key === "admin" ? "Admin" : "Soporte"}</button>)}</span></div>}>
    {section === "Resumen" && <>
      <AdminHeader title="Resumen" description="Cómo está Bellis hoy: registros, uso y planes." aside={<>Actualizado {adminDateTime(demoOverview.generated_at)}</>} />
      <OverviewCards overview={overview} />
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
        back={<button type="button" className="bo-back" onClick={() => { setSelected(null); setNotice(""); }}><ArrowLeft size={16} aria-hidden /> Usuarios</button>} />
      <WorkspaceDetailView detail={detail}
        commercial={<PlanCommercialPanel detail={detail} changes={state.changes[detail.workspace_id] ?? []} role={role} notice={notice} onAction={(mode) => { setNotice(""); setDialog(mode); }} />} />
      {dialog && <PlanDialog mode={dialog} subject={detail} onConfirm={changePlan} onClose={() => setDialog(null)} />}
    </>}
    {section === "Solicitudes Pro" && <>
      <AdminHeader title="Solicitudes Pro" description="Quién pidió Bellis Pro. Entre las abiertas, primero la que más espera." />
      <UpgradeRequestsView rows={requests} status={status} onStatus={(next) => { setStatus(next); setNotice(""); }} role={role} open={open} notice={notice}
        onAct={(request, action) => { setNotice(""); setActing({ request, action }); }} />
      {acting && acting.action === "activate" && <PlanDialog mode={acting.request.effective_tier === "pro" && lastValidDayOf(acting.request.pro_ends_at) ? "extend" : "activate"} subject={acting.request} onConfirm={act} onClose={() => setActing(null)} />}
      {acting && acting.action !== "activate" && <RequestDialog action={acting.action} request={acting.request} onConfirm={() => act(null)} onClose={() => setActing(null)} />}
    </>}
  </AdminFrame></AdminClock.Provider>;
}
