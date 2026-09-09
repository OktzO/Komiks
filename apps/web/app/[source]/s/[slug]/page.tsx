import { permanentRedirect } from 'next/navigation';
import { getResolve } from '@/lib/api';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> { return {}; }

export default async function LegacyDetail({ params, searchParams }: {
  params: Promise<{ source: string; slug: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  // Jangan bungkus redirect dalam try/catch — NEXT_REDIRECT adalah throw yang
  // harus propagate ke Next.js, bukan error biasa.
  let r: Awaited<ReturnType<typeof getResolve>> | null = null;
  try {
    r = await getResolve(sp.id ?? slug);
  } catch { r = null; }
  if (!r) permanentRedirect('/');
  permanentRedirect(`/${r.type}/${encodeURIComponent(r.slug)}`);
}
