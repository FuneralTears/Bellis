"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { isAdminDenied, type AdminRole } from "@/lib/admin";

/**
 * Nothing of the backoffice is rendered until the server says this person is part of the Bellis team.
 * Anyone else gets the same "not found" page as a route that does not exist: no session, a workspace owner
 * and a deactivated admin all look alike. This only decides what is drawn. The data is protected on the server:
 * every admin RPC checks the caller again, so skipping this component shows an empty shell and nothing more.
 */
const AdminContext = createContext<AdminRole | null>(null);
export function useAdminRole(): AdminRole | null {
  return useContext(AdminContext);
}

export class AdminDenied extends Error {}
/** Calls an admin RPC. Throws AdminDenied when the server does not recognise the caller as part of the team. */
export async function adminRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const client = await getSupabase();
  const { data, error } = await client.rpc(name, args);
  if (error) { if (isAdminDenied(error)) throw new AdminDenied(); throw new Error(error.message); }
  return data as T;
}

/** Loads something for an admin screen. `denied` turns the screen into "not found". */
export function useAdminData<T>(load: () => Promise<T>, key: string): { data: T | null; error: string; denied: boolean; loading: boolean } {
  const [state, setState] = useState<{ key: string; data: T | null; error: string; denied: boolean }>({ key: "", data: null, error: "", denied: false });
  useEffect(() => { let cancelled = false;
    load().then((data) => { if (!cancelled) setState({ key, data, error: "", denied: false }); })
      .catch((caught) => { if (!cancelled) setState({ key, data: null, error: caught instanceof AdminDenied ? "" : "No pudimos cargar esta información. Probá de nuevo.", denied: caught instanceof AdminDenied }); });
    return () => { cancelled = true; };
    // `key` stands for everything `load` depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // While a new key loads, the previous rows stay on screen instead of blinking away.
  return { data: state.data, error: state.error, denied: state.denied, loading: state.key !== key };
}

export default function AdminGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "denied" | "error" | AdminRole>("checking");
  useEffect(() => { let cancelled = false;
    async function check() {
      try {
        const client = await getSupabase();
        const { data: auth } = await client.auth.getSession();
        if (!auth.session) { if (!cancelled) setState("denied"); return; }
        const session = await adminRpc<{ role: AdminRole }>("bellis_admin_session");
        if (!cancelled) setState(session?.role === "admin" || session?.role === "support" ? session.role : "denied");
      } catch (caught) { if (!cancelled) setState(caught instanceof AdminDenied ? "denied" : "error"); }
    }
    void check(); return () => { cancelled = true; };
  }, []);
  if (state === "denied") notFound();
  // Blank while checking: a skeleton of the backoffice would already say that it exists.
  if (state === "checking") return null;
  if (state === "error") return <main style={{ padding: 32 }}><p role="alert">No pudimos cargar esta página. Probá de nuevo en un momento.</p></main>;
  return <AdminContext.Provider value={state}>{children}</AdminContext.Provider>;
}
