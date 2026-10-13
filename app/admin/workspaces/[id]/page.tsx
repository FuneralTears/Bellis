"use client";

import { useState } from "react";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AdminFrame, AdminHeader, AdminState, WorkspaceDetailView } from "@/components/admin/AdminUi";
import { PlanCommercialPanel, PlanDialog } from "@/components/admin/AdminPlans";
import type { AdminWorkspaceDetail } from "@/lib/admin";
import { planChangeNotice, type AdminPlanChange, type PlanChangeResult, type PlanDialogMode } from "@/lib/admin-plans";
import { adminRpc, useAdminData, useAdminRole } from "../../AdminGate";

/**
 * One workspace: account, plan, usage, payments and its latest events, plus the commercial plan. Changing the plan
 * goes through admin_set_workspace_plan, which only lets the 'admin' role do it; the buttons are hidden for support.
 */
export default function AdminWorkspaceDetailPage() {
  const role = useAdminRole();
  const { id } = useParams<{ id: string }>();
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState<PlanDialogMode | null>(null);
  const [notice, setNotice] = useState("");
  // The server answers "not found" both for an id that does not exist and for a caller without access.
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const { data, error, denied } = useAdminData(async () => {
    const [detail, changes] = await Promise.all([
      adminRpc<AdminWorkspaceDetail>("admin_workspace_detail", { p_workspace: valid ? id : null }),
      adminRpc<AdminPlanChange[]>("admin_plan_changes", { p_workspace: valid ? id : null, p_limit: 20 }),
    ]);
    return { detail, changes };
  }, `${id}:${version}`);
  if (denied) notFound();
  // Rejects with the server's error code, which the dialog turns into a sentence. On success the screen reloads.
  async function changePlan(proEndsAt: string | null) {
    const result = await adminRpc<PlanChangeResult>("admin_set_workspace_plan", { p_workspace: id, p_target_plan: dialog === "downgrade" ? "free" : "pro", p_pro_ends_at: proEndsAt });
    setNotice(planChangeNotice(result)); setDialog(null); setVersion((value) => value + 1);
  }
  return <AdminFrame active="Usuarios" role={role}>
    <AdminHeader title={data?.detail.workspace_name ?? "Consultorio"} description={data ? data.detail.owner_email ?? undefined : undefined}
      back={<Link className="bo-back" href="/admin/workspaces"><ArrowLeft size={16} aria-hidden /> Usuarios</Link>} />
    {error && <AdminState tone="error">{error}</AdminState>}
    {!data && !error && <AdminState>Cargando el consultorio…</AdminState>}
    {data && <WorkspaceDetailView detail={data.detail}
      commercial={<PlanCommercialPanel detail={data.detail} changes={data.changes} role={role} notice={notice} onAction={(mode) => { setNotice(""); setDialog(mode); }} />} />}
    {data && dialog && <PlanDialog mode={dialog} subject={data.detail} onConfirm={changePlan} onClose={() => setDialog(null)} />}
  </AdminFrame>;
}
