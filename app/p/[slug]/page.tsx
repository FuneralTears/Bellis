import { LivePublicProfile } from "./profile";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <LivePublicProfile slug={slug} />;
}
