import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Bellis — Agenda, pacientes y pagos en un solo lugar", description: "Bellis ayuda a profesionales y consultorios a recibir formularios previos, cobros y reservas en un solo lugar.", icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" } };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) { return <html lang="es"><body>{children}</body></html>; }
