import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SECTION_LABELS, SECTION_KEYS, starterQuestionnaire, type Questionnaire, type QuestionnaireQuestion, type QuestionnaireSection, type SectionKey } from "./model";

export type ProfessionalForms = {
  professionalName: string;
  services: { id: string; name: string }[];
  questionnaires: Record<string, Questionnaire>;
};

export async function loadProfessionalForms(client: SupabaseClient, userId: string): Promise<ProfessionalForms> {
  const professionalResult = await client.from("professionals")
    .select("id,display_name,specialty").eq("user_id", userId).limit(1).maybeSingle();
  if (professionalResult.error) throw professionalResult.error;
  if (!professionalResult.data) throw new Error("No encontramos tu espacio profesional. Si acabás de confirmar tu email, intentá ingresar nuevamente.");
  const professional = professionalResult.data;
  const servicesResult = await client.from("services")
    .select("id,name").eq("professional_id", professional.id).eq("active", true).order("created_at");
  if (servicesResult.error) throw servicesResult.error;
  const services = servicesResult.data ?? [];
  if (!services.length) throw new Error("Tu espacio todavía no tiene servicios activos.");
  const ids = services.map((service) => service.id);
  const questionnaireResult = await client.from("questionnaires")
    .select("id,service_id,title").in("service_id", ids).eq("active", true);
  if (questionnaireResult.error) throw questionnaireResult.error;
  const rows = questionnaireResult.data ?? [];
  const formIds = rows.map((row) => row.id);
  const [sectionsResult, questionsResult] = formIds.length ? await Promise.all([
    client.from("questionnaire_sections").select("questionnaire_id,section_key,visible_name,sort_order").in("questionnaire_id", formIds).order("sort_order"),
    client.from("questionnaire_questions").select("id,questionnaire_id,section_key,title,description,type,options,required,sort_order,active").in("questionnaire_id", formIds).order("sort_order"),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (sectionsResult.error) throw sectionsResult.error;
  if (questionsResult.error) throw questionsResult.error;

  const questionnaires: Record<string, Questionnaire> = {};
  for (const service of services) {
    const row = rows.find((item) => item.service_id === service.id);
    if (!row) {
      questionnaires[service.id] = starterQuestionnaire(service.id, professional.specialty);
      continue;
    }
    const sections: QuestionnaireSection[] = (sectionsResult.data ?? [])
      .filter((item) => item.questionnaire_id === row.id)
      .map((item) => ({ key: item.section_key as SectionKey, label: item.visible_name, order: item.sort_order }));
    const questions: QuestionnaireQuestion[] = (questionsResult.data ?? [])
      .filter((item) => item.questionnaire_id === row.id)
      .map((item) => ({
        id: item.id, questionnaireId: row.id, section: item.section_key as SectionKey,
        title: item.title, description: item.description ?? "", type: item.type,
        options: Array.isArray(item.options) ? item.options as string[] : [],
        required: item.required, order: item.sort_order, active: item.active,
      }));
    questionnaires[service.id] = { id: row.id, serviceId: service.id, title: row.title,
      sections: SECTION_KEYS.map((key) => sections.find((section) => section.key === key) ?? { key, label: DEFAULT_SECTION_LABELS[key], order: SECTION_KEYS.indexOf(key) }),
      questions };
  }
  return { professionalName: professional.display_name, services, questionnaires };
}

export async function saveProfessionalQuestionnaire(client: SupabaseClient, questionnaire: Questionnaire): Promise<void> {
  const { error } = await client.rpc("save_questionnaire", {
    p_service: questionnaire.serviceId,
    p_document: {
      title: questionnaire.title,
      sections: questionnaire.sections.map((section) => ({ key: section.key, label: section.label })),
      questions: [...questionnaire.questions].sort((a, b) => a.order - b.order).map((question) => ({
        section: question.section, title: question.title, description: question.description,
        type: question.type, options: question.options, required: question.required, active: question.active,
      })),
    },
  });
  if (error) throw error;
}
