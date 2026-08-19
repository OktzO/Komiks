'use client';
import { useEffect, useState } from 'react';
import { getAuthApiUrl } from '@/lib/api';

type HistoryChapter = { id: string; series_slug: string; chapter_number: number; title?: string | null };

export default function HistoryPage() {
  const [chapters, setChapters] = useState<HistoryChapter[] | null>(null);
  const [guest, setGuest] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const base = await getAuthApiUrl();
        const res = await fetch(`${base}/api/user/history`, {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });
        if (!alive) return;
        if (res.status === 401) { setGuest(true); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        setChapters(j.data || []);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Riwayat Baca</h1>
      {guest && <div className="text-secondary text-sm">Masuk untuk lihat riwayat baca.</div>}
      {error && <div className="text-error text-sm">{error}</div>}
      {chapters === null && !guest && !error && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-11 w-full animate-pulse rounded bg-card" />
          ))}
        </div>
      )}
      {chapters && chapters.length === 0 && !guest && <p className="text-muted text-sm">Belum ada riwayat.</p>}
      {chapters && chapters.length > 0 && (
        <div className="divide-y divide-border-subtle border border-subtle rounded bg-card">
          {chapters.map((c) => {
            const rawId = c.id.includes(':') ? c.id.slice(c.id.lastIndexOf(':') + 1) : c.id;
            return (
              <a key={c.id} href={`/komiku/s/${c.series_slug}/${rawId}`} className="flex justify-between px-4 py-2.5 hover:bg-elevated text-sm">
                <span className="text-primary">Ch. {c.chapter_number}{c.title ? ` — ${c.title}` : ''}</span>
                <span className="text-muted text-xs">Lanjut →</span>
              </a>
            );
          })}
        </div>
      )}
    </main>
  );
}