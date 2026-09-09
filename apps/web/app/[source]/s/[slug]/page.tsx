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
  try {
    const r = await getResolve(sp.id ?? slug);
    permanentRedirect(`/${r.type}/${encodeURIComponent(r.slug)}`);
  } catch { permanentRedirect('/'); }
}
