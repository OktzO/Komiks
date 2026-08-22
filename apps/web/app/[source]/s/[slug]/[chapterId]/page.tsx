import { getChapter, getSeries, API_URL } from '@/lib/api';
import { ReaderShell } from '@/components/ReaderShell';
import { ReaderSkeleton } from '@/components/Skeleton';
import { Suspense } from 'react';

// Chapter pages: URL halaman immutable setelah publish (B2/edge cache 1y).
// ISR 5 menit → render diserve dari KV incremental cache; repeat reader
// chapter yang sama tidak invoke web Worker lagi.
export const revalidate = 300;

async function ChapterContent({ params }: { params: Promise<{ source: string; slug: string; chapterId: string }> }) {
  const { source, slug, chapterId } = await params;
  let chapter;
  let series;
  try {
    [chapter, series] = await Promise.all([
      getChapter(source, chapterId),
      getSeries(source, slug).catch(() => null),
    ]);
  } catch (e) {
    return <div className="p-8 text-error">Gagal memuat chapter: {String(e)}</div>;
  }

  const chapterNum = chapter.chapter_number ?? 0;
  const pages = (chapter.pages || []).map((p) => ({ ...p }));

  return (
    <ReaderShell
      source={source}
      slug={slug}
      chapterId={chapterId}
      chapterNumber={chapterNum}
      chapterTitle={chapter.title}
      seriesTitle={series?.title || slug}
      seriesType={series?.type}
      pages={pages}
      apiUrl={API_URL}
    />
  );
}

export default function ChapterReader({ params }: { params: Promise<{ source: string; slug: string; chapterId: string }> }) {
  return (
    <Suspense fallback={<ReaderSkeleton pageCount={2} />}>
      <ChapterContent params={params} />
    </Suspense>
  );
}
