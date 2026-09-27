export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    return Response.json({ error: "Supabase no está configurado" }, { status: 503 });
  }
  return Response.json({ url, publishableKey }, { headers: { "Cache-Control": "no-store" } });
}
