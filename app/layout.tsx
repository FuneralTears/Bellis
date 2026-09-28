import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Bellis — Agenda, pacientes y cobros en un solo lugar", description: "Bellis ayuda a profesionales y consultorios a recibir formularios previos, cobros y reservas en un solo lugar.", icons: { icon: "/bellis-logo.png", shortcut: "/bellis-logo.png", apple: "/bellis-logo.png" } };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) { return <html lang="es"><body>{children}</body></html>; }
