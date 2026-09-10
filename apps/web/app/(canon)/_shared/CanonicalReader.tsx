import { Suspense } from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import { API_URL, getChapter, getResolve, getSeries } from '@/lib/api';
import { ReaderShell } from '@/components/ReaderShell';
import { ReaderSkeleton } from '@/components/Skeleton';

// Canonical chapter reader: getResolve → getChapter(recommended/chosen).
// ChapterId URL kanonik adalah raw id (typedChapterUrl memangkas prefix
// `source:`). Slug yang diteruskan ke ReaderShell adalah sourceSlug agar
// fetch internal (getChapters) tetap jalan; `type` diteruskan supaya semua
// URL internal ReaderShell/SourceSwitcher kanonik-typed.
async function CanonicalReaderContent({ type, slug, chapterId }: {
  type: string;
  slug: string;
  chapterId: string;
}) {
  let resolved: Awaited<ReturnType<typeof getResolve>>;
  try {
    resolved = await getResolve(slug);
  } catch {
    notFound();
  }
  if (resolved.type !== type) {
    permanentRedirect(`/${resolved.type}/${encodeURIComponent(slug)}/${encodeURIComponent(chapterId)}`);
  }
  const source = resolved.recommendedSource ?? resolved.source;
  const link = resolved.sources.find((l) => l.source === source);
  const sourceSlug = link?.sourceSlug ?? resolved.sourceSlug;

  // Chapter id hidup di namespace per-source; coba chosen source dulu,
  // fallback ke source kanonik bila id tidak ada di sana.
  const candidates = [...new Set([source, resolved.source])];
  let chapter: Awaited<ReturnType<typeof getChapter>> | null = null;
  let readSource = candidates[0];
  for (const src of candidates) {
    try {
      const got = await getChapter(src, chapterId);
      if (got) {
        chapter = got;
        readSource = src;
        break;
      }
    } catch {
      // coba kandidat berikutnya
    }
  }
  if (!chapter) notFound();
  const readSlug = readSource === resolved.source ? resolved.sourceSlug : sourceSlug;

  const series = await getSeries(readSource, readSlug).catch(() => null);

  const chapterNum = chapter.chapter_number ?? 0;
  const pages = (chapter.pages || []).map((p) => ({ ...p }));

  return (
    <ReaderShell
      source={readSource}
      slug={readSlug}
      chapterId={chapterId}
      chapterNumber={chapterNum}
      chapterTitle={chapter.title}
      seriesTitle={series?.title || slug}
      seriesType={series?.type}
      type={resolved.type}
      pages={pages}
      apiUrl={API_URL}
    />
  );
}

export function CanonicalReader({ type, slug, chapterId }: {
  type: string;
  slug: string;
  chapterId: string;
}) {
  return (
    <Suspense fallback={<ReaderSkeleton pageCount={2} />}>
      <CanonicalReaderContent type={type} slug={slug} chapterId={chapterId} />
    </Suspense>
  );
}
