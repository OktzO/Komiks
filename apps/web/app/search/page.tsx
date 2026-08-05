export const runtime = 'edge';
import { MangaCard } from '@/components/MangaCard';
import { API_URL, type Series } from '@/lib/api';

export default async function SearchPage({ searchParams }: { searchParams: { q?: string } }) {
  const q = searchParams.q?.trim();
  let results: Series[] = [];
  let error: string | null = null;

  if (q) {
    try {
      const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(q)}`, { next: { revalidate: 120 } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json() as { data: Series[] };
      results = j.data || [];
    } catch (e) {
      error = String(e);
    }
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Cari Manga</h1>
      <form action="/search" className="mb-6">
        <input
          name="q"
          defaultValue={q || ''}
          placeholder="Judul manga..."
          className="w-full max-w-md bg-card border border-border-default rounded px-4 py-2 text-primary placeholder:text-muted focus:outline-none focus:border-accent"
        />
        <button type="submit" className="ml-2 px-4 py-2 border border-border-default rounded text-sm hover:bg-elevated">Cari</button>
      </form>
      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">{error}</div>}
      {q && !error && <p className="text-secondary text-sm mb-4">{results.length} hasil untuk "{q}"</p>}
      {results.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {results.map((m) => <MangaCard key={m.external_id} manga={{ id: m.external_id, title: m.title, cover: m.cover_image || null, slug: m.slug }} />)}
        </div>
      )}
    </main>
  );
}
