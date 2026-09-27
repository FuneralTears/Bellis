export type SectionKey = "situation" | "problem" | "implication" | "need";
export type QuestionType = "single_choice" | "multiple_choice" | "text" | "long_text" | "number" | "yes_no" | "scale" | "date";
export type AnswerValue = string | string[] | number | boolean;

export type QuestionnaireSection = {
  key: SectionKey;
  label: string;
  order: number;
};

export type QuestionnaireQuestion = {
  id: string;
  questionnaireId: string;
  section: SectionKey;
  title: string;
  description: string;
  type: QuestionType;
  options: string[];
  required: boolean;
  order: number;
  active: boolean;
};

export type Questionnaire = {
  id: string;
  serviceId: string;
  title: string;
  sections: QuestionnaireSection[];
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireAnswers = Record<string, AnswerValue>;

export const SECTION_KEYS: SectionKey[] = ["situation", "problem", "implication", "need"];
export const DEFAULT_SECTION_LABELS: Record<SectionKey, string> = {
  situation: "Para empezar",
  problem: "Lo que está pasando",
  implication: "Cómo te afecta",
  need: "Qué buscás",
};

type StarterPrompt = [SectionKey, string, QuestionType, string[], string?];
const STARTERS: Record<string, StarterPrompt[]> = {
  Psicología: [
    ["situation", "¿Qué te trae hoy?", "single_choice", ["Quiero ayuda con algo puntual", "Quiero trabajar algo que viene desde hace tiempo", "Quiero hacer una consulta preventiva", "Otro"]],
    ["problem", "¿Qué es lo que más te preocupa actualmente?", "long_text", [], "Contanos con tus palabras lo que te gustaría abordar."],
    ["implication", "¿En qué áreas está teniendo impacto?", "multiple_choice", ["Trabajo", "Familia", "Relaciones", "Estudios", "Descanso", "Bienestar", "Otro"]],
    ["need", "Si esta situación mejorara, ¿qué te gustaría conseguir?", "long_text", []],
  ],
  Odontología: [
    ["situation", "¿Cuál es el motivo de tu consulta?", "single_choice", ["Dolor o molestia", "Control preventivo", "Tratamiento pendiente", "Otro"]],
    ["problem", "¿Qué síntomas tenés?", "multiple_choice", ["Dolor", "Sensibilidad", "Inflamación", "Sangrado", "Ninguno", "Otro"]],
    ["implication", "¿Desde cuándo ocurre?", "single_choice", ["Desde hoy", "Hace algunos días", "Hace semanas", "Hace más tiempo"]],
    ["need", "¿Qué esperás resolver en esta consulta?", "long_text", []],
  ],
  Nutrición: [
    ["situation", "¿Cuál es tu objetivo principal?", "single_choice", ["Mejorar hábitos", "Acompañamiento nutricional", "Consulta puntual", "Otro"]],
    ["problem", "¿Qué te resulta más difícil hoy?", "long_text", []],
    ["implication", "¿Cómo influye esto en tu rutina?", "multiple_choice", ["Energía", "Organización", "Bienestar", "Actividad física", "Otro"]],
    ["need", "¿Qué cambio te gustaría lograr?", "long_text", []],
  ],
  Kinesiología: [
    ["situation", "¿Qué zona necesitás tratar?", "text", []],
    ["problem", "¿Desde cuándo sentís la molestia?", "single_choice", ["Menos de una semana", "Entre una y cuatro semanas", "Más de un mes"]],
    ["implication", "¿Cómo afecta tu movilidad?", "multiple_choice", ["Trabajo", "Deporte", "Actividades diarias", "Descanso", "Otro"]],
    ["need", "¿Qué actividad te gustaría recuperar?", "long_text", []],
  ],
  Psicopedagogía: [
    ["situation", "¿Cuál es el motivo de la consulta?", "long_text", []],
    ["problem", "¿Qué dificultades observás?", "multiple_choice", ["Lectura", "Escritura", "Atención", "Organización", "Aprendizaje", "Otro"]],
    ["implication", "¿En qué contexto aparece con mayor frecuencia?", "single_choice", ["Escuela", "Hogar", "Ambos", "Otro"]],
    ["need", "¿Qué te gustaría conseguir con este acompañamiento?", "long_text", []],
  ],
  Otro: [
    ["situation", "¿Cuál es el motivo de tu consulta?", "long_text", []],
    ["problem", "¿Qué situación te gustaría resolver?", "long_text", []],
    ["implication", "¿Cómo está afectando tu día a día?", "long_text", []],
    ["need", "¿Qué resultado esperás de este encuentro?", "long_text", []],
  ],
};

export const STARTER_SPECIALTIES = Object.keys(STARTERS);

export function starterQuestionnaire(serviceId: string, specialty: string = "Psicología"): Questionnaire {
  const id = `demo-questionnaire-${serviceId}`;
  const prompts = STARTERS[specialty] ?? STARTERS.Otro;
  return {
    id,
    serviceId,
    title: "Preconsulta",
    sections: SECTION_KEYS.map((key, order) => ({ key, label: DEFAULT_SECTION_LABELS[key], order })),
    questions: prompts.map(([section, title, type, options, description], order) => ({
      id: `${id}-question-${order + 1}`,
      questionnaireId: id,
      section,
      title,
      description: description ?? "",
      type,
      options,
      required: true,
      order,
      active: true,
    })),
  };
}

export function activeQuestions(questionnaire: Questionnaire): QuestionnaireQuestion[] {
  return questionnaire.questions.filter((question) => question.active).sort((a, b) => a.order - b.order);
}

export function hasAnswer(question: QuestionnaireQuestion, answer: AnswerValue | undefined): boolean {
  if (answer === undefined) return false;
  if (typeof answer === "string") return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.length > 0;
  return true;
}
