import { permanentRedirect } from 'next/navigation';
import { getResolve, typedChapterUrl } from '@/lib/api';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> { return {}; }

export default async function LegacyChapter({ params, searchParams }: {
  params: Promise<{ source: string; slug: string; chapterId: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const { chapterId, slug } = await params;
  const sp = await searchParams;
  try {
    const r = await getResolve(sp.id ?? slug);
    permanentRedirect(typedChapterUrl(r.type, r.slug, chapterId));
  } catch { permanentRedirect('/'); }
}
