"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Eye, FileQuestion, Pencil, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QuestionnaireFlow, type PatientDraft } from "../profesional/ana-lopez/questionnaire-flow";
import { DEFAULT_SECTION_LABELS, SECTION_KEYS, STARTER_SPECIALTIES, activeQuestions, starterQuestionnaire, type QuestionType, type Questionnaire, type QuestionnaireAnswers, type QuestionnaireQuestion, type SectionKey } from "@/lib/questionnaires/model";
import "../profesional/ana-lopez/profile.css";
import "./questionnaire-builder.css";

const TYPES: [QuestionType, string][] = [
  ["single_choice", "Selección única"], ["multiple_choice", "Selección múltiple"], ["text", "Texto corto"],
  ["long_text", "Texto largo"], ["number", "Número"], ["yes_no", "Sí / No"], ["scale", "Escala"], ["date", "Fecha"],
];
const OPTION_TYPES = new Set<QuestionType>(["single_choice", "multiple_choice"]);
export type QuestionnaireServiceOption = { id: string; name: string };
const SERVICE_OPTIONS: QuestionnaireServiceOption[] = [{ id: "service-0", name: "Consulta psicológica" }, { id: "service-1", name: "Primera consulta" }];
const EMPTY_PATIENT: PatientDraft = { firstName: "", lastName: "", email: "", phone: "" };

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
  const questionnaire = questionnaires[serviceId];
  const saveToSupabase = async () => { if (!onSave || !questionnaire) return; setSaving(true); setSaveStatus(""); try { const next = await onSave(questionnaire); setQuestionnaires(next); setServiceId((questionnaire.serviceIds ?? [serviceId])[0]); setSaveStatus("Formulario guardado para los servicios seleccionados."); } catch (error) { setSaveStatus(error instanceof Error ? error.message : "No pudimos guardar el formulario."); } finally { setSaving(false); } };

  const updateQuestionnaire = (updated: Questionnaire) => setQuestionnaires((current) => ({ ...current, [serviceId]: updated }));
  const editQuestion = (question: QuestionnaireQuestion) => { setEditing({ ...question, options: [...question.options] }); setEditorError(""); };
  const saveQuestion = () => {
    if (!editing) return;
    if (!editing.title.trim()) { setEditorError("Escribí la pregunta antes de continuar."); return; }
    if (!questionnaire.questions.some((question) => question.id === editing.id) && questionnaire.questions.length >= 50) { setEditorError("El formulario admite hasta 50 preguntas."); return; }
    const options = OPTION_TYPES.has(editing.type) ? editing.options.map((item) => item.trim()).filter(Boolean) : [];
    if (OPTION_TYPES.has(editing.type) && options.length < 2) { setEditorError("Agregá al menos dos opciones."); return; }
    const nextQuestion = { ...editing, title: editing.title.trim(), options };
    const exists = questionnaire.questions.some((question) => question.id === nextQuestion.id);
    updateQuestionnaire({ ...questionnaire, questions: exists ? questionnaire.questions.map((question) => question.id === nextQuestion.id ? nextQuestion : question) : [...questionnaire.questions, nextQuestion] });
    setEditing(null);
  };
  const removeQuestion = (id: string) => updateQuestionnaire({ ...questionnaire, questions: questionnaire.questions.filter((question) => question.id !== id).map((question, order) => ({ ...question, order })) });
  const duplicateQuestion = (question: QuestionnaireQuestion) => { if (questionnaire.questions.length >= 50) { setSaveStatus("El formulario admite hasta 50 preguntas."); return; } updateQuestionnaire({ ...questionnaire, questions: [...questionnaire.questions, { ...question, id: crypto.randomUUID(), options: [...question.options], title: `${question.title} (copia)`, order: questionnaire.questions.length }] }); };
  const toggleQuestion = (id: string, field: "active" | "required") => updateQuestionnaire({ ...questionnaire, questions: questionnaire.questions.map((question) => question.id === id ? { ...question, [field]: !question[field] } : question) });
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
  const applyStarter = (name: string) => { setSpecialty(name); const starter = starterQuestionnaire(serviceId, name); updateQuestionnaire({ ...starter, id: questionnaire.id, title: questionnaire.title, serviceIds: questionnaire.serviceIds ?? [serviceId] }); setSaveStatus("Plantilla aplicada. Revisá las preguntas antes de guardar."); };
  const createForm = () => { const next = starterQuestionnaire(serviceId, specialty); updateQuestionnaire({ ...next, id: crypto.randomUUID(), title: "Nuevo formulario", serviceIds: [serviceId], questions: next.questions.map((question) => ({ ...question, id: crypto.randomUUID() })) }); setPreview(false); setSaveStatus("Nuevo formulario listo para editar. Guardalo para publicarlo en los servicios elegidos."); };
  const updateOption = (index: number, value: string) => setEditing((current) => current && ({ ...current, options: current.options.map((option, position) => position === index ? value : option) }));
  const removeOption = (index: number) => setEditing((current) => current && ({ ...current, options: current.options.filter((_, position) => position !== index) }));
  const moveOption = (index: number, direction: -1 | 1) => setEditing((current) => { if (!current) return current; const to = index + direction; if (to < 0 || to >= current.options.length) return current; const options = [...current.options]; [options[index], options[to]] = [options[to], options[index]]; return { ...current, options }; });

  return <>
    <div className="demo-title-row"><div><p className="demo-date">ANTES DEL TURNO</p><h1>Formularios de preconsulta</h1><p>Creá preguntas propias para conocer a cada paciente antes de atender.</p></div><button className="demo-primary" onClick={createForm}><Plus size={17}/> Crear formulario</button></div>
    <div className="builder-notice">{onSave ? "Los cambios se publican al tocar Guardar formulario. Se conserva la versión anterior para el historial de respuestas." : <>Vista de demostración: podés editar y probar el formulario. <a href="/dashboard/questionnaires">Ingresá para guardar el tuyo.</a></>}</div>
    <div className="builder-toolbar demo-panel"><label>Editar formulario de<Select value={serviceId} onValueChange={(value) => { setServiceId(value); setPreview(false); setPreviewDone(false); setSaveStatus(""); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{serviceOptions.map((service) => <SelectItem key={service.id} value={service.id}>{service.name}</SelectItem>)}</SelectContent></Select></label><label>Usar plantilla de<Select value={specialty} onValueChange={applyStarter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STARTER_SPECIALTIES.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></label><button className="builder-preview-button" onClick={() => { setPreview(true); setPreviewDone(false); setPreviewAnswers({}); setPreviewPatient(EMPTY_PATIENT); }}><Eye size={17}/> Vista previa</button>{onSave && <button className="demo-primary" onClick={saveToSupabase} disabled={saving}>{saving ? "Guardando…" : "Guardar formulario"}</button>}</div>
    <div className="builder-details demo-panel"><label>Nombre del formulario<Input value={questionnaire.title} maxLength={120} onChange={(event) => updateQuestionnaire({ ...questionnaire, title: event.target.value })} placeholder="Ej.: Preconsulta inicial" /></label><div><strong>Asociar a servicios</strong><p>Al guardar, este formulario se aplica a los servicios seleccionados.</p><div className="builder-services">{serviceOptions.map((service) => <label key={service.id}><input type="checkbox" checked={(questionnaire.serviceIds ?? [serviceId]).includes(service.id)} onChange={(event) => { const selected = questionnaire.serviceIds ?? [serviceId]; const serviceIds = event.target.checked ? [...selected, service.id] : selected.filter((id) => id !== service.id); updateQuestionnaire({ ...questionnaire, serviceIds }); }} />{service.name}</label>)}</div></div></div>
    {saveStatus && <p className="builder-save-status" role="status">{saveStatus}</p>}
    {preview ? <div className="builder-preview"><div className="builder-preview-head"><div><strong>Vista del paciente</strong><span>{activeQuestions(questionnaire).length} preguntas · {serviceOptions.find((item) => item.id === serviceId)?.name}</span></div><button onClick={() => setPreview(false)}>Volver al constructor</button></div>{previewDone ? <div className="demo-panel builder-preview-done"><FileQuestion size={25}/><h2>Recorrido completado</h2><p>Las respuestas permanecen en esta vista de ejemplo hasta recargar. Ningún dato se envió a Supabase.</p><button onClick={() => { setPreviewAnswers({}); setPreviewPatient(EMPTY_PATIENT); setPreviewDone(false); }}>Probar de nuevo</button></div> : <QuestionnaireFlow questionnaire={questionnaire} initialAnswers={previewAnswers} initialPatient={previewPatient} onAnswersChange={setPreviewAnswers} onPatientChange={setPreviewPatient} onBack={() => setPreview(false)} onComplete={() => setPreviewDone(true)} />}</div> : <div className="builder-sections">{SECTION_KEYS.map((key) => {
      const section = questionnaire.sections.find((item) => item.key === key);
      const questions = questionnaire.questions.filter((question) => question.section === key).sort((a, b) => a.order - b.order);
      return <section className="demo-panel builder-section" key={key}><div className="builder-section-head"><span className="builder-section-index">{SECTION_KEYS.indexOf(key) + 1}</span><div><span className="builder-stage-name">{DEFAULT_SECTION_LABELS[key]}</span><label>Nombre visible de la sección<Input aria-label={`Nombre visible de ${DEFAULT_SECTION_LABELS[key]}`} value={section?.label ?? DEFAULT_SECTION_LABELS[key]} onChange={(event) => changeSectionLabel(key, event.target.value)} /></label></div></div><div className="builder-questions">{questions.length ? questions.map((question) => <div className={question.active ? "builder-question" : "builder-question inactive"} key={question.id}><div className="builder-question-icon"><FileQuestion size={19}/></div><div className="builder-question-copy"><strong>{question.title}</strong><span>{TYPES.find(([type]) => type === question.type)?.[1]} · {question.required ? "Obligatoria" : "Opcional"} · {question.active ? "Activa" : "Inactiva"}</span><div className="builder-quick-toggles"><label><input type="checkbox" checked={question.required} onChange={() => toggleQuestion(question.id, "required")} /> Obligatoria</label><label><input type="checkbox" checked={question.active} onChange={() => toggleQuestion(question.id, "active")} /> Activa</label></div></div><div className="builder-question-actions"><button aria-label={`Subir ${question.title}`} title="Subir" disabled={questions[0].id === question.id} onClick={() => moveQuestion(question.id, -1)}><ArrowUp size={16}/></button><button aria-label={`Bajar ${question.title}`} title="Bajar" disabled={questions[questions.length - 1].id === question.id} onClick={() => moveQuestion(question.id, 1)}><ArrowDown size={16}/></button><button aria-label={`Duplicar ${question.title}`} title="Duplicar" onClick={() => duplicateQuestion(question)}><Copy size={16}/></button><button aria-label={`Editar ${question.title}`} title="Editar" onClick={() => editQuestion(question)}><Pencil size={16}/></button><button aria-label={`Eliminar ${question.title}`} title="Eliminar" onClick={() => removeQuestion(question.id)}><Trash2 size={16}/></button></div></div>) : <p className="builder-empty">Todavía no hay preguntas en esta sección.</p>}</div><button className="builder-add-section" onClick={() => editQuestion({ ...newQuestion(questionnaire), section: key })}><Plus size={16}/> Agregar pregunta</button></section>;
    })}</div>}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}><DialogContent className="sm:max-w-[570px] max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{questionnaire.questions.some((question) => question.id === editing?.id) ? "Editar pregunta" : "Nueva pregunta"}</DialogTitle></DialogHeader>{editing && <div className="builder-editor"><label>Sección<Select value={editing.section} onValueChange={(value) => setEditing({ ...editing, section: value as SectionKey })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SECTION_KEYS.map((key) => <SelectItem key={key} value={key}>{questionnaire.sections.find((item) => item.key === key)?.label || DEFAULT_SECTION_LABELS[key]}</SelectItem>)}</SelectContent></Select></label><label>Título de la pregunta<Input value={editing.title} maxLength={500} onChange={(event) => setEditing({ ...editing, title: event.target.value })} placeholder="¿Qué te gustaría contarnos?" /></label><label>Descripción opcional<Input value={editing.description} maxLength={2000} onChange={(event) => setEditing({ ...editing, description: event.target.value })} placeholder="Una breve ayuda para responder" /></label><label>Tipo de respuesta<Select value={editing.type} onValueChange={(value) => setEditing({ ...editing, type: value as QuestionType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TYPES.map(([type, label]) => <SelectItem key={type} value={type}>{label}</SelectItem>)}</SelectContent></Select></label>{OPTION_TYPES.has(editing.type) && <div className="builder-option-editor"><strong>Opciones</strong>{editing.options.map((option, index) => <div className="builder-option-row" key={index}><Input aria-label={`Opción ${index + 1}`} value={option} onChange={(event) => updateOption(index, event.target.value)} /><button aria-label={`Subir opción ${index + 1}`} disabled={index === 0} onClick={() => moveOption(index, -1)}><ArrowUp size={15}/></button><button aria-label={`Bajar opción ${index + 1}`} disabled={index === editing.options.length - 1} onClick={() => moveOption(index, 1)}><ArrowDown size={15}/></button><button aria-label={`Eliminar opción ${index + 1}`} onClick={() => removeOption(index)}><Trash2 size={15}/></button></div>)}<button className="builder-add-section" disabled={editing.options.length >= 20} onClick={() => setEditing({ ...editing, options: [...editing.options, `Opción ${editing.options.length + 1}`] })}><Plus size={16}/> Agregar opción</button></div>}<label className="builder-switch-row">Respuesta obligatoria<Switch checked={editing.required} onCheckedChange={(required) => setEditing({ ...editing, required })} /></label><label className="builder-switch-row">Pregunta activa<Switch checked={editing.active} onCheckedChange={(active) => setEditing({ ...editing, active })} /></label>{editorError && <p className="builder-error" role="alert">{editorError}</p>}<button className="demo-primary" onClick={saveQuestion}>Aplicar pregunta</button></div>}</DialogContent></Dialog>
  </>;
}
