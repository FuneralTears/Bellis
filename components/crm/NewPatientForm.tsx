"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { normalizeArgentinePhone } from "@/lib/market";
import { checkDuplicates, duplicateReason, type DuplicateCandidate, type DuplicateCheck } from "@/lib/patient-duplicates";

/** `phone` is already normalized; `email` and `note` are null when left empty. */
export type NewPatientValues = { firstName: string; lastName: string; phone: string; email: string | null; note: string | null };

const shortDate = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value)) : null;

/**
 * Manual patient form, shared by /pacientes and its demo. Presentation only: the host looks for existing
 * patients and saves. Same phone and same email means the person is already here: nothing is created and the
 * existing records are offered instead. Sharing only the phone or only the email warns and lets the person go on.
 * Records are never merged from here.
 */
export function NewPatientForm({ lookup, renderOpen, onSave, onCancel }: {
  /** Patients that share this phone or email. The host decides where they come from. */
  lookup: (phone: string, email: string | null) => Promise<DuplicateCandidate[]>;
  /** Wraps the action that opens an existing patient. `primary` is the main action of the form at that moment. */
  renderOpen: (patient: DuplicateCandidate, content: ReactNode, variant: "primary" | "link") => ReactNode;
  onSave: (values: NewPatientValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", email: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // What was found for these exact contact details. Cleared when the phone or the email changes.
  const [found, setFound] = useState<DuplicateCheck | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const set = (key: keyof typeof form, value: string) => {
    setForm({ ...form, [key]: value }); setError("");
    if (key === "phone" || key === "email") { setFound(null); setReviewing(false); }
  };
  const strong = found?.strong ?? null;
  const weak = strong ? [] : found?.weak ?? [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || strong) return;
    const phone = normalizeArgentinePhone(form.phone);
    const email = form.email.trim().toLowerCase() || null;
    if (!form.firstName.trim() || !form.lastName.trim()) { setError("Completá el nombre y el apellido."); return; }
    if (!phone) { setError("Ingresá un celular argentino válido, por ejemplo +54 9 11 1234 5678."); return; }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) { setError("Revisá el email o dejalo vacío."); return; }
    setBusy(true); setError("");
    try {
      if (!found) {
        const check = checkDuplicates({ phone, email }, await lookup(phone, email));
        if (check.strong || check.weak.length) { setFound(check); return; }
      }
      await onSave({ firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone, email, note: form.note.trim() || null });
    } catch (caught) { setError(caught instanceof Error && caught.message ? caught.message : "No pudimos guardar el paciente. Intentá de nuevo."); }
    finally { setBusy(false); }
  }

  return <section className="crm-card crm-form-card crm-new-patient" aria-labelledby="crm-new-patient-title">
    <div className="crm-card-head"><h2 id="crm-new-patient-title">Nuevo paciente</h2></div>
    <form onSubmit={(event) => void submit(event)} aria-busy={busy} noValidate>
      <div className="crm-form-grid">
        <label>Nombre<input autoFocus required maxLength={120} autoComplete="off" disabled={busy} value={form.firstName} onChange={(event) => set("firstName", event.target.value)}/></label>
        <label>Apellido<input required maxLength={120} autoComplete="off" disabled={busy} value={form.lastName} onChange={(event) => set("lastName", event.target.value)}/></label>
        <label>Teléfono<input required type="tel" inputMode="tel" autoComplete="off" placeholder="+54 9 11 1234 5678" disabled={busy} value={form.phone} onChange={(event) => set("phone", event.target.value)}/></label>
        <label><span>Email <span className="crm-optional">(opcional)</span></span><input type="email" inputMode="email" maxLength={255} autoComplete="off" disabled={busy} value={form.email} onChange={(event) => set("email", event.target.value)}/></label>
        <label className="crm-wide"><span>Nota interna <span className="crm-optional">(opcional)</span></span><textarea maxLength={5000} disabled={busy} placeholder="Solo la ve tu equipo. Por ejemplo: escribió por WhatsApp, prefiere turnos a la tarde." value={form.note} onChange={(event) => set("note", event.target.value)}/></label>
      </div>
      {strong && <div className="crm-duplicates" role="alert">
        <p><AlertTriangle size={16}/> <b>Encontramos fichas con este mismo teléfono y email.</b></p>
        <p className="crm-duplicates-count">{strong.records > 1 ? `${strong.records} fichas coinciden con este teléfono y email.` : "No hace falta crear otra: abrí la ficha que ya existe."} Si es otra persona, cambiá el teléfono o el email.</p>
        {(reviewing || strong.records === 1) && <ul>{strong.items.map((item) => <li key={item.id}><span><b>{item.full_name}</b><small>{[item.phone, item.email, shortDate(item.created_at) && `alta ${shortDate(item.created_at)}`].filter(Boolean).join(" · ")}</small></span>{strong.records > 1 && renderOpen(item, "Abrir ficha", "link")}</li>)}</ul>}
      </div>}
      {weak.length > 0 && <div className="crm-duplicates" role="alert">
        <p><AlertTriangle size={16}/> <b>{weak.length === 1 && weak[0].records === 1 ? "Ya hay un paciente con uno de estos datos." : "Ya hay pacientes con uno de estos datos."}</b> Revisá si es la misma persona antes de crear otro.</p>
        <ul>{weak.map((item) => <li key={item.id}><span><b>{item.full_name}</b><small>{[item.phone, item.email].filter(Boolean).join(" · ")} · {duplicateReason(item)}{item.records > 1 && ` · ${item.records} fichas con este teléfono y email; se abre la más reciente`}</small></span>{renderOpen(item, "Abrir ficha", "link")}</li>)}</ul>
      </div>}
      {error && <p className="live-error" role="alert">{error}</p>}
      <div className="crm-note-actions crm-new-patient-actions">
        {strong ? (strong.records === 1 ? renderOpen(strong, "Abrir ficha", "primary")
            : <button className="demo-primary" type="button" aria-expanded={reviewing} onClick={() => setReviewing(!reviewing)}>{reviewing ? "Ocultar fichas" : "Revisar fichas"}</button>)
          : <button className="demo-primary" type="submit" disabled={busy}>{busy ? "Guardando…" : weak.length ? "Crear de todos modos" : "Crear paciente"}</button>}
        <button className="live-secondary" type="button" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  </section>;
}
