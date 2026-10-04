"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { OnboardingDone, OnboardingShell, OnboardingSteps, type OnboardingForm } from "@/components/onboarding/OnboardingUi";
import "../auth/auth-demo.css";

/**
 * Showroom of /onboarding. Same screens and copy as the product, but nothing is saved:
 * no Supabase, no session, and finishing only moves local state.
 */

type View = 1 | 2 | "done";
const views: { key: View; label: string }[] = [
  { key: 1, label: "Tu consulta" },
  { key: 2, label: "Tus horarios" },
  { key: "done", label: "Listo" },
];

export default function OnboardingDemo() {
  const [view, setView] = useState<View>(1);
  const [days, setDays] = useState([true, true, true, true, true, false, false]);
  const [form, setForm] = useState<OnboardingForm>({ service: "Consulta inicial", description: "", price: "25000", duration: "60", mode: "Online", start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00", notice: "24", buffer: "15" });
  const [error, setError] = useState("");
  const go = (next: View) => { setError(""); setView(next); };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (view === 1) { go(2); return; }
    if (!days.some(Boolean)) { setError("Elegí al menos un día de atención."); return; }
    go("done");
  };

  return <div className="auth-demo">
    <nav className="auth-demo-bar" aria-label="Pantallas de primeros pasos de la demo">
      <Link className="auth-demo-back" href="/demo"><ArrowLeft size={16} aria-hidden /> Volver a la demo</Link>
      <div className="auth-demo-tabs">{views.map(({ key, label }) => <button key={key} type="button" aria-current={view === key ? "page" : undefined} onClick={() => go(key)}>{label}</button>)}</div>
      <p className="auth-demo-note"><span>Demo interactiva</span> No se guarda nada: los datos son de ejemplo.</p>
    </nav>
    <OnboardingShell>
      {view === "done" ? <OnboardingDone form={form} days={days} actions={<>
        <Link className="auth-button" href="/demo">Ir a mi panel</Link>
        <button type="button" className="auth-link" onClick={() => go(1)}>Demo: volver a empezar</button>
      </>} /> : <OnboardingSteps step={view} form={form} days={days} busy={false} error={error} onSubmit={submit}
        onField={(key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        onToggleDay={(index) => setDays((current) => current.map((active, position) => index === position ? !active : active))}
        onBack={() => go(1)} />}
    </OnboardingShell>
  </div>;
}
