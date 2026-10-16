"use client";

import { useEffect, useRef, useState } from "react";
import { googleSignInAvailable, startGoogleSignIn } from "@/lib/auth/google";
import { googleSignInMessage, watchOAuthReturn, type OAuthReturnWatcher } from "@/lib/auth/google-flow";
import { GoogleSignInButton } from "./GoogleSignInButton";

/**
 * "Continuar con Google", for /ingresar and /registro: identity only, never Google Calendar. It is shown only when
 * this environment has Google enabled, so it never offers a button that cannot work. `note` is a short line under it.
 */
export default function GoogleSignIn({ note }: { note?: string }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const oauthReturn = useRef<OAuthReturnWatcher | null>(null);
  useEffect(() => {
    let active = true;
    googleSignInAvailable().then((value) => { if (active) setAvailable(value); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const watcher = watchOAuthReturn({
      windowTarget: window,
      documentTarget: document,
      isVisible: () => document.visibilityState === "visible",
      onReturn: () => setBusy(false),
    });
    oauthReturn.current = watcher;
    return () => { watcher.cleanup(); if (oauthReturn.current === watcher) oauthReturn.current = null; };
  }, []);
  if (!available) return null;
  const start = async () => {
    setBusy(true); setProblem(null);
    oauthReturn.current?.arm();
    const failed = await startGoogleSignIn();
    // On success the browser is already on its way to Google; only a failure comes back here.
    if (failed) { oauthReturn.current?.disarm(); setProblem(failed); setBusy(false); }
  };
  return <GoogleSignInButton busy={busy} note={note} message={googleSignInMessage(problem)} onClick={start} />;
}
