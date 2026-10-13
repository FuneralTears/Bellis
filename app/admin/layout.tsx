import type { Metadata } from "next";
import type { ReactNode } from "react";
import AdminGate from "./AdminGate";

export const metadata: Metadata = { title: "Bellis — Backoffice", robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminGate>{children}</AdminGate>;
}
