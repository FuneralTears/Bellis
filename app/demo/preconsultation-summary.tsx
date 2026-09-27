import { DEFAULT_SECTION_LABELS, SECTION_KEYS, type Questionnaire, type QuestionnaireAnswers } from "@/lib/questionnaires/model";
import "./preconsultation-summary.css";

export function PreconsultationSummary({ questionnaire, answers }: { questionnaire: Questionnaire; answers: QuestionnaireAnswers }) {
  return <div className="preconsultation-summary"><h4>Preconsulta <span>Respuestas de ejemplo</span></h4>{SECTION_KEYS.map((key) => {
    const questions = questionnaire.questions.filter((question) => question.active && question.section === key).sort((a, b) => a.order - b.order);
    if (!questions.length) return null;
    const section = questionnaire.sections.find((item) => item.key === key);
    return <section key={key}><h5>{section?.label || DEFAULT_SECTION_LABELS[key]}</h5>{questions.map((question) => {
      const value = answers[question.id];
      const display = Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? value ? "Sí" : "No" : value === undefined ? "Sin respuesta" : String(value);
      return <div key={question.id}><strong>{question.title}</strong><p>{display}</p></div>;
    })}</section>;
  })}</div>;
}
