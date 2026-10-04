"use client";

import BellisLogo from "@/components/brand/BellisLogo";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { QuestionnaireBuilder } from "../demo/questionnaire-builder";
import { getSupabase } from "@/lib/supabase/browser";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { loadProfessionalForms, saveProfessionalQuestionnaire, type ProfessionalForms } from "@/lib/questionnaires/supabase";
import type { Questionnaire } from "@/lib/questionnaires/model";
import "../demo/demo.css";
import "./forms.css";

/** The forms workspace. `embedded` drops its own page chrome so it can live inside the app shell. */
export function FormsWorkspace({ embedded = false }: { embedded?: boolean }) {
  const [forms, setForms] = useState<ProfessionalForms | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const client = await getSupabase();
        const { data, error: authError } = await client.auth.getUser();
        if (authError || !data.user) {
          window.location.replace("/ingresar");
          return;
        }
        if (await landingRouteForUser(client, data.user.id) === "/onboarding") {
          window.location.replace("/onboarding");
          return;
        }
        const result = await loadProfessionalForms(client, data.user.id);
        if (active) setForms(result);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "No pudimos cargar tus formularios.");
      }
    })();
    return () => { active = false; };
  }, []);
  const save = async (questionnaire: Questionnaire) => {
    const client = await getSupabase();
    await saveProfessionalQuestionnaire(client, questionnaire);
    const { data, error: authError } = await client.auth.getUser();
    if (authError || !data.user) throw new Error("Tu sesión venció. Volvé a ingresar.");
    const refreshed = await loadProfessionalForms(client, data.user.id);
    setForms(refreshed);
    return refreshed.questionnaires;
  };
  const signOut = async () => {
    const client = await getSupabase();
    const { error: signOutError } = await client.auth.signOut();
    if (signOutError) { setError("No pudimos cerrar la sesión. Intentá nuevamente."); return; }
    setForms(null);
    window.location.replace("/ingresar");
  };
  // Having no services yet is not a failure: it is the step before the first preconsultation.
  const content = error === "Tu espacio todavía no tiene servicios activos." ? <div className="live-form-message" role="status"><h1>Todavía no hay servicios disponibles para asignar</h1><p>Una preconsulta se usa en una o más de tus consultas. Creá primero un servicio y volvé para armarla.</p><a href="/dashboard?section=Servicios">Ir a Servicios</a></div> : error ? <div className="live-form-message" role="alert"><h1>No pudimos abrir tus preconsultas</h1><p>{error}</p><a href="/ingresar">Volver a ingresar</a></div> : !forms ? <div className="live-form-message" role="status">Cargando tus preconsultas…</div> : <QuestionnaireBuilder serviceOptions={forms.services} initialQuestionnaires={forms.questionnaires} onSave={save} />;
  if (embedded) return content;
  return <main className="live-form-shell"><header className="live-form-header"><a className="brand" href="/"><BellisLogo /></a><div><span>{forms?.professionalName ?? "Mi espacio"}</span>{forms && <button onClick={signOut}>Cerrar sesión</button>}</div></header><div className="live-form-main"><div className="live-form-intro"><span>ESPACIO PROFESIONAL</span><a href="/dashboard">Volver al panel <ArrowRight size={15}/></a></div>{content}</div></main>;
}
