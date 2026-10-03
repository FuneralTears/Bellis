"use client";

import AppMobileNav from "@/components/layout/AppMobileNav";
import AppTopbar from "@/components/layout/AppTopbar";
import BellisLogo from "@/components/brand/BellisLogo";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Bell, CalendarDays, CreditCard, FileText, LayoutDashboard, ListChecks, Settings2, Users } from "lucide-react";
import type { CrmContext } from "./crm";
import NotificationBell from "../components/NotificationBell";
import "../demo/demo.css";
import "../dashboard/live.css";
import "./crm.css";
import "./crm-phase2.css";

export default function CrmShell({ context, children, breadcrumb = "Pacientes" }: { context: CrmContext | null; children: ReactNode; breadcrumb?: string }) {
  const onFollowUps = breadcrumb === "Seguimientos";
  const onAutomations = breadcrumb === "Automatizaciones" || breadcrumb === "Ejecuciones";
  const onNotifications = breadcrumb === "Notificaciones";
  return <div className="demo-shell"><aside className="demo-sidebar"><Link className="brand" href="/"><BellisLogo /></Link><div className="workspace-label">MI ESPACIO</div><div className="workspace-card"><span className="workspace-avatar">{context?.professionalName.slice(0, 2).toUpperCase() ?? "B"}</span><span><b>{context?.professionalName ?? "Cargando…"}</b><small>{context?.specialty ?? "Profesional"}</small></span></div><nav aria-label="Panel profesional"><Link className="demo-nav" href="/dashboard"><LayoutDashboard size={19}/> Resumen</Link><Link className="demo-nav" href="/dashboard?section=Agenda"><CalendarDays size={19}/> Agenda</Link><Link className={(onFollowUps || onAutomations || onNotifications) ? "demo-nav" : "demo-nav active"} href="/pacientes"><Users size={19}/> Pacientes</Link><Link className={onFollowUps ? "demo-nav active" : "demo-nav"} href="/seguimientos"><ListChecks size={19}/> Seguimientos</Link><Link className={onAutomations ? "demo-nav active" : "demo-nav"} href="/automatizaciones"><Settings2 size={19}/> Automatizaciones</Link><Link className={onNotifications ? "demo-nav active" : "demo-nav"} href="/notificaciones"><Bell size={19}/> Notificaciones</Link><Link className="demo-nav" href="/dashboard/questionnaires"><FileText size={19}/> Formularios</Link><Link className="demo-nav" href="/dashboard?section=Cobros"><CreditCard size={19}/> Cobros</Link></nav><div className="demo-side-bottom"><Link href="/dashboard"><ArrowLeft size={16}/> Volver al panel</Link></div></aside><div className="demo-content"><AppTopbar breadcrumb={breadcrumb}><NotificationBell workspaceId={context?.workspaceId ?? null}/><Link className="demo-top-link" href="/dashboard"><ArrowLeft size={16}/> Panel profesional</Link></AppTopbar><AppMobileNav activeKey={breadcrumb}><Link href="/dashboard">Resumen</Link><Link href="/dashboard?section=Agenda">Agenda</Link><Link className={(onFollowUps || onAutomations || onNotifications) ? "" : "active"} href="/pacientes">Pacientes</Link><Link className={onFollowUps ? "active" : ""} href="/seguimientos">Seguimientos</Link><Link className={onAutomations ? "active" : ""} href="/automatizaciones">Automatizaciones</Link><Link className={onNotifications ? "active" : ""} href="/notificaciones">Notificaciones</Link><Link href="/dashboard/questionnaires">Formularios</Link><Link href="/dashboard?section=Cobros">Cobros</Link></AppMobileNav><main className="demo-main crm-main">{children}</main></div></div>;
}
