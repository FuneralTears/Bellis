"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { AdminFrame, AdminHeader, AdminState } from "@/components/admin/AdminUi";
import { PlanDialog, RequestDialog, UpgradeRequestsView } from "@/components/admin/AdminPlans";
import { requestNotice, type AdminUpgradeRequest, type AdminUpgradeRequestPage, type RequestAction, type RequestStatus } from "@/lib/admin-plans";
import { adminRpc, useAdminData, useAdminRole } from "../AdminGate";

const open = { href: (id: string) => `/admin/workspaces/${id}` };

/**
 * Solicitudes Pro: who asked for Bellis Pro, the one waiting longest first. An admin can activate Pro (which also
 * resolves the request, all or nothing), resolve it without activating, or dismiss it. Support only reads.
 */
export default function AdminUpgradesPage() {
  const role = useAdminRole();
  const [status, setStatus] = useState<RequestStatus>("open");
  const [version, setVersion] = useState(0);
  const [acting, setActing] = useState<{ request: AdminUpgradeRequest; action: RequestAction } | null>(null);
  const [notice, setNotice] = useState("");
  const { data, error, denied, loading } = useAdminData(() => adminRpc<AdminUpgradeRequestPage>("admin_upgrade_requests", { p_status: status, p_limit: 100, p_offset: 0 }), `${status}:${version}`);
  if (denied) notFound();
  // Rejects with the server's error code, which the dialog turns into a sentence. On success the list reloads.
  async function act(proEndsAt: string | null) {
    if (!acting) return;
    await adminRpc("admin_resolve_upgrade_request", { p_request: acting.request.request_id, p_action: acting.action, p_pro_ends_at: proEndsAt });
    setNotice(requestNotice(acting.action, proEndsAt)); setActing(null); setVersion((value) => value + 1);
  }
  return <AdminFrame active="Solicitudes Pro" role={role} openRequests={data?.open}>
    <AdminHeader title="Solicitudes Pro" description="Quién pidió Bellis Pro. Entre las abiertas, primero la que más espera." />
    {error && <AdminState tone="error">{error}</AdminState>}
    <div aria-busy={loading}>
      <UpgradeRequestsView rows={loading ? null : data?.rows ?? null} status={status} onStatus={(next) => { setStatus(next); setNotice(""); }} role={role} open={open} notice={notice}
        onAct={(request, action) => { setNotice(""); setActing({ request, action }); }} />
    </div>
    {acting && acting.action === "activate" && <PlanDialog mode={acting.request.effective_tier === "pro" ? "extend" : "activate"} subject={acting.request} onConfirm={act} onClose={() => setActing(null)} />}
    {acting && acting.action !== "activate" && <RequestDialog action={acting.action} request={acting.request} onConfirm={() => act(null)} onClose={() => setActing(null)} />}
  </AdminFrame>;
}
