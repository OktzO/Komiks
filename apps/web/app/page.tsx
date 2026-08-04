import { fetchPopularIndonesian } from '@/lib/api';
import { MangaCard } from '@/components/MangaCard';

export const revalidate = 600;

export default async function Home() {
  let manga: Awaited<ReturnType<typeof fetchPopularIndonesian>> = [];
  let error: string | null = null;
  try {
    manga = await fetchPopularIndonesian();
  } catch (e) {
    error = String(e);
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Manga Indonesia</h1>
      <p className="text-secondary text-sm mb-6">Baca manga/manhwa/manhua terjemahan Indonesia</p>
      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">Gagal memuat: {error}</div>}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {manga.map((m) => <MangaCard key={m.id} manga={m} />)}
      </div>
    </main>
  );
}
