export const runtime = 'edge';
import { API_URL, type Series } from '@/lib/api';
import { MangaCard } from '@/components/MangaCard';

export const dynamic = 'force-dynamic';

export default async function BookmarksPage() {
  let series: Series[] = [];
  let error: string | null = null;
  try {
    const res = await fetch(`${API_URL}/api/user/bookmarks`, { cache: 'no-store', credentials: 'include' });
    if (res.status === 401) error = 'Masuk untuk lihat bookmark.';
    else if (!res.ok) throw new Error(`HTTP ${res.status}`);
    else series = (await res.json()).data || [];
  } catch (e) { error = String(e); }

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Bookmark</h1>
      {error && <div className="text-secondary text-sm">{error}</div>}
      {series.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {series.map((m) => <MangaCard key={m.slug} manga={{ id: m.external_id || m.slug, title: m.title, cover: m.cover_image || null, slug: m.slug }} />)}
        </div>
      ) : !error ? <p className="text-muted text-sm">Belum ada bookmark.</p> : null}
    </main>
  );
}
