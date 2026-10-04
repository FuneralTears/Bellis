import type { Metadata } from "next";
import AuthDemo from "./auth-demo";

export const metadata: Metadata = { title: "Bellis — Demo de acceso" };

export default function DemoAuth() {
  return <AuthDemo />;
}
