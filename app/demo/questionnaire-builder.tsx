"use client";

import { useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, CircleCheck, Copy, Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Tag } from "@/components/crm/CrmUi";
import { QuestionnaireFlow, type PatientDraft } from "../profesional/ana-lopez/questionnaire-flow";
import { DEFAULT_SECTION_LABELS, SECTION_KEYS, STARTER_SPECIALTIES, activeQuestions, conditionOperators, starterQuestionnaire, validateConditions, type AnswerValue, type ConditionOperator, type QuestionCondition, type QuestionType, type Questionnaire, type QuestionnaireAnswers, type QuestionnaireQuestion, type SectionKey } from "@/lib/questionnaires/model";
import "@/components/booking/booking.css";
import "./questionnaire-builder.css";

// Visible names only: the stored type values stay as they are.
const TYPES: [QuestionType, string][] = [
  ["single_choice", "Elegir una opción"], ["multiple_choice", "Elegir varias opciones"], ["text", "Texto corto"],
  ["long_text", "Texto largo"], ["number", "Número"], ["yes_no", "Sí / No"], ["scale", "Escala del 1 al 5"], ["date", "Fecha"],
];
const typeLabel = (type: QuestionType) => TYPES.find(([value]) => value === type)?.[1] ?? "";
const OPTION_TYPES = new Set<QuestionType>(["single_choice", "multiple_choice"]);
export type QuestionnaireServiceOption = { id: string; name: string };
const SERVICE_OPTIONS: QuestionnaireServiceOption[] = [{ id: "service-0", name: "Consulta psicológica" }, { id: "service-1", name: "Primera consulta" }];
const EMPTY_PATIENT: PatientDraft = { firstName: "", lastName: "", email: "", phone: "" };
// How each comparison reads in a sentence about the patient. The operators themselves are not changed.
const OPERATOR_LABELS: Record<ConditionOperator, string> = { equals: "respondió", not_equals: "no respondió", contains: "escribió algo que contiene", includes: "eligió", greater_than: "respondió más de", less_than: "respondió menos de" };
const isSavedId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
/** A condition as a sentence, for the question list and the editor. `source` is the question it depends on. */
function conditionSentence(condition: QuestionCondition, source?: QuestionnaireQuestion): string {
  if (!source) return "Depende de una pregunta que ya no está disponible.";
  const answer = source.type === "yes_no" ? (condition.value === true ? "Sí" : "No") : String(condition.value);
  return `${condition.action === "show" ? "Se muestra" : "Se oculta"} si en «${source.title}» el paciente ${OPERATOR_LABELS[condition.operator]} «${answer}».`;
}

function newQuestion(questionnaire: Questionnaire): QuestionnaireQuestion {
  return {
    id: crypto.randomUUID(), questionnaireId: questionnaire.id, section: "situation", title: "", description: "",
    type: "single_choice", options: ["Opción 1", "Opción 2"], required: true, order: questionnaire.questions.length, active: true,
  };
}

export function QuestionnaireBuilder({ serviceOptions = SERVICE_OPTIONS, initialQuestionnaires, onSave }: { serviceOptions?: QuestionnaireServiceOption[]; initialQuestionnaires?: Record<string, Questionnaire>; onSave?: (questionnaire: Questionnaire) => Promise<Record<string, Questionnaire>> } = {}) {
  const [serviceId, setServiceId] = useState(serviceOptions[0]?.id ?? "");
  const [questionnaires, setQuestionnaires] = useState<Record<string, Questionnaire>>(() => initialQuestionnaires ?? Object.fromEntries(serviceOptions.map((service) => [service.id, starterQuestionnaire(service.id)])));
  const [editing, setEditing] = useState<QuestionnaireQuestion | null>(null);
  const [specialty, setSpecialty] = useState("Psicología");
  const [preview, setPreview] = useState(false);
  const [previewAnswers, setPreviewAnswers] = useState<QuestionnaireAnswers>({});
  const [previewPatient, setPreviewPatient] = useState<PatientDraft>(EMPTY_PATIENT);
  const [previewDone, setPreviewDone] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);
  // Presentation state: which forms have edits not saved yet, how the last message should look, and what is open.
  const [dirtyIds, setDirtyIds] = useState<string[]>([]);
  const [statusTone, setStatusTone] = useState<"info" | "ok" | "error">("info");
  const [justSaved, setJustSaved] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>(() => Object.values(initialQuestionnaires ?? {}).map((item) => item.id).filter(isSavedId));
  const [removing, setRemoving] = useState<QuestionnaireQuestion | null>(null);
  const [renaming, setRenaming] = useState<SectionKey | null>(null);
  const [more, setMore] = useState(false);
  const [pendingStarter, setPendingStarter] = useState<string | null>(null);
  const questionnaire = questionnaires[serviceId];
  const saveToSupabase = async () => { if (!onSave || !questionnaire) return; setSaving(true); setSaveStatus(""); try { const next = await onSave(questionnaire); setQuestionnaires(next); setServiceId((questionnaire.serviceIds ?? [serviceId])[0]); setSaveStatus("Guardado. Ya se usa en las consultas que elegiste."); setStatusTone("ok"); setDirtyIds([]); setJustSaved(true); setSavedIds(Object.values(next).map((item) => item.id).filter(isSavedId)); } catch (error) { setSaveStatus(error instanceof Error ? error.message : "No pudimos guardar la preconsulta."); setStatusTone("error"); } finally { setSaving(false); } };
  // The showroom has no backend: saving only settles the "unsaved changes" mark for this visit.
  const saveInDemo = () => { setDirtyIds((ids) => ids.filter((id) => id !== serviceId)); setJustSaved(true); setSaveStatus("Guardado solo en esta demo. No se envió nada."); setStatusTone("ok"); };

  const updateQuestionnaire = (updated: Questionnaire) => { setQuestionnaires((current) => ({ ...current, [serviceId]: updated })); setDirtyIds((ids) => ids.includes(serviceId) ? ids : [...ids, serviceId]); setJustSaved(false); if (statusTone !== "info") { setSaveStatus(""); setStatusTone("info"); } };
  const editQuestion = (question: QuestionnaireQuestion) => { setEditing({ ...question, options: [...question.options], conditions: [...(question.conditions ?? [])] }); setEditorError(""); setMore(!!question.description || !question.active); };
  const saveQuestion = () => {
    if (!editing) return;
    if (!editing.title.trim()) { setEditorError("Escribí la pregunta antes de continuar."); return; }
    if (!questionnaire.questions.some((question) => question.id === editing.id) && questionnaire.questions.length >= 50) { setEditorError("La preconsulta admite hasta 50 preguntas."); return; }
    const options = OPTION_TYPES.has(editing.type) ? editing.options.map((item) => item.trim()).filter(Boolean) : [];
    if (OPTION_TYPES.has(editing.type) && options.length < 2) { setEditorError("Agregá al menos dos opciones."); return; }
    const nextQuestion = { ...editing, title: editing.title.trim(), options };
    const exists = questionnaire.questions.some((question) => question.id === nextQuestion.id);
    const nextForm = { ...questionnaire, questions: exists ? questionnaire.questions.map((question) => question.id === nextQuestion.id ? nextQuestion : question) : [...questionnaire.questions, nextQuestion] };
    const conditionError = validateConditions(nextForm);
    if (conditionError) { setEditorError(conditionError); return; }
    updateQuestionnaire(nextForm);
    setEditing(null);
  };
  const removeQuestion = (id: string) => updateQuestionnaire({ ...questionnaire, questions: questionnaire.questions.filter((question) => question.id !== id).map((question, order) => ({ ...question, order, conditions: (question.conditions ?? []).filter((condition) => condition.questionId !== id) })) });
  const duplicateQuestion = (question: QuestionnaireQuestion) => { if (questionnaire.questions.length >= 50) { setSaveStatus("La preconsulta admite hasta 50 preguntas."); setStatusTone("error"); return; } updateQuestionnaire({ ...questionnaire, questions: [...questionnaire.questions, { ...question, id: crypto.randomUUID(), options: [...question.options], conditions: (question.conditions ?? []).map((condition) => ({ ...condition, id: crypto.randomUUID() })), title: `${question.title} (copia)`, order: questionnaire.questions.length }] }); };
  const moveQuestion = (id: string, direction: -1 | 1) => {
    const target = questionnaire.questions.find((question) => question.id === id);
    if (!target) return;
    const list = questionnaire.questions.filter((question) => question.section === target.section).sort((a, b) => a.order - b.order);
    const from = list.findIndex((question) => question.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    const positions = questionnaire.questions.map((question, index) => ({ question, index })).filter(({ question }) => question.section === target.section).sort((a, b) => a.question.order - b.question.order).map(({ index }) => index);
    const next = [...questionnaire.questions];
    positions.forEach((position, index) => { next[position] = { ...list[index], order: position }; });
    updateQuestionnaire({ ...questionnaire, questions: next });
  };
  const changeSectionLabel = (key: SectionKey, label: string) => updateQuestionnaire({ ...questionnaire, sections: questionnaire.sections.map((section) => section.key === key ? { ...section, label } : section) });
  const applyStarter = (name: string) => { setSpecialty(name); const starter = starterQuestionnaire(serviceId, name); updateQuestionnaire({ ...starter, id: questionnaire.id, title: questionnaire.title, serviceIds: questionnaire.serviceIds ?? [serviceId] }); setSaveStatus("Cargamos las preguntas sugeridas. Revisalas antes de guardar."); };
  const createForm = () => { const next = starterQuestionnaire(serviceId, specialty); const id = crypto.randomUUID(); const ids = new Map(next.questions.map((question) => [question.id, crypto.randomUUID()])); updateQuestionnaire({ ...next, id, title: "Nueva preconsulta", serviceIds: [serviceId], questions: next.questions.map((question) => ({ ...question, id: ids.get(question.id)!, questionnaireId: id, conditions: (question.conditions ?? []).map((condition) => ({ ...condition, id: crypto.randomUUID(), questionId: ids.get(condition.questionId)! })) })) }); setPreview(false); setSaveStatus("Nueva preconsulta lista para editar. Cuando la guardes, va a reemplazar a la actual en las consultas que elijas."); };
  const updateOption = (index: number, value: string) => setEditing((current) => current && ({ ...current, options: current.options.map((option, position) => position === index ? value : option) }));
  const removeOption = (index: number) => setEditing((current) => current && ({ ...current, options: current.options.filter((_, position) => position !== index) }));
  const moveOption = (index: number, direction: -1 | 1) => setEditing((current) => { if (!current) return current; const to = index + direction; if (to < 0 || to >= current.options.length) return current; const options = [...current.options]; [options[index], options[to]] = [options[to], options[index]]; return { ...current, options }; });

  // One entry per form: services that share a form are listed together. Derived for display only.
  const forms = serviceOptions.reduce<{ id: string; serviceId: string; title: string; services: string[]; questions: number }[]>((list, service) => {
    const form = questionnaires[service.id];
    if (!form) return list;
    const found = list.find((item) => item.id === form.id);
    if (found) found.services.push(service.name);
    else list.push({ id: form.id, serviceId: service.id, title: form.title, services: [service.name], questions: form.questions.filter((question) => question.active).length });
    return list;
  }, []);
  const selectForm = (id: string) => { setServiceId(id); setPreview(false); setPreviewDone(false); setSaveStatus(""); setStatusTone("info"); setJustSaved(false); };
  const startPreview = () => { setPreview(true); setPreviewDone(false); setPreviewAnswers({}); setPreviewPatient(EMPTY_PATIENT); };
  const ordered = [...questionnaire.questions].sort((a, b) => SECTION_KEYS.indexOf(a.section) - SECTION_KEYS.indexOf(b.section) || a.order - b.order);
  const selectedServices = questionnaire.serviceIds ?? [serviceId];
  const dirty = dirtyIds.includes(serviceId);
  const state = saving ? <Tag tone="blue">Guardando…</Tag> : dirty ? <Tag tone="orange">Hay cambios sin guardar</Tag> : justSaved ? <Tag tone="sage" icon={Check}>Guardado</Tag> : onSave && !savedIds.includes(questionnaire.id) ? <Tag tone="orange">Todavía sin guardar</Tag> : null;
  const saveButton = <button className="demo-primary" onClick={onSave ? saveToSupabase : saveInDemo} disabled={saving}>{saving ? "Guardando…" : "Guardar cambios"}</button>;
  // A stored form, or the example one in the showroom, is what the button would replace.
  const replacesExisting = !onSave || savedIds.includes(questionnaire.id);
  const editingIsNew = !questionnaire.questions.some((question) => question.id === editing?.id);

  return <div className="crm-main builder-root">
    {!preview && <><PageHeader title="Formularios de preconsulta" description="Creá las preguntas que tus pacientes responderán antes de reservar."><button className="crm-btn" onClick={createForm}><Plus size={15}/> {replacesExisting ? "Reemplazar preconsulta de este servicio" : "Preparar preconsulta para este servicio"}</button></PageHeader>
    <p className="builder-help">Cada servicio usa una preconsulta. Al elegir otra, reemplazás la actual. Ahora estás en {serviceOptions.find((item) => item.id === serviceId)?.name}.</p>
    {!onSave && <p className="builder-notice">Vista de demostración: podés editar y probar todo, y nada se guarda de verdad. <a href="/dashboard/questionnaires">Ingresá para crear la tuya.</a></p>}

    <section className="builder-forms" aria-label="Tus preconsultas">
      <h2>Tus preconsultas</h2>
      <div>{forms.map((form) => <button type="button" key={form.id} className={form.id === questionnaire.id ? "builder-form on" : "builder-form"} aria-pressed={form.id === questionnaire.id} onClick={() => selectForm(form.serviceId)}>
        <strong>{form.title.trim() || "Preconsulta sin nombre"}</strong>
        <span>{form.questions} {form.questions === 1 ? "pregunta" : "preguntas"} · Se usa en {form.services.join(", ")}</span>
      </button>)}</div>
    </section>

    <div className="crm-card builder-current">
      <div><span>Estás editando</span><h2>{questionnaire.title.trim() || "Preconsulta sin nombre"}</h2>{state}</div>
      <div className="builder-current-actions"><button className="crm-btn" onClick={startPreview}><Eye size={15}/> Vista previa</button>{saveButton}</div>
      {onSave && <p className="builder-current-note">Los cambios se aplican cuando tocás Guardar cambios. Las respuestas que ya recibiste no se modifican.</p>}
    </div>
    {saveStatus && <p className={`builder-save-status is-${statusTone}`} role={statusTone === "error" ? "alert" : "status"}>{saveStatus}</p>}</>}

    {preview ? <div className="builder-preview">
      <button className="builder-link" onClick={() => setPreview(false)}><ArrowLeft size={15}/> Volver a editar</button>
      <div className="builder-preview-head"><h2>Vista del paciente</h2><span>Así lo va a ver tu paciente en {serviceOptions.find((item) => item.id === serviceId)?.name}. Podés recorrerla sin guardar respuestas.</span></div>
      {previewDone ? <div className="crm-card builder-preview-done"><CircleCheck size={26}/><h2>Recorrido completado</h2><p>Así termina la preconsulta para tu paciente. Las respuestas de esta prueba no se guardaron ni se enviaron.</p><button className="crm-btn" onClick={() => { setPreviewAnswers({}); setPreviewPatient(EMPTY_PATIENT); setPreviewDone(false); }}>Probar de nuevo</button></div>
        : <QuestionnaireFlow questionnaire={questionnaire} initialAnswers={previewAnswers} initialPatient={previewPatient} onAnswersChange={setPreviewAnswers} onPatientChange={setPreviewPatient} onBack={() => setPreview(false)} onComplete={() => setPreviewDone(true)} demoNote="Vista previa · las respuestas no se guardan." />}
    </div> : <>
      <section className="crm-card builder-block">
        <div className="builder-block-head"><b>1</b><div><h2>Datos de la preconsulta</h2></div></div>
        <label className="builder-field">Nombre<Input value={questionnaire.title} maxLength={120} onChange={(event) => updateQuestionnaire({ ...questionnaire, title: event.target.value })} placeholder="Ej.: Preconsulta inicial" /><small>Solo lo vas a ver vos.</small></label>
      </section>

      <section className="crm-card builder-block">
        <div className="builder-block-head"><b>2</b><div><h2>Preguntas</h2><p>Tu paciente las responde de a una, en este orden.</p></div></div>
        <label className="builder-field builder-starter">Usar preguntas sugeridas para<Select value={specialty} onValueChange={setPendingStarter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STARTER_SPECIALTIES.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select><small>Reemplazan las preguntas actuales por un modelo que después podés cambiar. Te pedimos confirmación antes.</small></label>
        {!ordered.length ? <div className="builder-empty"><p>Esta preconsulta todavía no tiene preguntas.</p><button className="demo-primary" onClick={() => editQuestion({ ...newQuestion(questionnaire), section: SECTION_KEYS[0] })}><Plus size={16}/> Agregar primera pregunta</button></div> : <div className="builder-parts">{SECTION_KEYS.map((key, part) => {
          const section = questionnaire.sections.find((item) => item.key === key);
          const label = section?.label ?? DEFAULT_SECTION_LABELS[key];
          const questions = ordered.filter((question) => question.section === key);
          return <div className="builder-part" key={key}>
            <div className="builder-part-head">
              {renaming === key ? <label>Título de la parte {part + 1}<Input autoFocus aria-label={`Título de la parte ${part + 1}`} value={label} onChange={(event) => changeSectionLabel(key, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setRenaming(null); }} /><small>Sirve para ordenar tus preguntas. Si lo cambiás, tu paciente lo ve arriba de cada pregunta de esta parte.</small></label> : <h3>Parte {part + 1}<span>{label}</span></h3>}
              <button className="builder-link" onClick={() => setRenaming(renaming === key ? null : key)}>{renaming === key ? "Listo" : "Cambiar título"}</button>
            </div>
            {questions.length ? <ol className="builder-questions">{questions.map((question) => {
              const conditions = question.conditions ?? [];
              return <li className={question.active ? "builder-question" : "builder-question inactive"} key={question.id}>
                <b className="builder-question-number">{ordered.indexOf(question) + 1}</b>
                <div className="builder-question-copy">
                  <strong>{question.title}</strong>
                  <div className="builder-question-meta"><span>{typeLabel(question.type)}</span><span>{question.required ? "Obligatoria" : "Opcional"}</span>{!question.active && <Tag>Desactivada</Tag>}</div>
                  {conditions.length > 0 && <p className="builder-question-condition">{conditionSentence(conditions[0], questionnaire.questions.find((item) => item.id === conditions[0].questionId))}{conditions.length > 1 ? ` Y ${conditions.length - 1} ${conditions.length === 2 ? "condición más" : "condiciones más"}.` : ""}</p>}
                </div>
                <div className="builder-question-actions">
                  <button className="builder-edit" onClick={() => editQuestion(question)} aria-label={`Editar ${question.title}`}><Pencil size={14}/> Editar</button>
                  <button aria-label={`Subir ${question.title}`} title="Subir" disabled={questions[0].id === question.id} onClick={() => moveQuestion(question.id, -1)}><ArrowUp size={16}/></button>
                  <button aria-label={`Bajar ${question.title}`} title="Bajar" disabled={questions[questions.length - 1].id === question.id} onClick={() => moveQuestion(question.id, 1)}><ArrowDown size={16}/></button>
                  <button aria-label={`Duplicar ${question.title}`} title="Duplicar" onClick={() => duplicateQuestion(question)}><Copy size={16}/></button>
                  <button aria-label={`Eliminar ${question.title}`} title="Eliminar" onClick={() => setRemoving(question)}><Trash2 size={16}/></button>
                </div>
              </li>;
            })}</ol> : <p className="builder-part-empty">Todavía no hay preguntas en esta parte.</p>}
            <button className="builder-link" onClick={() => editQuestion({ ...newQuestion(questionnaire), section: key })}><Plus size={15}/> Agregar pregunta</button>
          </div>;
        })}</div>}
      </section>

      <section className="crm-card builder-block">
        <div className="builder-block-head"><b>3</b><div><h2>¿En qué consultas querés usar esta preconsulta?</h2><p>Elegí en qué servicios se va a mostrar. Tu paciente la completa antes de reservar.</p></div></div>
        <div className="builder-services">{serviceOptions.map((service) => { const checked = selectedServices.includes(service.id); return <label key={service.id} className={checked ? "on" : ""}><input type="checkbox" checked={checked} onChange={(event) => { const selected = questionnaire.serviceIds ?? [serviceId]; const serviceIds = event.target.checked ? [...selected, service.id] : selected.filter((id) => id !== service.id); updateQuestionnaire({ ...questionnaire, serviceIds }); }} /><span>{service.name}</span></label>; })}</div>
        <div className="builder-foot">{state}<button className="crm-btn" onClick={startPreview}><Eye size={15}/> Vista previa</button>{saveButton}</div>
      </section>
    </>}

    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}><DialogContent className="builder-dialog sm:max-w-[570px] max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{editingIsNew ? "Nueva pregunta" : "Editar pregunta"}</DialogTitle></DialogHeader>{editing && <div className="builder-editor">
      <label>Pregunta<Input value={editing.title} maxLength={500} onChange={(event) => setEditing({ ...editing, title: event.target.value })} placeholder="¿Qué te gustaría contarnos?" /></label>
      <label>Tipo de respuesta<Select value={editing.type} onValueChange={(value) => setEditing({ ...editing, type: value as QuestionType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TYPES.map(([type, label]) => <SelectItem key={type} value={type}>{label}</SelectItem>)}</SelectContent></Select></label>
      {OPTION_TYPES.has(editing.type) && <div className="builder-option-editor"><strong>Opciones para elegir</strong>{editing.options.map((option, index) => <div className="builder-option-row" key={index}><Input aria-label={`Opción ${index + 1}`} value={option} onChange={(event) => updateOption(index, event.target.value)} /><button aria-label={`Subir opción ${index + 1}`} disabled={index === 0} onClick={() => moveOption(index, -1)}><ArrowUp size={15}/></button><button aria-label={`Bajar opción ${index + 1}`} disabled={index === editing.options.length - 1} onClick={() => moveOption(index, 1)}><ArrowDown size={15}/></button><button aria-label={`Eliminar opción ${index + 1}`} onClick={() => removeOption(index)}><Trash2 size={15}/></button></div>)}<button className="builder-link" disabled={editing.options.length >= 20} onClick={() => setEditing({ ...editing, options: [...editing.options, `Opción ${editing.options.length + 1}`] })}><Plus size={15}/> Agregar opción</button></div>}
      <label className="builder-switch-row"><span>Respuesta obligatoria<small>El paciente tendrá que responder antes de continuar.</small></span><Switch checked={editing.required} onCheckedChange={(required) => setEditing({ ...editing, required })} /></label>
      <ConditionEditor questionnaire={questionnaire} question={editing} onChange={setEditing} />
      <button type="button" className="builder-more-toggle" aria-expanded={more} onClick={() => setMore(!more)}>Más opciones <ChevronDown size={15}/></button>
      {more && <div className="builder-more">
        <label>Texto de ayuda (opcional)<Input value={editing.description} maxLength={2000} onChange={(event) => setEditing({ ...editing, description: event.target.value })} placeholder="Una breve ayuda para responder" /><small>Aparece debajo de la pregunta.</small></label>
        <label>Parte de la preconsulta<Select value={editing.section} onValueChange={(value) => setEditing({ ...editing, section: value as SectionKey })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SECTION_KEYS.map((key, part) => <SelectItem key={key} value={key}>Parte {part + 1} · {questionnaire.sections.find((item) => item.key === key)?.label || DEFAULT_SECTION_LABELS[key]}</SelectItem>)}</SelectContent></Select></label>
        <label className="builder-switch-row"><span>Pregunta activa<small>Si la desactivás, tu paciente no la ve y no se pierde.</small></span><Switch checked={editing.active} onCheckedChange={(active) => setEditing({ ...editing, active })} /></label>
      </div>}
      {editorError && <p className="builder-error" role="alert">{editorError}</p>}
      <div className="builder-editor-actions"><button className="crm-btn" onClick={() => setEditing(null)}>Cancelar</button><button className="demo-primary" onClick={saveQuestion}>{editingIsNew ? "Agregar pregunta" : "Listo"}</button></div>
    </div>}</DialogContent></Dialog>

    <Dialog open={pendingStarter !== null} onOpenChange={(open) => { if (!open) setPendingStarter(null); }}><DialogContent className="builder-dialog sm:max-w-[420px]"><DialogHeader><DialogTitle>¿Usar las preguntas sugeridas?</DialogTitle></DialogHeader>{pendingStarter && <div className="builder-editor">
      <p className="builder-confirm">Esto reemplazará las preguntas que tenés ahora por las sugeridas para {pendingStarter}. Esta acción no se puede deshacer.</p>
      <div className="builder-editor-actions"><button className="crm-btn" onClick={() => setPendingStarter(null)}>Cancelar</button><button className="demo-primary builder-danger" onClick={() => { applyStarter(pendingStarter); setPendingStarter(null); }}>Reemplazar preguntas</button></div>
    </div>}</DialogContent></Dialog>

    <Dialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}><DialogContent className="builder-dialog sm:max-w-[420px]"><DialogHeader><DialogTitle>¿Eliminar esta pregunta?</DialogTitle></DialogHeader>{removing && <div className="builder-editor">
      <p className="builder-confirm">«{removing.title}»<br/>Esta acción no se puede deshacer.{questionnaire.questions.some((question) => (question.conditions ?? []).some((condition) => condition.questionId === removing.id)) ? " También se van a quitar las condiciones de otras preguntas que dependen de ella." : ""}</p>
      <div className="builder-editor-actions"><button className="crm-btn" onClick={() => setRemoving(null)}>Cancelar</button><button className="demo-primary builder-danger" onClick={() => { removeQuestion(removing.id); setRemoving(null); }}>Eliminar pregunta</button></div>
    </div>}</DialogContent></Dialog>
  </div>;
}

function defaultConditionValue(source: QuestionnaireQuestion): AnswerValue {
  if (source.type === "yes_no") return true;
  if (source.type === "number" || source.type === "scale") return 1;
  if (source.type === "single_choice" || source.type === "multiple_choice") return source.options[0] ?? "";
  return "";
}

function ConditionEditor({ questionnaire, question, onChange }: { questionnaire: Questionnaire; question: QuestionnaireQuestion; onChange: (question: QuestionnaireQuestion) => void }) {
  const candidates = activeQuestions(questionnaire).filter((candidate) => candidate.id !== question.id && (
    SECTION_KEYS.indexOf(candidate.section) < SECTION_KEYS.indexOf(question.section) ||
    candidate.section === question.section && candidate.order < question.order
  ));
  const conditions = question.conditions ?? [];
  const update = (id: string, patch: Partial<QuestionCondition>) => onChange({ ...question, conditions: conditions.map((condition) => condition.id === id ? { ...condition, ...patch } : condition) });
  const add = () => {
    const source = candidates[candidates.length - 1];
    if (!source) return;
    onChange({ ...question, conditions: [...conditions, { id: crypto.randomUUID(), questionId: source.id, operator: conditionOperators(source.type)[0], value: defaultConditionValue(source), action: "show" }] });
  };
  return <div className="builder-conditions"><div><strong>Mostrar según una respuesta</strong><p>{conditions.length ? "Esta pregunta solo aparecerá cuando se cumpla la condición." : "Por ahora la ven todos tus pacientes. Podés mostrarla solo a quienes den cierta respuesta."}</p></div>
    {conditions.map((condition) => {
      const source = candidates.find((candidate) => candidate.id === condition.questionId);
      const operators = source ? conditionOperators(source.type) : [];
      return <div className="builder-condition" key={condition.id}><div className="builder-condition-head"><Select value={condition.action} onValueChange={(action) => update(condition.id, { action: action as QuestionCondition["action"] })}><SelectTrigger aria-label="Qué hacer con esta pregunta"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="show">Mostrar esta pregunta solo si…</SelectItem><SelectItem value="hide">Ocultar esta pregunta si…</SelectItem></SelectContent></Select><button aria-label="Quitar condición" title="Quitar condición" onClick={() => onChange({ ...question, conditions: conditions.filter((item) => item.id !== condition.id) })}><Trash2 size={15}/></button></div>
        <label>En la pregunta<Select value={source?.id ?? ""} onValueChange={(id) => { const selected = candidates.find((candidate) => candidate.id === id); if (selected) update(condition.id, { questionId: id, operator: conditionOperators(selected.type)[0], value: defaultConditionValue(selected) }); }}><SelectTrigger><SelectValue placeholder="Elegí una pregunta anterior"/></SelectTrigger><SelectContent>{candidates.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.title}</SelectItem>)}</SelectContent></Select></label>
        <div className="builder-condition-grid"><label>El paciente{operators.length > 1 ? <Select value={condition.operator} onValueChange={(operator) => update(condition.id, { operator: operator as ConditionOperator })}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{operators.map((operator) => <SelectItem key={operator} value={operator}>{OPERATOR_LABELS[operator]}</SelectItem>)}</SelectContent></Select> : <span className="builder-static">{OPERATOR_LABELS[condition.operator]}</span>}</label>
          <label>Respuesta{source?.type === "single_choice" || source?.type === "multiple_choice" ? <Select value={String(condition.value)} onValueChange={(value) => update(condition.id, { value })}><SelectTrigger><SelectValue placeholder="Elegí una opción"/></SelectTrigger><SelectContent>{source.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select> : source?.type === "yes_no" ? <Select value={String(condition.value)} onValueChange={(value) => update(condition.id, { value: value === "true" })}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="true">Sí</SelectItem><SelectItem value="false">No</SelectItem></SelectContent></Select> : <Input aria-label="Respuesta que cumple la condición" type={source?.type === "number" || source?.type === "scale" ? "number" : source?.type === "date" ? "date" : "text"} value={String(condition.value)} onChange={(event) => update(condition.id, { value: source?.type === "number" || source?.type === "scale" ? event.target.value === "" ? "" : Number(event.target.value) : event.target.value })} placeholder="Escribí la respuesta" />}</label></div>
        <p className="builder-condition-sentence">{conditionSentence(condition, source)}</p>
      </div>;
    })}
    <button className="builder-link" disabled={!candidates.length || conditions.length >= 10} onClick={add}><Plus size={15}/> {conditions.length ? "Agregar otra condición" : "Mostrar esta pregunta solo si…"}</button>
    {conditions.length > 1 && <p className="builder-condition-hint">Con varias condiciones para mostrar, alcanza con que se cumpla una. Si alguna dice ocultar, la pregunta se oculta.</p>}
    {!candidates.length && <p className="builder-condition-hint">Para usar esto, la pregunta tiene que ir después de otra pregunta activa.</p>}
  </div>;
}
