import { execFileSync } from "node:child_process";
import { versionPayload } from "@/lib/supabase-target";

export const dynamic = "force-dynamic";

/** Outside Vercel (local work only), the commit is read from git. On Vercel it always comes from the build's metadata. */
function localCommit(): string | undefined {
  if (process.env.VERCEL) return undefined;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return undefined; }
}

/** Which commit, environment and Supabase project this deployment is. Technical facts only: no key, no address. */
export async function GET() {
  return Response.json(versionPayload(process.env, { localCommit: localCommit() }), { headers: { "Cache-Control": "no-store" } });
}
