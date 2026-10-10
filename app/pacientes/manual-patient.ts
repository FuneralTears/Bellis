import { getSupabase } from "@/lib/supabase/browser";
import { phoneKey, type DuplicateCandidate } from "@/lib/patient-duplicates";
import type { NewPatientValues } from "@/components/crm/NewPatientForm";

/** Manual patients (H2.1), shared by /pacientes and the "Nuevo turno" flow of the agenda. */

/** Patients of the workspace that share the phone or the email. Two plain filters: nothing typed reaches a filter string. */
export async function lookupPatientDuplicates(workspaceId: string, phone: string, email: string | null): Promise<DuplicateCandidate[]> {
  const client = await getSupabase();
  const base = () => client.from("patients").select("id,first_name,last_name,phone,email,created_at").eq("workspace_id", workspaceId).is("deleted_at", null).order("created_at", { ascending: false }).limit(50);
  const key = phoneKey(phone);
  const [byPhone, byEmail] = await Promise.all([key ? base().like("phone", `%${key}`) : null, email ? base().eq("email", email) : null]);
  if (byPhone?.error || byEmail?.error) throw new Error("No pudimos revisar si el paciente ya existe. Intentá de nuevo.");
  return [...(byPhone?.data ?? []), ...(byEmail?.data ?? [])].map((row) => ({ id: row.id, full_name: `${row.first_name} ${row.last_name}`, phone: row.phone, email: row.email, created_at: row.created_at }));
}

/** Creates the patient and returns its id. The server checks identity, role and the strong-duplicate rule again. */
export async function createManualPatient(workspaceId: string, values: NewPatientValues): Promise<string> {
  const client = await getSupabase();
  const { data, error } = await client.rpc("create_manual_patient", { p_workspace: workspaceId, p_first_name: values.firstName, p_last_name: values.lastName, p_phone: values.phone, p_email: values.email, p_note: values.note });
  if (error || !data) {
    const code = error?.message ?? "";
    throw new Error(code.includes("patient_already_exists") ? "Ya existe una ficha con este mismo teléfono y email. Buscala en la lista de pacientes."
      : code.includes("not_authorized") ? "No tenés permiso para cargar pacientes en este espacio."
      : code.includes("invalid_patient") ? "Revisá el nombre, el apellido, el teléfono y el email."
      : code.includes("invalid_note") ? "La nota es demasiado larga." : "No pudimos guardar el paciente. Intentá de nuevo.");
  }
  return data as string;
}
