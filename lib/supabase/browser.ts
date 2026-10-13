import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let clientPromise: Promise<SupabaseClient> | null = null;
let adminDebug = false;

export function getSupabase(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = fetch("/api/supabase-config", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("No pudimos conectar con Bellis. Intentá nuevamente.");
      const config = await response.json() as { url: string; publishableKey: string; adminDebug?: boolean };
      adminDebug = config.adminDebug === true;
      return createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
    }).catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

/** Whether this deployment lets the backoffice gate print its debug line. Decided by the server; false in production. */
export async function adminDebugAllowed(): Promise<boolean> {
  await getSupabase();
  return adminDebug;
}
