import { Suspense } from 'react';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { loadCanonical } from './loadCanonical';
import { ChapterSection } from './ChapterSection';
import { SourceSection } from './SourceSection';
import { ChapterListSkeleton, SourceSkeleton } from '@/components/Skeleton';
import { Synopsis } from '@/components/Synopsis';
import { SourceBadge, SOURCE_LABELS } from '@/components/SourceBadge';
import { TYPE_META, TypeBadge } from '@/components/TypeBadge';
import { BookmarkButton } from '@/components/BookmarkButton';
import type { getSeriesDetail } from '@/lib/api';

type SeriesDetail = Awaited<ReturnType<typeof getSeriesDetail>>;

// DetailShell — JSX dipindah dari app/[source]/s/[slug]/page.tsx:141-296.
// Adaptasi kanonik: terima `series` + `type` + `slug` (+ `source` aktual)
// sebagai props. Yang TIDAK ikut pindah (streaming terpisah):
// - ChapterList → ChapterSection (Suspense, auto-pick recommended source)
// - SourceSwitcher header → SourceSection (Suspense)
// - Merge genre/author lintas-source → V1 pakai data series langsung
// - Badges multi-source → V1 single badge (picker penuh di SourceSection)
// BookmarkButton + link Mulai Baca dipertahankan dengan URL lama sementara
// (Task 5 memigrasikan ke typed URL).
function DetailShell({ series, type, slug, source }: {
  series: SeriesDetail;
  type: string;
  slug: string;
  source: string;
}) {
  const genres: string[] = series.genres ?? [];
  const author: string | null | undefined = series.author;
  const allSources = [source];
  const chapters = series.chapters;

  // Mulai Baca → chapter pertama (chapter_number terkecil).
  const startChapter = chapters.length > 0
    ? chapters.reduce((min, c) => (c.chapter_number < min.chapter_number ? c : min))
    : null;
  const startChapterId = startChapter
    ? (startChapter.id.includes(':') ? startChapter.id.slice(startChapter.id.lastIndexOf(':') + 1) : startChapter.id)
    : null;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Book',
            name: series.title,
            image: series.cover_image,
            author: author && author !== '-' ? { '@type': 'Person', name: author } : undefined,
            genre: genres,
            inLanguage: 'id',
          }).replaceAll('<', '\\u003c'),
        }}
      />
      <Link href="/" prefetch={false} className="text-secondary text-sm hover:text-accent mb-4 inline-block">← Beranda</Link>

      {/* Poster + info — mobile: stacked centered; md+: split (pola komikomi.net) */}
      <div className="md:flex md:gap-6 md:items-start mb-5">
        {series.cover_image && (
          <div className="flex justify-center md:shrink-0 mb-4 md:mb-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={series.cover_image}
              alt={series.title}
              loading="lazy"
              decoding="async"
              className="w-36 h-52 object-cover rounded-xl border border-border-default shadow-lg"
            />
          </div>
        )}

        <div className="text-center md:text-left flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-primary leading-snug">{series.title}</h1>
          {author && author !== '-' && (
            <p className="text-secondary text-sm mt-1">{author}</p>
          )}

          {/* Meta badges — type (flag+glow) + status dengan indikator jelas */}
          <div className="flex items-center justify-center md:justify-start flex-wrap gap-2 mt-2.5">
            <TypeBadge type={series.type} />
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded border border-border-default text-secondary capitalize">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${series.status === 'ongoing' ? 'bg-success animate-pulse' : 'bg-muted'}`} aria-hidden="true" />
              {series.status || 'N/A'}
            </span>
            <SourceBadge sources={allSources} size="sm" />
          </div>
        </div>
      </div>

      {/* Synopsis — bordered box, collapsible */}
      {series.synopsis && (
        <div className="mb-4">
          <Synopsis text={series.synopsis} />
        </div>
      )}

      {/* Divider between synopsis and detail info */}
      <div className="border-t border-border-subtle my-4" />

      {/* Detail Info — type, status, source, author, genre (pola doujin.desu.xxx) */}
      <div className="mb-4">
        <h2 className="font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted mb-3">Detail Info</h2>
        <div className="divide-y divide-border-subtle text-sm">
          <div className="py-2.5">
            <span className="block font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted mb-1">Type</span>
            <span className="inline-flex items-center gap-1.5 text-primary font-semibold capitalize">
              {series.type ? (
                <>
                  <span aria-hidden="true">{TYPE_META[series.type.toLowerCase()]?.flag ?? ''}</span>
                  {series.type}
                </>
              ) : (
                <span className="text-secondary font-normal">N/A</span>
              )}
            </span>
          </div>
          <div className="py-2.5">
            <span className="block font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted mb-1">Status</span>
            <span className="text-secondary capitalize">{series.status || 'N/A'}</span>
          </div>
          <div className="py-2.5">
            <span className="block font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted mb-1">Source</span>
            <span className="flex flex-wrap gap-1.5">
              {allSources.length > 0 ? (
                allSources.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5 rounded-md bg-card/70 border border-border-subtle px-2 py-1 text-[10px] font-black uppercase tracking-wide text-secondary">
                    <SourceBadge sources={[s]} size="sm" />
                    {SOURCE_LABELS[s] ?? s}
                  </span>
                ))
              ) : (
                <span className="text-secondary">N/A</span>
              )}
            </span>
          </div>
          <div className="py-2.5">
            <span className="block font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted mb-1">Author</span>
            <span className="text-secondary">{author && author !== '-' ? author : 'N/A'}</span>
          </div>
          <div className="py-2.5">
            <span className="block font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted mb-1">Genre</span>
            <span className="flex flex-wrap gap-1.5">
              {genres.length > 0 ? (
                genres.map((g: string) => (
                  <span key={g} className="rounded-md border border-border-subtle bg-card/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-secondary">{g}</span>
                ))
              ) : (
                <span className="text-secondary">N/A</span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Divider between detail info and chapter list */}
      <div className="border-t border-border-subtle my-4" />

      {/* Toolbox — floating bottom bar (sticky saat scroll): bookmark + Mulai Baca */}
      {startChapterId && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="nav-island flex w-full max-w-md items-center gap-2 rounded-xl p-2 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
            <BookmarkButton slug={slug} title={series.title} cover={series.cover_image} source={source} />
            <Link
              href={`/${type}/${slug}/${startChapterId}`}
              prefetch={false}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white bg-white px-5 text-sm font-semibold text-black hover:opacity-90 transition-opacity"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              Mulai Baca
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

export async function CanonicalDetail({ type, slug }: { type: string; slug: string }) {
  let loaded: Awaited<ReturnType<typeof loadCanonical>>;
  try {
    loaded = await loadCanonical(slug);
  } catch {
    notFound();
  }
  const { resolved, detailPromise, chaptersPromise, sourcesPromise } = loaded;
  // Wrong-type → redirect permanen ke route typed yang benar.
  if (resolved.type !== type) permanentRedirect(`/${resolved.type}/${encodeURIComponent(slug)}`);
  let series: SeriesDetail;
  try {
    series = await detailPromise;
  } catch {
    notFound();
  }
  return (
    <main className="max-w-2xl mx-auto px-4 pb-28">
      <DetailShell series={series} type={type} slug={slug} source={resolved.source} />
      <Suspense fallback={<ChapterListSkeleton />}>
        <ChapterSection slug={slug} canonicalSlug={resolved.slug} chaptersPromise={chaptersPromise} sourcesPromise={sourcesPromise} source={resolved.source} sourceSlug={resolved.sourceSlug} type={type} />
      </Suspense>
      <div className="mt-4">
        <Suspense fallback={<SourceSkeleton />}>
          <SourceSection slug={slug} canonicalSlug={resolved.slug} sourcesPromise={sourcesPromise} source={resolved.source} sourceSlug={resolved.sourceSlug} type={type} />
        </Suspense>
      </div>
    </main>
  );
}
