import type { ReactNode } from "react";
import Link from "next/link";
import BellisLogo from "@/components/brand/BellisLogo";

/** Presentation only: callers retain their existing notification and link behavior. */
export default function AppTopbar({ breadcrumb, children }: { breadcrumb: string; children: ReactNode }) {
  return (
    <header className="demo-header">
      <div className="app-topbar-heading">
        <Link className="demo-mobile-brand" href="/" aria-label="Bellis, inicio"><BellisLogo /></Link>
        <span className="demo-breadcrumb"><span className="app-breadcrumb-root">Mi espacio</span> <span className="app-breadcrumb-divider" aria-hidden="true">/</span> <strong>{breadcrumb}</strong></span>
      </div>
      <div className="app-topbar-actions">{children}</div>
    </header>
  );
}
