"use client";

import { useEffect, useRef, useState } from "react";
import { completeGoogleSignIn } from "@/lib/auth/google";
import { googleSignInMessage, type GoogleSignInProblem } from "@/lib/auth/google-flow";
import { AuthHeading, AuthLoading, AuthMessage, AuthShell } from "@/components/auth/AuthUi";

/**
 * Where Supabase returns the person after signing in with Google (identity only; Google Calendar comes back to
 * /google-calendar/callback, a different flow). The code is read once and taken out of the address bar at once; the
 * destination is decided by the account, never by the URL.
 */
export default function AuthCallback() {
  // The code works once: even if the effect runs twice, it is handed over once.
  const started = useRef(false);
  const [problem, setProblem] = useState<GoogleSignInProblem | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    completeGoogleSignIn(query).then((outcome) => {
      if ("route" in outcome) window.location.replace(outcome.route);
      else setProblem(outcome.problem);
    });
  }, []);
  const message = problem ? googleSignInMessage(problem) : null;
  return <AuthShell>{message ? <>
    <AuthHeading title="No pudimos completar el inicio de sesión">Tu cuenta no se modificó.</AuthHeading>
    <AuthMessage tone={message.tone}>{message.text}</AuthMessage>
    <a className="auth-button" href="/ingresar">Volver a iniciar sesión</a>
  </> : <AuthLoading>Iniciando sesión con Google…</AuthLoading>}</AuthShell>;
}
