"use client";

import { useEffect, useRef, useState } from "react";
import { completeMercadoPagoConnection } from "@/lib/mercado-pago";
import { AuthHeading, AuthLoading, AuthMessage, AuthShell } from "@/components/auth/AuthUi";

/**
 * Where Mercado Pago returns the person after they authorize (or not). It lives in Bellis so the
 * connection is completed with the session of whoever is here: the link alone is not enough.
 * The outcome is shown in Cobros y pagos; this page only stays visible when there is no session.
 */

type Outcome = "connected" | "cancelled" | "invalid_state" | "error" | "signed_out";

async function resolve(): Promise<Outcome> {
  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  const state = query.get("state");
  // The code works once and must not stay in the address bar or the browser history.
  window.history.replaceState(null, "", window.location.pathname);
  // Coming back without a code means the person did not authorize. Nothing is sent to the server.
  if (!code || !state) return "cancelled";
  try { return await completeMercadoPagoConnection(code, state); } catch { return "error"; }
}

export default function MercadoPagoCallback() {
  const [signedOut, setSignedOut] = useState(false);
  // The code can only be handed over once, even if the effect runs twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    resolve().then((outcome) => {
      if (outcome === "signed_out") setSignedOut(true);
      // A short code for the message only: Cobros y pagos reads the real status from the server.
      else window.location.replace(`/dashboard?section=Perfil&tab=cobros&mp=${outcome}`);
    });
  }, []);

  return <AuthShell>{!signedOut ? <AuthLoading>Conectando Mercado Pago…</AuthLoading> : <>
    <AuthHeading title="Iniciá sesión para continuar" />
    <div className="auth-form">
      <AuthMessage tone="info">Necesitás iniciar sesión en Bellis para completar la conexión con Mercado Pago. No se conectó ninguna cuenta: después empezá de nuevo desde Cobros y pagos.</AuthMessage>
      <a className="auth-button" href="/ingresar">Iniciar sesión</a>
    </div>
  </>}</AuthShell>;
}
