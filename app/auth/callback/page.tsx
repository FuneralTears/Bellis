"use client";

import { useEffect, useRef } from "react";
import { completeGoogleSignIn } from "@/lib/auth/google";
import { AuthLoading, AuthShell } from "@/components/auth/AuthUi";

/**
 * Where Supabase returns the person after signing in with Google (identity only; Google Calendar comes back to
 * /google-calendar/callback, a different flow). The code is read once and taken out of the address bar at once; the
 * destination is decided by the account, never by the URL.
 */
export default function AuthCallback() {
  // The code works once: even if the effect runs twice, it is handed over once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    completeGoogleSignIn(query).then((outcome) => {
      window.location.replace("route" in outcome ? outcome.route : `/ingresar?google=${outcome.problem}`);
    });
  }, []);
  return <AuthShell><AuthLoading>Iniciando sesión con Google…</AuthLoading></AuthShell>;
}
