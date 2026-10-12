"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../pacientes/CrmShell";
import { errorMessage, loadCrmContext, type CrmContext } from "../pacientes/crm";
import { PageHeader } from "@/components/crm/CrmUi";
import { ProOverview } from "@/components/plan/PlanUi";

/**
 * Bellis Pro: what the workspace has today, what Pro adds and how to ask for it. Nothing is charged here and
 * there is no checkout: "Quiero Bellis Pro" leaves a request on the server and someone writes back.
 */
export default function BellisProPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  const [canRequest, setCanRequest] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { let cancelled = false;
    async function load() {
      try {
        const next = await loadCrmContext();
        const client = await getSupabase();
        const { data: auth } = await client.auth.getUser();
        const { data: member } = await client.from("workspace_members").select("role").eq("workspace_id", next.workspaceId).eq("user_id", auth.user?.id ?? "").maybeSingle();
        if (!cancelled) { setContext(next); setCanRequest(member?.role === "owner" || member?.role === "admin"); }
      } catch (caught) {
        const message = errorMessage(caught);
        if (message === "onboarding_required") window.location.replace("/onboarding");
        else if (message.includes("sesión")) window.location.replace("/ingresar");
        else if (!cancelled) setError("No pudimos cargar tu plan. Intentá de nuevo.");
      }
    }
    void load(); return () => { cancelled = true; };
  }, []);

  // The server keeps one open request per workspace: asking again returns that one.
  async function request() {
    const client = await getSupabase();
    const { data, error: requestError } = await client.rpc("request_pro_upgrade", { p_workspace: context!.workspaceId });
    if (requestError) throw new Error(requestError.message);
    return (data ?? {}) as { created?: boolean };
  }

  return <CrmShell context={context} breadcrumb="Bellis Pro">
    <PageHeader title="Bellis Pro" description="Bellis Free organiza tu agenda y tus pacientes. Bellis Pro te ayuda a hacer seguimiento, automatizar y cobrar con menos trabajo manual." />
    {error && <p className="live-error" role="alert">{error}</p>}
    {!context && !error ? <p className="live-empty" role="status">Cargando tu plan…</p>
      : context && <ProOverview key={context.access?.tier ?? "none"} access={context.access} canRequest={canRequest} onRequest={request} />}
  </CrmShell>;
}
