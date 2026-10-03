import Link from "next/link";
import { Bell, CalendarDays, Clock3, FileText, LayoutDashboard, ListChecks, Settings2, Users } from "lucide-react";

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
  return "Resumen";
}

/**
 * Every navigation entry, in order. Entries with a `local` handler render as
 * buttons (in-page sections, or all of them in /demo); the rest are links.
 * Returns an array so AppMobileNav can split tabs from the "Más" menu.
 */
export function navItems({ active, variant, local = {} }: { active: NavKey; variant: "sidebar" | "mobile"; local?: Partial<Record<NavKey, () => void>> }) {
  return appNav.map(({ key, icon: Icon, href }, index) => {
    const on = active === key;
    const className = variant === "sidebar" ? (on ? "demo-nav active" : "demo-nav") : on ? "active" : "";
    // AppMobileNav adds the icon to the four tabs itself.
    const content = variant === "mobile" && index < 4 ? key : <><Icon size={17}/><span>{key}</span></>;
    const select = local[key];
    return select
      ? <button type="button" key={key} className={className} aria-current={on ? "page" : undefined} onClick={select}>{content}</button>
      : <Link key={key} className={className} aria-current={on ? "page" : undefined} href={href}>{content}</Link>;
  });
}
