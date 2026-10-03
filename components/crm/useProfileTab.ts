"use client";

import { useEffect, useRef, useState } from "react";

export type ProfileTab = "resumen" | "seguimientos" | "turnos" | "cuestionarios";
const tabs: ProfileTab[] = ["resumen", "seguimientos", "turnos", "cuestionarios"];

function readUrl(): { tab: ProfileTab; followUpId: string | null } {
  if (typeof window === "undefined") return { tab: "resumen", followUpId: null };
  const followUpId = window.location.hash.startsWith("#seguimiento-") ? window.location.hash.slice("#seguimiento-".length) : null;
  const requested = new URLSearchParams(window.location.search).get("tab") as ProfileTab | null;
  // A follow-up link without a tab opens Seguimientos, where every follow-up is listed.
  return { tab: requested && tabs.includes(requested) ? requested : followUpId ? "seguimientos" : "resumen", followUpId };
}

/**
 * Keeps the patient record's tab and the follow-up in focus in the URL
 * (?tab=…#seguimiento-…), so Back, Forward and a reload return to the same
 * place instead of resetting to the top of Resumen. Navigation state only: it
 * never reads or writes patient data. `ready` is true once the cards are rendered.
 */
export function useProfileTab(ready: boolean) {
  const [state, setState] = useState(readUrl);
  // Where the reader was in Resumen before opening a follow-up from the timeline.
  const returnTo = useRef<number | null>(null);

  useEffect(() => {
    const onPop = () => {
      const next = readUrl();
      setState(next);
      if (next.tab === "resumen" && !next.followUpId && returnTo.current !== null) {
        const top = returnTo.current;
        returnTo.current = null;
        requestAnimationFrame(() => window.scrollTo({ top }));
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!ready || !state.followUpId) return;
    const frame = requestAnimationFrame(() => document.getElementById(`seguimiento-${state.followUpId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [ready, state]);

  const write = (tab: ProfileTab, followUpId: string | null, mode: "push" | "replace") => {
    const url = new URL(window.location.href);
    if (tab === "resumen") url.searchParams.delete("tab"); else url.searchParams.set("tab", tab);
    url.hash = followUpId ? `seguimiento-${followUpId}` : "";
    if (mode === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
  };

  return {
    tab: state.tab,
    /** Switching tabs is not a new page: it replaces the entry, so Back still leaves the record. */
    setTab: (tab: ProfileTab) => { write(tab, null, "replace"); setState({ tab, followUpId: null }); },
    /** Opens a follow-up from the timeline as its own entry: Back returns to the timeline. */
    showFollowUp: (followUpId: string) => {
      returnTo.current = window.scrollY;
      write("seguimientos", followUpId, "push");
      setState({ tab: "seguimientos", followUpId });
    },
    /** Call before leaving the record from a follow-up, so Back lands on that follow-up. */
    rememberFollowUp: (followUpId: string) => write(state.tab, followUpId, "replace"),
    /** Brings a follow-up back into view, e.g. after closing its edit form. */
    focusFollowUp: (followUpId: string) => setState({ tab: state.tab, followUpId }),
    /** Removes the record's entries from the URL; for hosts that are not a route (the demo). */
    clear: () => { const url = new URL(window.location.href); url.searchParams.delete("tab"); if (url.hash.startsWith("#seguimiento-")) url.hash = ""; window.history.replaceState(null, "", url); },
  };
}
