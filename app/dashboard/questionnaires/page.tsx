"use client";

import { useEffect, useState } from "react";
import CrmShell from "../../pacientes/CrmShell";
import { errorMessage, loadCrmContext, type CrmContext } from "../../pacientes/crm";
import { FormsWorkspace } from "../../mis-formularios/FormsWorkspace";

/** Formularios inside the app shell: same sidebar, topbar and mobile navigation as every private route. */
export default function QuestionnairesPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  useEffect(() => { let cancelled = false;
    // Only feeds the shell (name, bell). The workspace below loads and guards its own data.
    loadCrmContext().then((next) => { if (!cancelled) setContext(next); }).catch((caught) => {
      const message = errorMessage(caught);
      if (message === "onboarding_required") window.location.replace("/onboarding");
      else if (message.includes("sesión")) window.location.replace("/ingresar");
    });
    return () => { cancelled = true; };
  }, []);
  return <CrmShell context={context} breadcrumb="Formularios"><FormsWorkspace embedded /></CrmShell>;
}
