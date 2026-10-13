"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { adminGateState, classifyAdminRpc, classifyAuthUser, type AdminAuthState, type AdminRole, type AdminRpcStatus } from "@/lib/admin";

/**
 * Nothing of the backoffice is rendered until the server says this person is part of the Bellis team.
 * Anyone else gets the same "not found" page as a route that does not exist: no session, a workspace owner
 * and a deactivated admin all look alike. This only decides what is drawn. The data is protected on the server:
 * every admin RPC checks the caller again, so skipping this component shows an empty shell and nothing more.
 *
 * Three answers, never mixed up (adminGateState):
 *   denied  the server said so: there is no session, or this account is not from the team. Not found.
 *   error   it could not be asked (network, a session that would not refresh). Not access, and not "not found"
 *           either: a neutral message with a retry.
 *   a role  the server confirmed it.
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
  if (error) { if (classifyAdminRpc(error) === "denied") throw new AdminDenied(); throw new Error(error.message); }
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

type GateState = ReturnType<typeof adminGateState>;

export default function AdminGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let cancelled = false;
    // What is known so far. Nothing here is shown or logged: it only feeds the decision.
    const known: { auth: AdminAuthState; rpc: AdminRpcStatus | "pending"; role: string | null } = { auth: "pending", rpc: "pending", role: null };
    let asked = false;
    const finish = () => { if (!cancelled) setState(adminGateState(known)); };
    async function check() {
      try {
        const client = await getSupabase();
        // Same call the rest of the panel uses: it waits for the stored session and has the server confirm it.
        known.auth = classifyAuthUser(await client.auth.getUser());
        if (known.auth !== "session_ready") return finish();
        asked = true;
        let answer = await client.rpc("bellis_admin_session");
        known.rpc = classifyAdminRpc(answer.error);
        // An access token that expired between the two calls: renew it once and ask again.
        if (known.rpc === "session") {
          await client.auth.refreshSession();
          answer = await client.rpc("bellis_admin_session");
          known.rpc = classifyAdminRpc(answer.error);
        }
        known.role = known.rpc === "ok" ? (answer.data as { role?: string } | null)?.role ?? null : null;
      } catch { if (known.auth === "pending") known.auth = "error"; if (asked) known.rpc = "error"; }
      return finish();
    }
    void check(); return () => { cancelled = true; };
  }, [attempt]);
  if (state === "denied") notFound();
  // Blank while checking: a skeleton of the backoffice would already say that it exists.
  if (state === "checking") return null;
  if (state === "error") return <main style={{ padding: 32 }}><p role="alert">No pudimos cargar esta página. Probá de nuevo en un momento.</p>
    <p><button type="button" onClick={() => { setState("checking"); setAttempt((value) => value + 1); }} style={{ minHeight: 40, padding: "0 14px" }}>Reintentar</button></p></main>;
  return <AdminContext.Provider value={state}>{children}</AdminContext.Provider>;
}
