export const runtime = 'edge';
import { getChapter, API_URL, r2UrlFor } from '@/lib/api';
import { Reader } from '@/components/Reader';
import { SourceSwitcher } from '@/components/SourceSwitcher';
import Link from 'next/link';

export const revalidate = 300;

export default async function ChapterReader({ params }: { params: { source: string; slug: string; chapterId: string } }) {
  let chapter;
  try {
    chapter = await getChapter(params.source, params.chapterId);
  } catch (e) {
    return <div className="p-8 text-error">Gagal memuat chapter: {String(e)}</div>;
  }

  const pages = chapter.pages || [];
  const chapterNum = chapter.chapter_number ?? 0;
  // Next-chapter prefetch URL (best-effort; chapter URLs follow the
  // `<slug>-chapter-<n>` convention on most sources).
  const nextChapterUrl = chapterNum > 0
    ? `/${params.source}/s/${params.slug}/${params.slug}-chapter-${chapterNum + 1}`
    : null;

  // R2-first: hash slug → domain R2 untuk tiap halaman (deterministik, sama
  // dengan sisi Worker). null saat R2 belum dikonfigurasi → proxy-only.
  const r2Pages = pages.map((p, i) => ({
    ...p,
    r2Url: r2UrlFor(params.slug, params.chapterId, i + 1),
  }));

  return (
    <main className="max-w-3xl mx-auto px-4 py-6">
      <SourceSwitcher
        currentSource={params.source}
        sourceId={params.slug}
        canonicalSlug={params.slug}
        chapterNumber={chapter.chapter_number ?? 0}
        apiUrl={API_URL}
      />
      <div className="mb-4">
        <Link href={`/${params.source}/s/${chapter.series_slug}`} className="text-secondary text-sm hover:text-accent">← Daftar Chapter</Link>
        <h1 className="text-lg font-medium mt-1">Chapter {chapter.chapter_number}{chapter.title ? `: ${chapter.title}` : ''}</h1>
      </div>
      {r2Pages.length === 0 ? (
        <div className="text-muted text-sm py-8 text-center">Tidak ada halaman.</div>
      ) : (
        <Reader pages={r2Pages} apiUrl={API_URL} nextChapterUrl={nextChapterUrl} />
      )}
    </main>
  );
}
