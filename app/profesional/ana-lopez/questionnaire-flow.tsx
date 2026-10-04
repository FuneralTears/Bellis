"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { normalizeArgentinePhone } from "@/lib/market";
import { BookingAlert } from "@/components/booking/BookingUi";
import { DEFAULT_SECTION_LABELS, hasAnswer, visibleAnswers, visibleQuestions, type AnswerValue, type Questionnaire, type QuestionnaireAnswers, type QuestionnaireQuestion } from "@/lib/questionnaires/model";

export type PatientDraft = { firstName: string; lastName: string; email: string; phone: string };

type Props = {
  questionnaire: Questionnaire;
  initialAnswers: QuestionnaireAnswers;
  initialPatient: PatientDraft;
  onAnswersChange: (answers: QuestionnaireAnswers) => void;
  onPatientChange: (patient: PatientDraft) => void;
  onBack: () => void;
  onComplete: (answers: QuestionnaireAnswers, patient: PatientDraft) => void | Promise<void>;
  /** `true` shows the showroom note; a string replaces it (the builder preview says its own). */
  demoNote?: boolean | string;
};

export function QuestionnaireFlow({ questionnaire, initialAnswers, initialPatient, onAnswersChange, onPatientChange, onBack, onComplete, demoNote = true }: Props) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(() => visibleAnswers(questionnaire, initialAnswers));
  const [patient, setPatient] = useState<PatientDraft>(initialPatient);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const questions = visibleQuestions(questionnaire, answers);
  const isPatientStep = index === questions.length;
  const question = questions[index];
  const total = questions.length + 1;
  const progress = Math.round(((index + 1) / total) * 100);
  const sectionLabel = question ? questionnaire.sections.find((section) => section.key === question.section)?.label : "Casi listo";
  // The default section names are the professional's working structure, not copy for patients: only custom names are shown.
  const eyebrow = sectionLabel && !Object.values(DEFAULT_SECTION_LABELS).includes(sectionLabel) ? sectionLabel : null;

  const setAnswer = (value: AnswerValue) => {
    const updated = visibleAnswers(questionnaire, { ...answers, [question.id]: value });
    setAnswers(updated);
    onAnswersChange(updated);
    setError("");
  };

  const setPatientField = (key: keyof PatientDraft, value: string) => {
    const updated = { ...patient, [key]: value };
    setPatient(updated);
    onPatientChange(updated);
    setError("");
  };

  const goBack = () => {
    setError("");
    if (index === 0) onBack();
    else setIndex(index - 1);
  };

  const goNext = async () => {
    if (!isPatientStep) {
      if (question.required && !hasAnswer(question, answers[question.id])) {
        setError("Respondé esta pregunta para continuar.");
        return;
      }
      setError("");
      setIndex(index + 1);
      return;
    }
    if (!patient.firstName.trim() || !patient.lastName.trim() || !/^\S+@\S+\.\S+$/.test(patient.email)) {
      setError("Completá tu nombre, apellido y un email válido.");
      return;
    }
    const phone = normalizeArgentinePhone(patient.phone);
    if (!phone) {
      setError("Ingresá un celular argentino válido, por ejemplo +54 9 11 1234 5678.");
      return;
    }
    const normalized = { ...patient, phone };
    setPatient(normalized);
    onPatientChange(normalized);
    setLoading(true);
    setError("");
    try {
      await onComplete(visibleAnswers(questionnaire, answers), normalized);
    } catch {
      setError("No pudimos avanzar. Tus respuestas siguen acá; intentá nuevamente.");
    } finally {
      setLoading(false);
    }
  };

  return <section className="bk-card bk-q" aria-labelledby="smart-form-title">
    <div className="bk-q-top"><span>Preconsulta · {index + 1} de {total}</span><span>{progress}%</span></div>
    <div className="bk-q-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={index + 1} aria-label="Progreso de la preconsulta"><span style={{ width: `${progress}%` }} /></div>
    {demoNote && <p className="bk-q-demo">{demoNote === true ? "Vista de demostración · tus respuestas no se guardan." : demoNote}</p>}
    <div key={isPatientStep ? "patient" : question.id} className="bk-q-body">
      {eyebrow && <span className="bk-eyebrow">{eyebrow}</span>}
      <h1 id="smart-form-title">{isPatientStep ? "Tus datos para el turno" : question.title}</h1>
      <p>{isPatientStep ? "Completá tus datos de contacto. Todavía no se confirma ningún turno." : question.description || "Tu respuesta ayuda a preparar la atención."}</p>
      {isPatientStep ? <div className="bk-patient-grid">
        <label>Nombre <Input className="bk-input" value={patient.firstName} autoComplete="given-name" onChange={(event) => setPatientField("firstName", event.target.value)} /></label>
        <label>Apellido <Input className="bk-input" value={patient.lastName} autoComplete="family-name" onChange={(event) => setPatientField("lastName", event.target.value)} /></label>
        <label>Email <Input className="bk-input" type="email" value={patient.email} autoComplete="email" onChange={(event) => setPatientField("email", event.target.value)} /></label>
        <label>Celular argentino <Input className="bk-input" type="tel" value={patient.phone} autoComplete="tel" placeholder="+54 9 11 1234 5678" onChange={(event) => setPatientField("phone", event.target.value)} /></label>
      </div> : <QuestionInput question={question} value={answers[question.id]} onChange={setAnswer} />}
    </div>
    {error && <BookingAlert>{error}</BookingAlert>}
    <div className="bk-q-actions"><button className="bk-back" type="button" onClick={goBack} disabled={loading}><ArrowLeft size={17}/> Volver</button><button className="bk-button" type="button" onClick={goNext} disabled={loading}>{loading ? <><Loader2 className="bk-spin" size={17}/> Continuando…</> : <>{isPatientStep ? "Continuar al pago" : "Continuar"}<ArrowRight size={17}/></>}</button></div>
  </section>;
}

function QuestionInput({ question, value, onChange }: { question: QuestionnaireQuestion; value: AnswerValue | undefined; onChange: (value: AnswerValue) => void }) {
  const current = value ?? "";
  if (question.type === "single_choice" || question.type === "yes_no" || question.type === "scale") {
    const choices = question.type === "yes_no" ? ["Sí", "No"] : question.type === "scale" ? ["1", "2", "3", "4", "5"] : question.options;
    return <div className={question.type === "scale" ? "bk-options scale" : "bk-options"} role="group" aria-label={question.title}>{choices.map((choice) => {
      const chosen = question.type === "yes_no" ? current === (choice === "Sí") : String(current) === choice;
      return <button key={choice} type="button" className={chosen ? "bk-option chosen" : "bk-option"} aria-pressed={chosen} onClick={() => onChange(question.type === "scale" ? Number(choice) : question.type === "yes_no" ? choice === "Sí" : choice)}><span>{choice}</span>{chosen && <Check size={18}/>}</button>;
    })}</div>;
  }
  if (question.type === "multiple_choice") {
    const selected = Array.isArray(current) ? current : [];
    return <div className="bk-options" role="group" aria-label={question.title}>{question.options.map((choice) => {
      const checked = selected.includes(choice);
      return <label key={choice} className={checked ? "bk-option chosen" : "bk-option"}><Checkbox checked={checked} onCheckedChange={() => onChange(checked ? selected.filter((item) => item !== choice) : [...selected, choice])} /><span>{choice}</span></label>;
    })}</div>;
  }
  if (question.type === "long_text") return <Textarea className="bk-input" rows={5} value={String(current)} onChange={(event) => onChange(event.target.value)} placeholder="Escribí tu respuesta" />;
  return <Input className="bk-input" type={question.type === "number" ? "number" : question.type === "date" ? "date" : "text"} value={String(current)} onChange={(event) => onChange(question.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} placeholder={question.type === "text" ? "Escribí tu respuesta" : undefined} />;
}
