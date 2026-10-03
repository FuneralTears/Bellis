"use client";

import { Children, cloneElement, isValidElement, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { CalendarDays, FileText, House, MoreHorizontal, Users, X } from "lucide-react";

/** Keeps every existing route and action accessible in four tabs and a More dialog. */
export default function AppMobileNav({ activeKey, children }: { activeKey: string; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const items = Children.toArray(children);
  const icons = [House, CalendarDays, Users, FileText];
  const secondaryActive = items.slice(4).some((item) => isValidElement<{ className?: string }>(item) && item.props.className?.split(" ").includes("active"));

  useEffect(() => { dialogRef.current?.close(); }, [activeKey]);

  return <>
    <nav className="demo-mobile-nav" aria-label="Secciones">
      {items.slice(0, 4).map((item, index) => {
        if (!isValidElement(item)) return item;
        const entry = item as ReactElement<{ children?: ReactNode; className?: string; "aria-current"?: "page" }>;
        const Icon = icons[index];
        return cloneElement(entry, { "aria-current": entry.props.className?.split(" ").includes("active") ? "page" : undefined }, <><Icon size={18}/><span>{entry.props.children}</span></>);
      })}
      {items.length > 4 && <button type="button" className={secondaryActive ? "active" : ""} aria-label="Más secciones" aria-haspopup="dialog" onClick={() => dialogRef.current?.showModal()}><MoreHorizontal size={18}/><span>Más</span></button>}
    </nav>
    <dialog className="app-more-dialog" ref={dialogRef} aria-labelledby="app-more-title" onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}>
      <div className="app-more-heading"><h2 id="app-more-title">Más secciones</h2><button type="button" aria-label="Cerrar menú" onClick={() => dialogRef.current?.close()}><X size={18}/></button></div>
      <nav className="app-more-menu" aria-label="Todas las secciones" onClick={(event) => { if ((event.target as HTMLElement).closest("a, button")) dialogRef.current?.close(); }}>{items.slice(4)}</nav>
    </dialog>
  </>;
}
