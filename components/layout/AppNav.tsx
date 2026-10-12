import Link from "next/link";
import { Bell, CalendarDays, Clock3, FileText, LayoutDashboard, ListChecks, Lock, Settings2, Sparkles, Users } from "lucide-react";
import type { NavEntry } from "@/lib/entitlements";
import "@/components/plan/plan-ui.css";

/**
 * Single source of truth for the professional navigation. Dashboard, CrmShell
 * and /demo render this list, so moving between screens only changes the
 * active item. The first four entries are the mobile tabs; the rest go to "Más".
 */
export const appNav = [
  { key: "Resumen", icon: LayoutDashboard, href: "/dashboard" },
  { key: "Agenda", icon: CalendarDays, href: "/dashboard?section=Agenda" },
  { key: "Pacientes", icon: Users, href: "/pacientes" },
  { key: "Servicios", icon: FileText, href: "/dashboard?section=Servicios" },
  { key: "Disponibilidad", icon: Clock3, href: "/dashboard?section=Disponibilidad" },
  { key: "Perfil", icon: Settings2, href: "/dashboard?section=Perfil" },
  { key: "Seguimientos", icon: ListChecks, href: "/seguimientos" },
  { key: "Automatizaciones", icon: Settings2, href: "/automatizaciones" },
  { key: "Notificaciones", icon: Bell, href: "/notificaciones" },
  { key: "Formularios", icon: FileText, href: "/dashboard/questionnaires" },
  { key: "Bellis Pro", icon: Sparkles, href: "/pro" },
] as const;

export type NavKey = (typeof appNav)[number]["key"];
/** Sections rendered inside /dashboard itself. */
export const dashboardSections = ["Resumen", "Agenda", "Servicios", "Disponibilidad", "Perfil"] as const satisfies readonly NavKey[];

/** Perfil is split in tabs; payment setup lives here instead of being its own navigation entry. */
export const profileTabs = [
  { id: "perfil", label: "Perfil profesional" },
  { id: "pagina", label: "Página pública" },
  { id: "cobros", label: "Cobros y pagos" },
] as const;
export type ProfileSectionTab = (typeof profileTabs)[number]["id"];
/** Old links to the removed "Cobros" section (/dashboard?section=Cobros) open Perfil → Cobros y pagos. */
export function profileTabFromQuery(section: string | null, tab: string | null): ProfileSectionTab | null {
  if (section === "Cobros") return "cobros";
  if (section === "Perfil") return profileTabs.find((item) => item.id === tab)?.id ?? "perfil";
  return null;
}

/** Active item for a route. /dashboard keeps its section in state and passes it directly. */
export function navKeyForPath(pathname: string): NavKey {
  if (pathname.startsWith("/pacientes")) return "Pacientes";
  if (pathname.startsWith("/seguimientos")) return "Seguimientos";
  if (pathname.startsWith("/automatizaciones")) return "Automatizaciones";
  if (pathname.startsWith("/notificaciones")) return "Notificaciones";
  if (pathname.startsWith("/dashboard/questionnaires")) return "Formularios";
  if (pathname.startsWith("/pro")) return "Bellis Pro";
  return "Resumen";
}

/**
 * Every navigation entry, in order. Entries with a `local` handler render as
 * buttons (in-page sections, or all of them in /demo); the rest are links.
 * Returns an array so AppMobileNav can split tabs from the "Más" menu.
 */
export function navItems({ active, variant, local = {}, entry = () => "open" }: {
  active: NavKey; variant: "sidebar" | "mobile"; local?: Partial<Record<NavKey, () => void>>;
  /**
   * How each section shows for the plan of this workspace (navEntry). A locked one is not disabled: it opens a
   * page that explains it. A pending one holds its place while the plan is still loading. None of the sections
   * that depend on the plan is among the first four, which are the mobile tabs.
   */
  entry?: (section: NavKey) => NavEntry;
}) {
  return appNav.map(({ key, icon: Icon, href }, index) => {
    const state = entry(key);
    if (state === "hidden") return null;
    if (state === "pending") return <span key={key} className={variant === "sidebar" ? "demo-nav nav-pending" : "nav-pending"} aria-hidden="true"><span className="nav-pending-bar"/></span>;
    const on = active === key;
    const className = variant === "sidebar" ? (on ? "demo-nav active" : "demo-nav") : on ? "active" : "";
    // AppMobileNav adds the icon to the four tabs itself.
    // The name on one line and "Bellis Pro" with its lock under it: both are text, and both fit the narrow sidebar.
    const label = state === "locked" ? <span className="nav-locked"><span>{key}</span><span className="nav-pro"><Lock size={11} aria-hidden /> Bellis Pro</span></span> : <span>{key}</span>;
    const content = variant === "mobile" && index < 4 ? key : <><Icon size={17}/>{label}</>;
    const select = local[key];
    return select
      ? <button type="button" key={key} className={className} aria-current={on ? "page" : undefined} onClick={select}>{content}</button>
      : <Link key={key} className={className} aria-current={on ? "page" : undefined} href={href}>{content}</Link>;
  }).filter((item) => item !== null);
}
