import type { SupabaseClient } from "@supabase/supabase-js";

export class AccountSetupError extends Error {}

export async function landingRouteForUser(client: SupabaseClient, userId: string): Promise<"/onboarding" | "/dashboard"> {
  const member = await client.from("workspace_members")
    .select("workspace_id,role").eq("user_id", userId).order("created_at").limit(1).maybeSingle();
  if (member.error) throw member.error;
  if (!member.data) throw new AccountSetupError("Tu cuenta no tiene un consultorio asociado. Contactanos para revisar el registro.");

  const [workspace, professional] = await Promise.all([
    client.from("workspaces").select("onboarding_completed_at").eq("id", member.data.workspace_id).single(),
    client.from("professionals").select("id").eq("workspace_id", member.data.workspace_id).eq("user_id", userId).limit(1).maybeSingle(),
  ]);
  if (workspace.error || !workspace.data) throw new AccountSetupError("No pudimos abrir tu consultorio. Intentá nuevamente.");
  if (professional.error) throw professional.error;
  if (!professional.data) throw new AccountSetupError("Tu cuenta no tiene un perfil profesional asociado. Contactanos para revisarla.");
  return workspace.data.onboarding_completed_at ? "/dashboard" : "/onboarding";
}

export function authMessage(error: unknown, context: "signup" | "login" | "recovery"): string {
  if (error instanceof AccountSetupError) return error.message;
  const value = error as { code?: string; message?: string } | null;
  const code = value?.code ?? "";
  const message = value?.message?.toLowerCase() ?? "";
  if (code === "email_not_confirmed" || message.includes("email not confirmed"))
    return "Confirmá tu email antes de ingresar. Revisá también la carpeta de correo no deseado.";
  if (code === "user_already_exists" || message.includes("already registered"))
    return "Ese email ya está registrado. Ingresá o recuperá tu contraseña.";
  if (code === "weak_password" || message.includes("password should be"))
    return "Elegí una contraseña más segura, de al menos 8 caracteres.";
  if (code === "email_address_invalid" || message.includes("invalid email"))
    return "Ingresá un email válido.";
  if (context === "login") return "No pudimos ingresar. Revisá el email y la contraseña.";
  if (context === "recovery") return "No pudimos completar el cambio. Pedí un nuevo enlace e intentá otra vez.";
  return "No pudimos crear tu cuenta. Intentá nuevamente.";
}
