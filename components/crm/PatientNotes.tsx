"use client";

import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { noteTypeLabels, type Note, type NoteType } from "@/app/pacientes/timeline";
import { Tag, type Tone } from "./CrmUi";

/**
 * Internal notes of a patient record. Presentation and form state only, shared by
 * /pacientes/[id] and the /demo showroom: callers own the data and pass the handlers.
 * `onSave` and `onDelete` reject when the change was not stored; the form stays open to retry.
 */

export type NoteDraft = { id?: string; note_type: NoteType; content: string };
const noteTones: Record<NoteType, Tone> = { general: "neutral", follow_up: "blue", administrative: "lilac", payment: "orange" };
const noteTypes = Object.keys(noteTypeLabels) as NoteType[];
const emptyDraft: NoteDraft = { note_type: "general", content: "" };

export function PatientNotes({ notes, authorName, formatAt, canManage, onSave, onDelete }: {
  notes: Note[];
  authorName: (note: Note) => string;
  formatAt: (iso: string) => string;
  canManage: (note: Note) => boolean;
  onSave: (draft: NoteDraft) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  // `open` is "new", the id of the note being edited, or null when no form is shown.
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft>(emptyDraft);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<NoteType | "all">("all");

  const usedTypes = noteTypes.filter((type) => notes.some((note) => note.note_type === type));
  // Falls back to every note when the last note of the filtered type is gone.
  const active = filter !== "all" && usedTypes.includes(filter) ? filter : "all";
  const visible = active === "all" ? notes : notes.filter((note) => note.note_type === active);
  const start = (note?: Note) => { setOpen(note?.id ?? "new"); setDraft(note ? { id: note.id, note_type: note.note_type, content: note.content } : emptyDraft); setRemoving(null); setError(""); };
  const close = () => { setOpen(null); setRemoving(null); setError(""); };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !draft.content.trim()) return;
    setBusy(true); setError("");
    try {
      await onSave({ ...draft, content: draft.content.trim() });
      // A new note of another type would be hidden by the active filter.
      if (active !== "all" && active !== draft.note_type) setFilter("all");
      setOpen(null);
    } catch { setError("No pudimos guardar la nota. Revisá tu conexión e intentá de nuevo."); } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onDelete(id); setRemoving(null); }
    catch { setError("No pudimos eliminar la nota. Intentá de nuevo."); } finally { setBusy(false); }
  }

  const form = <form className="crm-activity-form crm-note-form" onSubmit={(event) => void save(event)} aria-busy={busy}>
    <div className="crm-form-grid"><label>Tipo<select value={draft.note_type} disabled={busy} onChange={(event) => setDraft({ ...draft, note_type: event.target.value as NoteType })}>{noteTypes.map((type) => <option key={type} value={type}>{noteTypeLabels[type]}</option>)}</select></label>
    <label className="crm-wide">Nota<textarea required maxLength={5000} autoFocus disabled={busy} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })}/></label></div>
    {error && <p className="live-error" role="alert">{error}</p>}
    <div className="crm-note-actions"><button className="demo-primary" type="submit" disabled={busy || !draft.content.trim()}>{busy ? "Guardando…" : error ? "Reintentar" : "Guardar"}</button><button className="live-secondary" type="button" disabled={busy} onClick={close}>Cancelar</button></div>
  </form>;

  return <section className="crm-card">
    <div className="crm-card-head"><div><h2>Notas</h2><p>Internas: las ve solo tu equipo, nunca el paciente.</p></div>{open !== "new" && <button className="crm-btn" onClick={() => start()}><Plus size={15}/> Agregar nota</button>}</div>
    {open === "new" && form}
    {usedTypes.length > 1 && <div className="crm-chips crm-note-filter" role="group" aria-label="Filtrar notas por tipo">{(["all", ...usedTypes] as const).map((type) => <button key={type} aria-pressed={active === type} className={active === type ? "on" : ""} onClick={() => setFilter(type)}>{type === "all" ? "Todas" : noteTypeLabels[type]}</button>)}</div>}
    {visible.length ? <div className="crm-notes">{visible.map((note) => open === note.id ? <article className="crm-note-editing" key={note.id}>{form}</article> : <article className="crm-note" key={note.id}>
      <div className="crm-note-head"><Tag tone={noteTones[note.note_type]}>{noteTypeLabels[note.note_type]}</Tag>{canManage(note) && <span className="crm-note-tools"><button disabled={busy} onClick={() => start(note)}><Pencil size={14}/> Editar</button><button disabled={busy} onClick={() => { setOpen(null); setRemoving(note.id); setError(""); }}><Trash2 size={14}/> Eliminar</button></span>}</div>
      <p>{note.content}</p>
      <small>{authorName(note)} · {formatAt(note.created_at)}{note.updated_at !== note.created_at ? " · Editada" : ""}</small>
      {removing === note.id && <div className="crm-note-confirm" role="group" aria-label="Confirmar eliminación">
        <span>¿Eliminar esta nota? No se puede deshacer.</span>
        {error && <p className="live-error" role="alert">{error}</p>}
        <div className="crm-note-tools"><button className="crm-note-danger" disabled={busy} onClick={() => void remove(note.id)}>{busy ? "Eliminando…" : error ? "Reintentar" : "Sí, eliminar"}</button><button disabled={busy} onClick={close}>Cancelar</button></div>
      </div>}
    </article>)}</div> : open !== "new" && <p className="live-empty">Todavía no hay notas para este paciente.</p>}
  </section>;
}
