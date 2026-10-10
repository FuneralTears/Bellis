"use client";

import { useEffect, useRef, useState } from "react";
import { amountText, cancelArgs, cancelQuestion, describeCancelError, paymentMethodLabels, paymentMethods, paymentProblem, type CancelArgs, type PaymentMethod } from "@/lib/manual-appointment";
import "@/components/agenda/manual-appointment.css";

/**
 * "Cancelar turno" for an appointment the practice loaded. Shared by the agenda, the patient record and their
 * demos. Presentation only: the host decides when to offer it (canCancelAppointment) and saves.
 * With no charge on record it asks what happened with it; with one, it says the charge is kept. Nothing is ever
 * refunded or deleted here, and no notice is sent.
 */
export function CancelManualAppointment({ charge, priceMinor, formatMoney, onCancel }: {
  /** The charge already recorded, as shown in the detail ("Transferencia · $24.500"), or null when there is none. */
  charge: string | null;
  /** Price of the service: the suggested amount when the cancelled appointment is charged anyway. */
  priceMinor: number;
  formatMoney: (minor: number) => string;
  /** Cancels. It throws with the server's message when it cannot. */
  onCancel: (args: CancelArgs) => Promise<void>;
}) {
  const [step, setStep] = useState<"closed" | "question" | "charge">("closed");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [amount, setAmount] = useState(() => amountText(priceMinor));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  // If the charge shows up while this is open (someone recorded it first), the question no longer applies.
  const view = step === "closed" ? "closed" : cancelQuestion(charge !== null) === "confirm_paid" ? "paid" : step;
  useEffect(() => { if (view !== "closed") box.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [view]);

  async function cancel(withCharge: boolean) {
    if (busy) return;
    const problem = withCharge ? paymentProblem({ paid: true, method, amount }) : null;
    const args = cancelArgs({ charge: withCharge, method, amount });
    if (problem || !args) { setError(problem ?? "Revisá el cobro."); return; }
    setBusy(true); setError("");
    // On success the host reloads and this stops being offered. Double clicks are ignored while it saves.
    try { await onCancel(args); setStep("closed"); }
    catch (caught) { setError(describeCancelError(caught instanceof Error ? caught.message : String(caught)).text); }
    finally { setBusy(false); }
  }
  const back = <button type="button" className="live-secondary" disabled={busy} onClick={() => { setStep(view === "charge" ? "question" : "closed"); setError(""); }}>Volver</button>;

  if (view === "closed") return <button type="button" className="crm-btn rop-open cma-open" onClick={() => { setStep("question"); setError(""); }}>Cancelar turno</button>;
  return <div ref={box} className="ma rop cma" role="group" aria-label="Cancelar turno">
    {view === "paid" && <>
      <p className="cma-title">Este turno ya tiene un cobro registrado.</p>
      <p className="cma-charge">Cobro: <b>{charge}</b></p>
      <p className="ma-hint">Al cancelar, el cobro queda guardado tal como está: no se borra ni se devuelve. El horario vuelve a quedar libre.</p>
      {error && <p className="live-error" role="alert">{error}</p>}
      <div className="rop-actions">
        <button type="button" className="demo-primary cma-danger" disabled={busy} aria-busy={busy} onClick={() => void cancel(false)}>{busy ? "Cancelando…" : "Cancelar turno"}</button>
        {back}
      </div>
    </>}
    {view === "question" && <>
      <p className="cma-title">¿Qué pasó con el cobro de este turno?</p>
      <p className="ma-hint">En los dos casos el turno queda cancelado y el horario vuelve a quedar libre.</p>
      {error && <p className="live-error" role="alert">{error}</p>}
      <div className="cma-choices">
        <button type="button" className="cma-choice" disabled={busy} aria-busy={busy} onClick={() => void cancel(false)}>
          <b>{busy ? "Cancelando…" : "Cancelar sin cobrar"}</b><small>No se cobró nada por este turno.</small>
        </button>
        <button type="button" className="cma-choice" disabled={busy} onClick={() => { setStep("charge"); setError(""); }}>
          <b>Cancelar y registrar pago</b><small>Se cobró igual. Por ejemplo, si avisaron tarde.</small>
        </button>
      </div>
      <div className="rop-actions">{back}</div>
    </>}
    {view === "charge" && <>
      <p className="cma-title">¿Cómo se cobró?</p>
      <div className="ma-methods" role="radiogroup" aria-label="Medio de cobro">{paymentMethods.map((item) => <button key={item} type="button" role="radio" aria-checked={method === item} className={method === item ? "on" : ""} disabled={busy} onClick={() => { setMethod(item); setError(""); }}>{paymentMethodLabels[item]}</button>)}</div>
      <label className="ma-field">Importe cobrado (ARS)<input inputMode="decimal" autoComplete="off" disabled={busy} value={amount} onChange={(event) => { setAmount(event.target.value); setError(""); }}/></label>
      <p className="ma-hint">Se registra como cobrado fuera de Bellis; no es un pago de Mercado Pago. Precio del servicio: {formatMoney(priceMinor)}.</p>
      {error && <p className="live-error" role="alert">{error}</p>}
      <div className="rop-actions">
        <button type="button" className="demo-primary cma-danger" disabled={busy} aria-busy={busy} onClick={() => void cancel(true)}>{busy ? "Cancelando…" : "Cancelar turno y guardar cobro"}</button>
        {back}
      </div>
    </>}
  </div>;
}
