"use client";

import { useEffect, useRef, useState } from "react";
import { completeGoogleCalendarConnection, type GoogleCalendarCompletion } from "@/lib/google-calendar";
import { AuthHeading, AuthLoading, AuthMessage, AuthShell } from "@/components/auth/AuthUi";

/**
 * Where Google returns the person after they authorize (or not). It lives in Bellis so the connection is completed
 * with the session of whoever is here: the link alone is not enough. The outcome is shown in Perfil → Integraciones;
 * this page only stays visible when there is no session.
 */

async function resolve(): Promise<GoogleCalendarCompletion> {
  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  const state = query.get("state");
  // The code works once and must not stay in the address bar or the browser history.
  window.history.replaceState(null, "", window.location.pathname);
  // Coming back without a code (access_denied) means the person did not authorize. Nothing is sent to the server.
  if (!code || !state) return "cancelled";
  try { return await completeGoogleCalendarConnection(code, state); } catch { return "error"; }
}

export default function GoogleCalendarCallback() {
  const [signedOut, setSignedOut] = useState(false);
  // The code can only be handed over once, even if the effect runs twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    resolve().then((outcome) => {
      if (outcome === "signed_out") setSignedOut(true);
      // A short code for the message only: Integraciones reads the real status from the server.
      else window.location.replace(`/dashboard?section=Perfil&tab=integraciones&gc=${outcome}`);
    });
  }, []);

  return <AuthShell>{!signedOut ? <AuthLoading>Conectando Google Calendar…</AuthLoading> : <>
    <AuthHeading title="Iniciá sesión para continuar" />
    <div className="auth-form">
      <AuthMessage tone="info">Necesitás iniciar sesión en Bellis para completar la conexión con Google Calendar. No se conectó ninguna cuenta: después empezá de nuevo desde Perfil → Integraciones.</AuthMessage>
      <a className="auth-button" href="/ingresar">Iniciar sesión</a>
    </div>
  </>}</AuthShell>;
}
