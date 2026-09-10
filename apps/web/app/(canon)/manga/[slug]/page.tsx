import { notFound, permanentRedirect } from 'next/navigation';
import { loadCanonical } from '../../_shared/loadCanonical';
import { CanonicalDetail } from '../../_shared/CanonicalDetail';
import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }>; }): Promise<Metadata> {
  const { slug } = await params;
  // notFound() di sini (pre-stream) supaya slug yang tidak dikenal dapat HTTP
  // 404 asli — setelah shell streaming, status terlanjur 200.
  try {
    const { resolved, detailPromise } = await loadCanonical(slug);
    if (resolved.type !== 'manga') permanentRedirect(`/${resolved.type}/${encodeURIComponent(slug)}`);
    const s = await detailPromise;
    return { title: s.title, description: (s.synopsis ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || undefined };
  } catch { notFound(); }
}

export default async function MangaDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CanonicalDetail type="manga" slug={slug} />;
}
