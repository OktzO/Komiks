export const runtime = 'edge';
import { getChapter, getSeries, API_URL } from '@/lib/api';
import { ReaderShell } from '@/components/ReaderShell';
import { ReaderSkeleton } from '@/components/Skeleton';
import { Suspense } from 'react';

async function ChapterContent({ params }: { params: { source: string; slug: string; chapterId: string } }) {
  let chapter;
  let series;
  try {
    // Parallel: chapter + series metadata tidak saling bergantung — satu
    // waterfall hilang (sebelumnya serial: chapter dulu, baru series).
    [chapter, series] = await Promise.all([
      getChapter(params.source, params.chapterId),
      getSeries(params.source, params.slug).catch(() => null),
    ]);
  } catch (e) {
    return <div className="p-8 text-error">Gagal memuat chapter: {String(e)}</div>;
  }

  const chapterNum = chapter.chapter_number ?? 0;

  // URL storage datang dari server (D1 source of truth: b2Url presigned).
  // Page baru belum di-upload → null → Reader pakai proxy
  // (yang sekaligus meng-upload → request berikutnya dapat URL langsung).
  const pages = (chapter.pages || []).map((p) => ({ ...p }));

  return (
    <ReaderShell
      source={params.source}
      slug={params.slug}
      chapterId={params.chapterId}
      chapterNumber={chapterNum}
      chapterTitle={chapter.title}
      seriesTitle={series?.title || params.slug}
      seriesType={series?.type}
      pages={pages}
      apiUrl={API_URL}
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