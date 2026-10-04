"use client";

import { useEffect, useState } from "react";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { OnboardingBlocked, OnboardingDone, OnboardingLoading, OnboardingShell, OnboardingSteps, type OnboardingForm } from "@/components/onboarding/OnboardingUi";

export default function Onboarding() {
  const [step, setStep] = useState<1 | 2>(1);
  const [days, setDays] = useState([true, true, true, true, true, false, false]);
  const [form, setForm] = useState<OnboardingForm>({ service: "Consulta inicial", description: "", price: "25000", duration: "60", mode: "Online", start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00", notice: "24", buffer: "15" });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Presentation only: the save went through, so the last screen shows what was set up before going to the panel.
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    getSupabase().then(async (client) => {
      const { data, error: authError } = await client.auth.getUser();
      if (authError || !data.user) { window.location.replace("/ingresar"); return; }
      const destination = await landingRouteForUser(client, data.user.id);
      if (destination === "/dashboard") window.location.replace(destination);
      else if (active) setReady(true);
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "No pudimos abrir tu espacio."); });
    return () => { active = false; };
  }, []);

  const field = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    if (step === 1) { setStep(2); return; }
    if (!days.some(Boolean)) { setError("Elegí al menos un día de atención."); return; }
    setBusy(true);
    try {
      const client = await getSupabase();
      const { data } = await client.auth.getUser();
      if (!data.user) { window.location.replace("/ingresar"); return; }
      const { error: saveError } = await client.rpc("complete_bellis_onboarding", { p_document: { ...form, days } });
      if (saveError) throw saveError;
      setDone(true);
    } catch (caught) {
      // The save answers with a plain { message } object, not an Error. The message is a short code: it picks the wording and is never shown.
      const message = String((caught as { message?: unknown } | null)?.message ?? "");
      setError(message.includes("invalid_break") ? "El descanso debe estar dentro del horario de atención." :
        message.includes("invalid_hours") ? "Revisá el horario: el fin tiene que ser posterior al inicio." :
        message.includes("invalid_service") ? "Revisá los datos de tu consulta en el paso anterior: nombre, precio y duración." :
        message.includes("invalid_days") ? "Elegí al menos un día de atención." :
        message.includes("authentication_required") ? "Tu sesión venció. Volvé a iniciar sesión." :
        "No pudimos guardar estos datos. Intentá nuevamente.");
    } finally { setBusy(false); }
  };

  const signOut = async () => { const client = await getSupabase(); await client.auth.signOut(); window.location.replace("/ingresar"); };

  return <OnboardingShell action={<button type="button" className="onb-signout" onClick={signOut}>Cerrar sesión</button>}>
    {error && !ready ? <OnboardingBlocked message={error} />
      : !ready ? <OnboardingLoading />
      : done ? <OnboardingDone form={form} days={days} actions={<a className="auth-button" href="/dashboard">Ir a mi panel</a>} />
      : <OnboardingSteps step={step} form={form} days={days} busy={busy} error={error} onField={field} onSubmit={submit}
          onToggleDay={(index) => setDays((current) => current.map((active, position) => index === position ? !active : active))}
          onBack={() => { setError(""); setStep(1); }} />}
  </OnboardingShell>;
}
