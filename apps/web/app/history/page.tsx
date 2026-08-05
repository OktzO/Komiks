export const runtime = 'edge';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  let chapters: { id: string; series_slug: string; chapter_number: number; title?: string | null }[] = [];
  let error: string | null = null;
  try {
    const res = await fetch(`${API_URL}/api/user/history`, { cache: 'no-store', credentials: 'include' });
    if (res.status === 401) error = 'Masuk untuk lihat riwayat baca.';
    else if (!res.ok) throw new Error(`HTTP ${res.status}`);
    else chapters = (await res.json()).data || [];
  } catch (e) { error = String(e); }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Riwayat Baca</h1>
      {error && <div className="text-secondary text-sm">{error}</div>}
      {!error && chapters.length === 0 && <p className="text-muted text-sm">Belum ada riwayat.</p>}
      <div className="divide-y divide-border-subtle border border-subtle rounded bg-card">
        {chapters.map((c) => {
          const rawId = c.id.includes(':') ? c.id.slice(c.id.lastIndexOf(':') + 1) : c.id;
          return (
            <a key={c.id} href={`/${c.series_slug.split('--')[0] ? 'mangadex' : 'mangadex'}/s/${c.series_slug}/${rawId}`} className="flex justify-between px-4 py-2.5 hover:bg-elevated text-sm">
              <span className="text-primary">Ch. {c.chapter_number}{c.title ? ` — ${c.title}` : ''}</span>
              <span className="text-muted text-xs">Lanjut →</span>
            </a>
          );
        })}
      </div>
    </main>
  );
}
