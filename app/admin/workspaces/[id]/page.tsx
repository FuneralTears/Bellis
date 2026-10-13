"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AdminFrame, AdminHeader, AdminState, WorkspaceDetailView } from "@/components/admin/AdminUi";
import type { AdminWorkspaceDetail } from "@/lib/admin";
import { adminRpc, useAdminData, useAdminRole } from "../../AdminGate";

/** One workspace: account, plan, usage, payments and its latest events. Read-only. */
export default function AdminWorkspaceDetailPage() {
  const role = useAdminRole();
  const { id } = useParams<{ id: string }>();
  // The server answers "not found" both for an id that does not exist and for a caller without access.
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const { data, error, denied } = useAdminData(() => adminRpc<AdminWorkspaceDetail>("admin_workspace_detail", { p_workspace: valid ? id : null }), id);
  if (denied) notFound();
  return <AdminFrame active="Usuarios" role={role}>
    <AdminHeader title={data?.workspace_name ?? "Consultorio"} description={data ? data.owner_email ?? undefined : undefined}
      back={<Link className="bo-back" href="/admin/workspaces"><ArrowLeft size={16} aria-hidden /> Usuarios</Link>} />
    {error && <AdminState tone="error">{error}</AdminState>}
    {!data && !error && <AdminState>Cargando el consultorio…</AdminState>}
    {data && <WorkspaceDetailView detail={data} />}
  </AdminFrame>;
}
