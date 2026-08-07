import { searchMerged } from '@/lib/api';
import { MangaCard } from '@/components/MangaCard';
import Link from 'next/link';

export const runtime = 'edge';
export const revalidate = 300;

export default async function Home() {
  let manga: any[] = [];
  let sourcesQueried: string[] = [];
  let error: string | null = null;
  try {
    const res = await searchMerged('');
    manga = res.data;
    sourcesQueried = res.sources_queried;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Manga Indonesia</h1>
          <p className="text-secondary text-sm">Baca manga/manhwa/manhua terjemahan Indonesia</p>
        </div>
        <Link href="/status" prefetch={false} className="text-sm text-secondary hover:text-accent">Status Sumber</Link>
      </div>
      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">Gagal memuat: {error}</div>}
      <p className="text-xs text-muted mb-4">Sumber: {sourcesQueried.join(', ') || 'tidak ada'}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {manga.map((m: any) => {
          const item = m.data || m;
          const source = item.sources?.includes('komiku') ? 'komiku' : item.source;
          return (
            <MangaCard
              key={`${item.source}-${item.slug}`}
              manga={{ id: item.slug, title: item.title, cover: item.cover_image, slug: item.slug }}
              source={source}
              sources={(item.sources as string[]) || [item.source]}
            />
          );
        })}
      </div>
    </main>
  );
}
