export const runtime = 'edge';
import { getSeries, getChapters } from '@/lib/api';
import { ChapterList } from '@/components/ChapterList';
import Link from 'next/link';

export const revalidate = 300;

export default async function SeriesDetail({ params, searchParams }: { params: { source: string; slug: string }; searchParams: { id?: string } }) {
  const sourceId = searchParams.id;
  if (!sourceId) return <div className="p-8 text-error">Missing ?id=mangaId</div>;

  let series, chapters;
  try {
    series = await getSeries(params.source, sourceId);
    chapters = await getChapters(params.source, sourceId, 'id');
  } catch (e) {
    return <div className="p-8 text-error">Gagal memuat: {String(e)}</div>;
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <Link href="/" className="text-secondary text-sm hover:text-accent mb-4 inline-block">← Beranda</Link>
      <div className="flex gap-5 mb-6">
        {series.cover_image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={series.cover_image} alt={series.title} className="w-32 h-48 object-cover rounded border border-subtle flex-shrink-0" />
        )}
        <div>
          <h1 className="text-2xl font-semibold mb-2">{series.title}</h1>
          <div className="flex gap-2 mb-2">
            <span className="text-xs px-2 py-0.5 border border-border-default rounded">{series.type}</span>
            <span className="text-xs px-2 py-0.5 border border-border-default rounded">{series.status}</span>
          </div>
          {series.author && <p className="text-secondary text-sm">Author: {series.author}</p>}
          {series.genres && series.genres.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">{series.genres.map((g) => <span key={g} className="text-xs text-muted">{g}</span>)}</div>
          )}
        </div>
      </div>
      {series.synopsis && <p className="text-secondary text-sm mb-6 whitespace-pre-line">{series.synopsis}</p>}
      <h2 className="text-lg font-medium mb-3">Chapter ({chapters.length})</h2>
      <ChapterList chapters={chapters} source={params.source} slug={params.slug} />
    </main>
  );
}
