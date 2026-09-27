import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let clientPromise: Promise<SupabaseClient> | null = null;

export function getSupabase(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = fetch("/api/supabase-config", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("No pudimos conectar con Bellis. Intentá nuevamente.");
      const config = await response.json() as { url: string; publishableKey: string };
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
