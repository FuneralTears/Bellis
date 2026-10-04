import type { Metadata } from "next";

// The page is a client component, so its title lives here.
export const metadata: Metadata = { title: "Bellis — Conectar Mercado Pago", robots: { index: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
