"use client";

import AppMobileNav from "@/components/layout/AppMobileNav";
import AppTopbar from "@/components/layout/AppTopbar";
import BellisLogo from "@/components/brand/BellisLogo";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { navItems, navKeyForPath } from "@/components/layout/AppNav";
import type { CrmContext } from "./crm";
import NotificationBell from "../components/NotificationBell";
import "../demo/demo.css";
import "../dashboard/live.css";
import "./crm.css";
import "./crm-phase2.css";

export default function CrmShell({ context, children, breadcrumb = "Pacientes" }: { context: CrmContext | null; children: ReactNode; breadcrumb?: string }) {
  // The active item comes from the route, not from the breadcrumb text.
  const active = navKeyForPath(usePathname());
  return <div className="demo-shell"><aside className="demo-sidebar"><Link className="brand" href="/"><BellisLogo /></Link><div className="workspace-label">MI ESPACIO</div><div className="workspace-card"><span className="workspace-avatar">{context?.professionalName.slice(0, 2).toUpperCase() ?? "B"}</span><span><b>{context?.professionalName ?? "Cargando…"}</b><small>{context?.specialty ?? "Profesional"}</small></span></div><nav aria-label="Panel profesional">{navItems({ active, variant: "sidebar" })}</nav><div className="demo-side-bottom"><Link href="/dashboard"><ArrowLeft size={16}/> Volver al panel</Link></div></aside><div className="demo-content"><AppTopbar breadcrumb={breadcrumb}><NotificationBell workspaceId={context?.workspaceId ?? null}/><Link className="demo-top-link" href="/dashboard"><ArrowLeft size={16}/> Panel profesional</Link></AppTopbar><AppMobileNav activeKey={active}>{navItems({ active, variant: "mobile" })}</AppMobileNav><main className="demo-main crm-main">{children}</main></div></div>;
}
