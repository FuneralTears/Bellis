"use client";

import { useEffect, useRef, useState } from "react";
import { amountText, describePaymentError, parseAmountMinor, paymentMethodLabels, paymentMethods, paymentProblem, type PaymentMethod } from "@/lib/manual-appointment";
import "@/components/agenda/manual-appointment.css";

/**
 * "Registrar pago" for an appointment the practice loaded and has not charged yet. Shared by the agenda, the
 * patient record and their demos. Presentation only: the host decides when to offer it (canRecordPayment) and
 * saves. It records a charge made outside Bellis; it is not a Mercado Pago payment and nothing is collected here.
 */
export function RecordOfflinePayment({ priceMinor, formatMoney, onSave }: {
  /** Price of the service: the suggested amount. */
  priceMinor: number;
  formatMoney: (minor: number) => string;
  /** Saves the charge. It throws with the server's message when it cannot. */
  onSave: (method: PaymentMethod, amountMinor: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [amount, setAmount] = useState(() => amountText(priceMinor));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The form opens under the button and can fall below the screen: it is brought into view when it opens.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) box.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [open]);

  async function save() {
    if (busy) return;
    const problem = paymentProblem({ paid: true, method, amount });
    const amountMinor = parseAmountMinor(amount);
    if (problem || !method || amountMinor === null) { setError(problem ?? "Revisá el cobro."); return; }
    setBusy(true); setError("");
    // On success the host reloads and this stops being offered. Double clicks are ignored while it saves.
    try { await onSave(method, amountMinor); setOpen(false); }
    catch (caught) { setError(describePaymentError(caught instanceof Error ? caught.message : String(caught)).text); }
    finally { setBusy(false); }
  }

  if (!open) return <button type="button" className="crm-btn rop-open" onClick={() => { setOpen(true); setError(""); }}>Registrar pago</button>;
  return <div ref={box} className="ma rop" role="group" aria-label="Registrar pago">
    <div className="ma-methods" role="radiogroup" aria-label="Medio de cobro">{paymentMethods.map((item) => <button key={item} type="button" role="radio" aria-checked={method === item} className={method === item ? "on" : ""} disabled={busy} onClick={() => { setMethod(item); setError(""); }}>{paymentMethodLabels[item]}</button>)}</div>
    <label className="ma-field">Importe cobrado (ARS)<input inputMode="decimal" autoComplete="off" disabled={busy} value={amount} onChange={(event) => { setAmount(event.target.value); setError(""); }}/></label>
    <p className="ma-hint">Se registra como cobrado fuera de Bellis; no es un pago de Mercado Pago. Precio del servicio: {formatMoney(priceMinor)}.</p>
    {error && <p className="live-error" role="alert">{error}</p>}
    <div className="rop-actions">
      <button type="button" className="demo-primary" disabled={busy} aria-busy={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar cobro"}</button>
      <button type="button" className="live-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>
    </div>
  </div>;
}
