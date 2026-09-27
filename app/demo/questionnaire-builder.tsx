"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, FileQuestion, Pencil, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

export function QuestionnaireBuilder({ serviceOptions = SERVICE_OPTIONS, initialQuestionnaires, onSave }: { serviceOptions?: QuestionnaireServiceOption[]; initialQuestionnaires?: Record<string, Questionnaire>; onSave?: (questionnaire: Questionnaire) => Promise<void> } = {}) {
  const [serviceId, setServiceId] = useState(serviceOptions[0]?.id ?? "");
  const [questionnaires, setQuestionnaires] = useState<Record<string, Questionnaire>>(() => initialQuestionnaires ?? Object.fromEntries(serviceOptions.map((service) => [service.id, starterQuestionnaire(service.id)])));
  const [editing, setEditing] = useState<QuestionnaireQuestion | null>(null);
  const [optionText, setOptionText] = useState("");
  const [specialty, setSpecialty] = useState("Psicología");
  const [preview, setPreview] = useState(false);
  const [previewAnswers, setPreviewAnswers] = useState<QuestionnaireAnswers>({});
  const [previewPatient, setPreviewPatient] = useState<PatientDraft>(EMPTY_PATIENT);
  const [previewDone, setPreviewDone] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const questionnaire = questionnaires[serviceId];
  const saveToSupabase = async () => { if (!onSave || !questionnaire) return; setSaving(true); setSaveStatus(""); try { await onSave(questionnaire); setSaveStatus("Formulario guardado en Supabase."); } catch (error) { setSaveStatus(error instanceof Error ? error.message : "No pudimos guardar el formulario."); } finally { setSaving(false); } };

  const updateQuestionnaire = (updated: Questionnaire) => setQuestionnaires((current) => ({ ...current, [serviceId]: updated }));
  const editQuestion = (question: QuestionnaireQuestion) => { setEditing({ ...question, options: [...question.options] }); setOptionText(question.options.join("\n")); setEditorError(""); };
  const saveQuestion = () => {
    if (!editing) return;
    if (!editing.title.trim()) { setEditorError("Escribí la pregunta antes de continuar."); return; }
    const options = OPTION_TYPES.has(editing.type) ? optionText.split("\n").map((item) => item.trim()).filter(Boolean) : [];
    if (OPTION_TYPES.has(editing.type) && options.length < 2) { setEditorError("Agregá al menos dos opciones, una por línea."); return; }
    const nextQuestion = { ...editing, title: editing.title.trim(), options };
    const exists = questionnaire.questions.some((question) => question.id === nextQuestion.id);
    updateQuestionnaire({ ...questionnaire, questions: exists ? questionnaire.questions.map((question) => question.id === nextQuestion.id ? nextQuestion : question) : [...questionnaire.questions, nextQuestion] });
    setEditing(null);
  };
  const removeQuestion = (id: string) => updateQuestionnaire({ ...questionnaire, questions: questionnaire.questions.filter((question) => question.id !== id).map((question, order) => ({ ...question, order })) });
  const moveQuestion = (id: string, direction: -1 | 1) => {
    const list = [...questionnaire.questions].sort((a, b) => a.order - b.order);
    const from = list.findIndex((question) => question.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    updateQuestionnaire({ ...questionnaire, questions: list.map((question, order) => ({ ...question, order })) });
  };
  const changeSectionLabel = (key: SectionKey, label: string) => updateQuestionnaire({ ...questionnaire, sections: questionnaire.sections.map((section) => section.key === key ? { ...section, label } : section) });
  const applyStarter = (name: string) => { setSpecialty(name); updateQuestionnaire(starterQuestionnaire(serviceId, name)); };

  return <>
    <div className="demo-title-row"><div><p className="demo-date">ANTES DEL TURNO</p><h1>Formularios de preconsulta</h1><p>Configurá preguntas breves para cada servicio.</p></div><button className="demo-primary" onClick={() => editQuestion(newQuestion(questionnaire))}><Plus size={17}/> Nueva pregunta</button></div>
    <div className="builder-notice">{onSave ? "Los cambios se guardan cuando tocás Guardar formulario. La vista previa no guarda respuestas de pacientes." : <>Vista de demostración: podés editar y probar el formulario. <a href="/mis-formularios">Ingresá para guardar el tuyo en Supabase.</a></>}</div>
    <div className="builder-toolbar demo-panel"><label>Servicio<Select value={serviceId} onValueChange={(value) => { setServiceId(value); setPreview(false); setPreviewDone(false); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{serviceOptions.map((service) => <SelectItem key={service.id} value={service.id}>{service.name}</SelectItem>)}</SelectContent></Select></label><label>Plantilla inicial<Select value={specialty} onValueChange={applyStarter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STARTER_SPECIALTIES.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></label><button className="builder-preview-button" onClick={() => { setPreview(true); setPreviewDone(false); }}><Eye size={17}/> Probar formulario</button>{onSave && <button className="demo-primary" onClick={saveToSupabase} disabled={saving}>{saving ? "Guardando…" : "Guardar formulario"}</button>}</div>
    {saveStatus && <p className="builder-save-status" role="status">{saveStatus}</p>}
    {preview ? <div className="builder-preview"><div className="builder-preview-head"><div><strong>Vista del paciente</strong><span>{activeQuestions(questionnaire).length} preguntas · {serviceOptions.find((item) => item.id === serviceId)?.name}</span></div><button onClick={() => setPreview(false)}>Volver al constructor</button></div>{previewDone ? <div className="demo-panel builder-preview-done"><FileQuestion size={25}/><h2>Recorrido completado</h2><p>Las respuestas permanecen en esta vista de ejemplo hasta recargar. Ningún dato se envió a Supabase.</p><button onClick={() => { setPreviewAnswers({}); setPreviewPatient(EMPTY_PATIENT); setPreviewDone(false); }}>Probar de nuevo</button></div> : <QuestionnaireFlow questionnaire={questionnaire} initialAnswers={previewAnswers} initialPatient={previewPatient} onAnswersChange={setPreviewAnswers} onPatientChange={setPreviewPatient} onBack={() => setPreview(false)} onComplete={() => setPreviewDone(true)} />}</div> : <div className="builder-sections">{SECTION_KEYS.map((key) => {
      const section = questionnaire.sections.find((item) => item.key === key);
      const questions = questionnaire.questions.filter((question) => question.section === key).sort((a, b) => a.order - b.order);
      return <section className="demo-panel builder-section" key={key}><div className="builder-section-head"><span className="builder-section-index">{SECTION_KEYS.indexOf(key) + 1}</span><div><label>Nombre visible de la sección<Input aria-label={`Nombre visible de ${key}`} value={section?.label ?? DEFAULT_SECTION_LABELS[key]} onChange={(event) => changeSectionLabel(key, event.target.value)} /></label></div></div><div className="builder-questions">{questions.length ? questions.map((question) => <div className="builder-question" key={question.id}><div className="builder-question-icon"><FileQuestion size={19}/></div><div className="builder-question-copy"><strong>{question.title}</strong><span>{TYPES.find(([type]) => type === question.type)?.[1]} · {question.required ? "Obligatoria" : "Opcional"} · {question.active ? "Activa" : "Inactiva"}</span></div><div className="builder-question-actions"><button aria-label="Subir pregunta" title="Subir" onClick={() => moveQuestion(question.id, -1)}><ArrowUp size={16}/></button><button aria-label="Bajar pregunta" title="Bajar" onClick={() => moveQuestion(question.id, 1)}><ArrowDown size={16}/></button><button aria-label="Editar pregunta" title="Editar" onClick={() => editQuestion(question)}><Pencil size={16}/></button><button aria-label="Eliminar pregunta" title="Eliminar" onClick={() => removeQuestion(question.id)}><Trash2 size={16}/></button></div></div>) : <p className="builder-empty">Todavía no hay preguntas en esta sección.</p>}</div><button className="builder-add-section" onClick={() => editQuestion({ ...newQuestion(questionnaire), section: key })}><Plus size={16}/> Agregar pregunta</button></section>;
    })}</div>}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}><DialogContent className="sm:max-w-[570px]"><DialogHeader><DialogTitle>{questionnaire.questions.some((question) => question.id === editing?.id) ? "Editar pregunta" : "Nueva pregunta"}</DialogTitle></DialogHeader>{editing && <div className="builder-editor"><label>Sección<Select value={editing.section} onValueChange={(value) => setEditing({ ...editing, section: value as SectionKey })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SECTION_KEYS.map((key) => <SelectItem key={key} value={key}>{questionnaire.sections.find((item) => item.key === key)?.label || DEFAULT_SECTION_LABELS[key]}</SelectItem>)}</SelectContent></Select></label><label>Pregunta<Input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} placeholder="¿Qué te gustaría contarnos?" /></label><label>Descripción opcional<Input value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} placeholder="Una breve ayuda para responder" /></label><label>Tipo de respuesta<Select value={editing.type} onValueChange={(value) => setEditing({ ...editing, type: value as QuestionType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TYPES.map(([type, label]) => <SelectItem key={type} value={type}>{label}</SelectItem>)}</SelectContent></Select></label>{OPTION_TYPES.has(editing.type) && <label>Opciones, una por línea<Textarea rows={5} value={optionText} onChange={(event) => setOptionText(event.target.value)} /></label>}<label className="builder-switch-row">Respuesta obligatoria<Switch checked={editing.required} onCheckedChange={(required) => setEditing({ ...editing, required })} /></label><label className="builder-switch-row">Pregunta activa<Switch checked={editing.active} onCheckedChange={(active) => setEditing({ ...editing, active })} /></label>{editorError && <p className="builder-error" role="alert">{editorError}</p>}<button className="demo-primary" onClick={saveQuestion}>Aplicar en esta demo</button></div>}</DialogContent></Dialog>
  </>;
}
