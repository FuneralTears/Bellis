"use client";

import { notFound } from "next/navigation";
import { AdminFrame, AdminHeader, AdminState, UpgradeRequestList } from "@/components/admin/AdminUi";
import { defaultWorkspaceFilters, workspaceQuery, type AdminWorkspacePage } from "@/lib/admin";
import { adminRpc, useAdminData, useAdminRole } from "../AdminGate";

const open = { href: (id: string) => `/admin/workspaces/${id}` };

/**
 * Solicitudes Pro: who asked for Bellis Pro and is still waiting. Read-only for now: activating, extending or
 * closing a request is not done from here yet.
 */
export default function AdminUpgradesPage() {
  const role = useAdminRole();
  const { data, error, denied } = useAdminData(() => adminRpc<AdminWorkspacePage>("admin_workspaces", workspaceQuery({ ...defaultWorkspaceFilters, upgradeRequested: true }, 0, 100)), "upgrades");
  if (denied) notFound();
  return <AdminFrame active="Solicitudes Pro" role={role} openRequests={data?.total}>
    <AdminHeader title="Solicitudes Pro" description="Quién pidió Bellis Pro y está esperando respuesta. Primero, la que más espera." />
    <AdminState>Por ahora esta pantalla es de consulta: los cambios de plan todavía no se hacen desde acá.</AdminState>
    {error && <AdminState tone="error">{error}</AdminState>}
    {!data && !error && <AdminState>Cargando solicitudes…</AdminState>}
    {data && <UpgradeRequestList rows={data.rows} open={open} />}
  </AdminFrame>;
}
