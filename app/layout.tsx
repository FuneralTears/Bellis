import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-bellis", display: "swap" });
export const metadata: Metadata = { title: "Bellis — Agenda, pacientes y cobros en un solo lugar", description: "Bellis ayuda a profesionales y consultorios a recibir formularios previos, cobros y reservas en un solo lugar.", icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" } };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) { return <html lang="es" className={inter.variable}><body>{children}</body></html>; }
