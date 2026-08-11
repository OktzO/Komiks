export const runtime = 'edge';
import { getChapter, getSeries, API_URL, r2UrlFor } from '@/lib/api';
import { ReaderShell } from '@/components/ReaderShell';
import { ReaderSkeleton } from '@/components/Skeleton';
import { Suspense } from 'react';

export const revalidate = 300;

async function ChapterContent({ params }: { params: { source: string; slug: string; chapterId: string } }) {
  let chapter;
  try {
    chapter = await getChapter(params.source, params.chapterId);
  } catch (e) {
    return <div className="p-8 text-error">Gagal memuat chapter: {String(e)}</div>;
  }

  let series;
  try {
    series = await getSeries(params.source, params.slug);
  } catch {
    series = null;
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
    r2Url: r2UrlFor(params.source, params.slug, params.chapterId, i + 1),
  }));

  return (
    <ReaderShell
      source={params.source}
      slug={params.slug}
      chapterId={params.chapterId}
      chapterNumber={chapterNum}
      chapterTitle={chapter.title}
      seriesTitle={series?.title || params.slug}
      seriesType={series?.type}
      pages={r2Pages}
      apiUrl={API_URL}
      nextChapterUrl={nextChapterUrl}
    />
  );
}

// Shell instan: toolbar skeleton langsung tampil, data fetch background.
export default function ChapterReader({ params }: { params: { source: string; slug: string; chapterId: string } }) {
  return (
    <Suspense fallback={<ReaderSkeleton pageCount={2} />}>
      <ChapterContent params={params} />
    </Suspense>
  );
}