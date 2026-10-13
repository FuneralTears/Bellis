"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { AdminFrame, AdminHeader, AdminState, Pager, WorkspaceFiltersBar, WorkspaceTable } from "@/components/admin/AdminUi";
import { adminPageSize, defaultWorkspaceFilters, workspaceQuery, type AdminWorkspaceFilters, type AdminWorkspacePage } from "@/lib/admin";
import { adminRpc, useAdminData, useAdminRole } from "../AdminGate";

const open = { href: (id: string) => `/admin/workspaces/${id}` };

/** Usuarios: every workspace, filtered and ordered on the server, one page at a time. */
export default function AdminWorkspacesPage() {
  const role = useAdminRole();
  const [filters, setFilters] = useState<AdminWorkspaceFilters>(defaultWorkspaceFilters);
  const [page, setPage] = useState(0);
  // The search waits for a pause in typing; everything else applies at once.
  const [search, setSearch] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setSearch(filters.search), 300); return () => window.clearTimeout(timer); }, [filters.search]);
  const applied = { ...filters, search };
  const { data, error, denied, loading } = useAdminData(() => adminRpc<AdminWorkspacePage>("admin_workspaces", workspaceQuery(applied, page)), JSON.stringify([applied, page]));
  if (denied) notFound();
  return <AdminFrame active="Usuarios" role={role}>
    <AdminHeader title="Usuarios" description="Quién se registró, en qué plan está y cuánto usa Bellis." />
    <WorkspaceFiltersBar filters={filters} onChange={(next) => { setFilters(next); setPage(0); }} />
    {error && <AdminState tone="error">{error}</AdminState>}
    {!data && !error && <AdminState>Cargando consultorios…</AdminState>}
    {data && <div aria-busy={loading}>
      <WorkspaceTable rows={data.rows} open={open} />
    </div>}
    {data && <Pager page={page} total={data.total} pageSize={adminPageSize} onPage={setPage} />}
  </AdminFrame>;
}
