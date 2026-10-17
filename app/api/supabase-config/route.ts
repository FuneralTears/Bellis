import { deploymentTargetProblem } from "@/lib/supabase-target";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    return Response.json({ error: "Supabase no está configurado" }, { status: 503 });
  }
  // A Preview never hands the production project to the browser, even if its branch metadata incorrectly says
  // `main`. VERCEL_ENV is the authoritative distinction between Preview and Production at request time.
  if (deploymentTargetProblem(url, process.env)) {
    return Response.json({ error: "Este entorno no puede usar el proyecto de producción" }, { status: 503 });
  }
  return Response.json({ url, publishableKey }, { headers: { "Cache-Control": "no-store" } });
}
