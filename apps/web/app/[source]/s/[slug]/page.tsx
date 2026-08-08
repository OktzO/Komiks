import { getSeriesDetail, API_URL } from '@/lib/api';
import { ChapterList } from '@/components/ChapterList';
import { Synopsis } from '@/components/Synopsis';
import { SourceBadge } from '@/components/SourceBadge';
import { SourceSwitcher } from '@/components/SourceSwitcher';
import Link from 'next/link';

export const runtime = 'edge';
export const revalidate = 300;

export default async function SeriesDetail({ params, searchParams }: { params: { source: string; slug: string }; searchParams: { id?: string } }) {
  const sourceId = searchParams.id;
  if (!sourceId) return <div className="p-8 text-error">Missing ?id=mangaId</div>;

  let series: Awaited<ReturnType<typeof getSeriesDetail>>;
  try {
    series = await getSeriesDetail(params.source, sourceId, 'id');
  } catch (e) {
    return <div className="p-8 text-error">Gagal memuat: {String(e)}</div>;
  }

  const chapters = series.chapters;

  return (
    <main className="max-w-2xl mx-auto px-4 pb-8">
      <Link href="/" prefetch={false} className="text-secondary text-sm hover:text-accent mb-4 inline-block">← Beranda</Link>

      {/* Poster banner — centered, top */}
      {series.cover_image && (
        <div className="flex justify-center mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={series.cover_image}
            alt={series.title}
            className="w-36 h-52 object-cover rounded-xl border border-border-default shadow-lg"
          />
        </div>
      )}

      {/* Title + author — below poster */}
      <div className="text-center mb-5">
        <h1 className="text-xl font-semibold text-primary leading-snug">{series.title}</h1>
        {series.author && series.author !== '-' && (
          <p className="text-secondary text-sm mt-1">{series.author}</p>
        )}
        <div className="flex items-center justify-center gap-2 mt-2">
          <span className="text-[10px] px-2 py-0.5 border border-border-subtle rounded capitalize text-muted">{series.type}</span>
          <span className="text-[10px] px-2 py-0.5 border border-border-subtle rounded text-muted capitalize">{series.status}</span>
          <SourceBadge sources={[params.source]} size="sm" />
        </div>
        {/* Source picker — independent source switch */}
        <SourceSwitcher
          currentSource={params.source}
          sourceId={sourceId}
          canonicalSlug={params.slug}
          chapterNumber={0}
          apiUrl={API_URL}
          mode="detail"
        />
      </div>

      {/* Synopsis — bordered box, collapsible */}
      {series.synopsis && (
        <div className="mb-4">
          <Synopsis text={series.synopsis} />
        </div>
      )}

      {/* Divider between synopsis and chapter list */}
      <div className="border-t border-border-subtle my-4" />

      {/* Chapter list — toggle button + slide-up panel */}
      <ChapterList chapters={chapters} source={params.source} slug={params.slug} />
    </main>
  );
}
