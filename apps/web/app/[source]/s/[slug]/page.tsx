import { getSeriesDetail, getSeries, getMangaSources, API_URL } from '@/lib/api';
import { ChapterList } from '@/components/ChapterList';
import { Synopsis } from '@/components/Synopsis';
import { SourceBadge, SOURCE_LABELS } from '@/components/SourceBadge';
import { TYPE_META, TypeBadge } from '@/components/TypeBadge';
import { BookmarkButton } from '@/components/BookmarkButton';
import { SourceSwitcher } from '@/components/SourceSwitcher';
import { DetailSkeleton } from '@/components/Skeleton';
import { Suspense, cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const runtime = 'edge';
export const revalidate = 300;

// Shared loader — generateMetadata + page render berbagi satu fetch (React cache).
const loadDetail = cache(async (source: string, sourceId: string) => {
  const [s, src] = await Promise.all([
    getSeriesDetail(source, sourceId, 'id'),
    getMangaSources(source, sourceId).catch(() => null),
  ]);
  const allSources = src?.sources?.length
    ? [...new Set([...src.sources.map((x) => x.source), source])]
    : [source];
  return { series: s, srcs: src, allSources };
});

export async function generateMetadata({ params, searchParams }: { params: { source: string; slug: string }; searchParams: { id?: string } }): Promise<Metadata> {
  const sourceId = searchParams.id ?? params.slug;
  try {
    const { series } = await loadDetail(params.source, sourceId);
    const desc = (series.synopsis ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || undefined;
    return {
      title: `${series.title} - Manga`,
      description: desc,
      alternates: { canonical: `/${params.source}/s/${params.slug}` },
      openGraph: {
        title: series.title,
        description: desc,
        type: 'website',
        locale: 'id_ID',
        images: series.cover_image ? [{ url: series.cover_image }] : undefined,
      },
    };
  } catch {
    return { title: params.slug.replace(/-/g, ' ') };
  }
}

async function DetailContent({ params, searchParams }: { params: { source: string; slug: string }; searchParams: { id?: string } }) {
  const sourceId = searchParams.id ?? params.slug;
  if (!sourceId) return <div className="p-8 text-error">Missing ?id=mangaId</div>;

  let series: Awaited<ReturnType<typeof getSeriesDetail>>;
  let srcs: Awaited<ReturnType<typeof getMangaSources>> | null = null;
  let allSources: string[] = [];
  try {
    // Fetch detail + aggregated sources in parallel so the header can show
    // every source that hosts this manga (badges), not just the current one.
    const loaded = await loadDetail(params.source, sourceId);
    series = loaded.series;
    srcs = loaded.srcs;
    allSources = loaded.allSources;
  } catch (e) {
    return <div className="p-8 text-error">Gagal memuat: {String(e)}</div>;
  }

  const chapters = series.chapters;

  // Merge genre + author dari source lain (source aktif bisa kosong).
  let genres: string[] = series.genres ?? [];
  let author: string | null | undefined = series.author;
  const otherLinks = srcs?.sources?.filter((x) => x.source !== params.source) ?? [];
  if (otherLinks.length > 0) {
    const extras = await Promise.allSettled(
      otherLinks.slice(0, 3).map((link) =>
        Promise.race([
          getSeries(link.source, link.sourceSlug).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ])
      )
    );
    const ok = extras.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    genres = [...new Set([...genres, ...ok.flatMap((d) => d.genres ?? [])])];
    if (!author || author === '-') {
      const a = ok.find((d) => d.author && d.author !== '-');
      if (a) author = a.author;
    }
  }

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
          }),
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

          {/* Source picker — independent source switch */}
          <div className="mt-3 flex justify-center md:justify-start">
            <SourceSwitcher
              currentSource={params.source}
              sourceId={sourceId}
              canonicalSlug={params.slug}
              chapterNumber={0}
              apiUrl={API_URL}
              mode="detail"
            />
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

      {/* Chapter list — toggle button + slide-up panel */}
      <ChapterList chapters={chapters} source={params.source} slug={params.slug} />

      {/* Toolbox — floating bottom bar (sticky saat scroll): bookmark + Mulai Baca */}
      {startChapterId && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="nav-island flex w-full max-w-md items-center gap-2 rounded-xl p-2 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
            <BookmarkButton slug={params.slug} />
            <Link
              href={`/${params.source}/s/${params.slug}/${startChapterId}?mangaId=${params.slug.split('--').pop()}`}
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

// Shell instan: user langsung lihat skeleton, data fetch di background.
export default function SeriesDetail({ params, searchParams }: { params: { source: string; slug: string }; searchParams: { id?: string } }) {
  return (
    <main className="max-w-2xl mx-auto px-4 pb-28">
      <Suspense fallback={<DetailSkeleton />}>
        <DetailContent params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
