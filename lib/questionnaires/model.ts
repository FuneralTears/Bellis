export type SectionKey = "situation" | "problem" | "implication" | "need";
export type QuestionType = "single_choice" | "multiple_choice" | "text" | "long_text" | "number" | "yes_no" | "scale" | "date";
export type AnswerValue = string | string[] | number | boolean;
export type ConditionOperator = "equals" | "not_equals" | "contains" | "includes" | "greater_than" | "less_than";
export type ConditionAction = "show" | "hide";
export type QuestionCondition = {
  id: string;
  questionId: string;
  operator: ConditionOperator;
  value: AnswerValue;
  action: ConditionAction;
};

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
  conditions?: QuestionCondition[];
};

export type Questionnaire = {
  id: string;
  serviceId: string;
  serviceIds?: string[];
  title: string;
  sections: QuestionnaireSection[];
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireAnswers = Record<string, AnswerValue>;

export const SECTION_KEYS: SectionKey[] = ["situation", "problem", "implication", "need"];
export const DEFAULT_SECTION_LABELS: Record<SectionKey, string> = {
  situation: "Situación",
  problem: "Problema",
  implication: "Implicación",
  need: "Necesidad",
};

const TEMPLATE_SECTION_LABELS: Record<string, [string, string, string, string]> = {
  Psicología: ["Situación", "Problema", "Impacto", "Objetivo"],
  Odontología: ["Motivo", "Síntomas", "Antecedentes", "Objetivo"],
  Nutrición: ["Objetivo", "Hábitos", "Dificultades", "Resultado esperado"],
  Kinesiología: ["Motivo", "Dolor/lesión", "Impacto", "Objetivo"],
  Psicopedagogía: ["Motivo", "Dificultad", "Contexto", "Objetivo"],
  Otro: ["Situación", "Problema", "Implicación", "Necesidad"],
};

type StarterPrompt = [SectionKey, string, QuestionType, string[], string?];
const STARTERS: Record<string, StarterPrompt[]> = {
  Psicología: [
    ["situation", "¿Qué te trae hoy?", "single_choice", ["Ansiedad", "Quiero ayuda con algo puntual", "Quiero trabajar algo que viene desde hace tiempo", "Quiero hacer una consulta preventiva", "Otro"]],
    ["problem", "¿Qué es lo que más te preocupa actualmente?", "long_text", [], "Contanos con tus palabras lo que te gustaría abordar."],
    ["implication", "¿En qué áreas está teniendo impacto?", "multiple_choice", ["Trabajo", "Familia", "Relaciones", "Estudios", "Descanso", "Bienestar", "Otro"]],
    ["need", "Si esta situación mejorara, ¿qué te gustaría conseguir?", "long_text", []],
    ["problem", "¿Desde cuándo sentís que esto te afecta?", "single_choice", ["Hace días", "Hace semanas", "Hace meses", "Hace más tiempo"]],
  ],
  Odontología: [
    ["situation", "¿Cuál es el motivo de tu consulta?", "single_choice", ["Dolor o molestia", "Control preventivo", "Tratamiento pendiente", "Otro"]],
    ["problem", "¿Qué síntomas tenés?", "multiple_choice", ["Dolor", "Sensibilidad", "Inflamación", "Sangrado", "Ninguno", "Otro"]],
    ["implication", "¿Desde cuándo ocurre?", "single_choice", ["Desde hoy", "Hace algunos días", "Hace semanas", "Hace más tiempo"]],
    ["need", "¿Qué esperás resolver en esta consulta?", "long_text", []],
    ["problem", "¿Dónde sentís el dolor?", "text", []],
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
  const labels = TEMPLATE_SECTION_LABELS[specialty] ?? TEMPLATE_SECTION_LABELS.Otro;
  return {
    id,
    serviceId,
    serviceIds: [serviceId],
    title: "Preconsulta",
    sections: SECTION_KEYS.map((key, order) => ({ key, label: labels[order], order })),
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
      conditions: order === 4 && (specialty === "Psicología" || specialty === "Odontología")
        ? [{ id: `${id}-condition-1`, questionId: `${id}-question-1`, operator: "equals", value: specialty === "Psicología" ? "Ansiedad" : "Dolor o molestia", action: "show" }]
        : [],
    })),
  };
}

export function activeQuestions(questionnaire: Questionnaire): QuestionnaireQuestion[] {
  return questionnaire.questions.filter((question) => question.active).sort((a, b) =>
    SECTION_KEYS.indexOf(a.section) - SECTION_KEYS.indexOf(b.section) || a.order - b.order);
}

export function conditionOperators(type: QuestionType): ConditionOperator[] {
  if (type === "multiple_choice") return ["includes"];
  if (type === "number" || type === "scale") return ["equals", "not_equals", "greater_than", "less_than"];
  if (type === "text" || type === "long_text") return ["equals", "not_equals", "contains"];
  return ["equals", "not_equals"];
}

export function conditionMatches(condition: QuestionCondition, answer: AnswerValue | undefined): boolean {
  if (answer === undefined || answer === "" || (Array.isArray(answer) && !answer.length)) return false;
  switch (condition.operator) {
    case "equals": return answer === condition.value;
    case "not_equals": return answer !== condition.value;
    case "contains": return typeof answer === "string" && typeof condition.value === "string" && answer.toLocaleLowerCase("es-AR").includes(condition.value.toLocaleLowerCase("es-AR"));
    case "includes": return Array.isArray(answer) && answer.includes(String(condition.value));
    case "greater_than": return typeof answer === "number" && typeof condition.value === "number" && answer > condition.value;
    case "less_than": return typeof answer === "number" && typeof condition.value === "number" && answer < condition.value;
  }
}

export function visibleQuestions(questionnaire: Questionnaire, answers: QuestionnaireAnswers): QuestionnaireQuestion[] {
  const shown: QuestionnaireQuestion[] = [];
  const shownIds = new Set<string>();
  for (const question of activeQuestions(questionnaire)) {
    const conditions = question.conditions ?? [];
    const matches = (condition: QuestionCondition) => shownIds.has(condition.questionId) && conditionMatches(condition, answers[condition.questionId]);
    const showRules = conditions.filter((condition) => condition.action === "show");
    const hideRules = conditions.filter((condition) => condition.action === "hide");
    if ((showRules.length === 0 || showRules.some(matches)) && !hideRules.some(matches)) {
      shown.push(question);
      shownIds.add(question.id);
    }
  }
  return shown;
}

export function visibleAnswers(questionnaire: Questionnaire, answers: QuestionnaireAnswers): QuestionnaireAnswers {
  const ids = new Set(visibleQuestions(questionnaire, answers).map((question) => question.id));
  return Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id)));
}

export function validateConditions(questionnaire: Questionnaire): string | null {
  const ordered = [...questionnaire.questions].sort((a, b) =>
    SECTION_KEYS.indexOf(a.section) - SECTION_KEYS.indexOf(b.section) || a.order - b.order);
  const positions = new Map(ordered.map((question, index) => [question.id, index]));
  for (const [index, target] of ordered.entries()) {
    if ((target.conditions ?? []).length > 10) return `“${target.title}” admite hasta 10 condiciones.`;
    for (const condition of target.conditions ?? []) {
      const source = ordered.find((question) => question.id === condition.questionId);
      if (!source || !source.active || (positions.get(source.id) ?? Infinity) >= index) return `Revisá la condición de “${target.title}”: la pregunta de origen debe estar activa y aparecer antes.`;
      if (!conditionOperators(source.type).includes(condition.operator)) return `Revisá el operador de la condición de “${target.title}”.`;
      if (condition.value === "" || condition.value === undefined) return `Completá el valor de la condición de “${target.title}”.`;
      if ((source.type === "single_choice" || source.type === "multiple_choice") && typeof condition.value !== "string") return `Revisá el valor de la condición de “${target.title}”.`;
      if ((source.type === "single_choice" || source.type === "multiple_choice") && !source.options.includes(String(condition.value))) return `La opción de la condición de “${target.title}” ya no existe.`;
      if (source.type === "yes_no" && typeof condition.value !== "boolean") return `Revisá el valor de la condición de “${target.title}”.`;
      if ((source.type === "number" || source.type === "scale") && (typeof condition.value !== "number" || !Number.isFinite(condition.value))) return `Ingresá un número válido en la condición de “${target.title}”.`;
      if ((source.type === "text" || source.type === "long_text" || source.type === "date") && typeof condition.value !== "string") return `Revisá el valor de la condición de “${target.title}”.`;
      if (source.type === "date" && typeof condition.value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(condition.value)) return `Ingresá una fecha válida en la condición de “${target.title}”.`;
    }
  }
  return null;
}

export function hasAnswer(question: QuestionnaireQuestion, answer: AnswerValue | undefined): boolean {
  if (answer === undefined) return false;
  if (typeof answer === "string") return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.length > 0;
  return true;
}
