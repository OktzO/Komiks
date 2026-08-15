'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MangaCard } from '@/components/MangaCard';
import { getAuthApiUrl } from '@/lib/api';

type BookmarkRow = {
  slug: string;
  title: string | null;
  cover_image: string | null;
  external_id: string | null;
  type: string | null;
  status: string | null;
  bookmark_source: string | null;
  bookmark_url: string | null;
  bookmark_created_at: number | null;
};

const relativeTime = (ts: number): string => {
  const d = Math.floor((Date.now() - ts * 1000) / 1000);
  if (d < 60) return 'baru saja';
  if (d < 3600) return `${Math.floor(d / 60)}m lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)}j lalu`;
  return `${Math.floor(d / 86400)}h lalu`;
};

export default function BookmarksPage() {
  const [items, setItems] = useState<BookmarkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = async () => {
    try {
      const base = await getAuthApiUrl();
      const r = await fetch(`${base}/api/user/bookmarks`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
      if (r.status === 401) { setError('guest'); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setItems(j.data || []);
    } catch (e) { setError(String(e)); }
  };

  useEffect(() => { let alive = true; load().then(() => alive && setItems((x) => x)); return () => { alive = false }; }, []);

  const clearAll = async () => {
    setClearing(true);
    try {
      const base = await getAuthApiUrl();
      const r = await fetch(`${base}/api/user/bookmarks`, { method: 'DELETE', credentials: 'include', signal: AbortSignal.timeout(8000) });
      if (r.status === 401) { window.location.href = '/login'; return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setItems([]);
    } catch (e) { setError(String(e)); } finally {
      setClearing(false);
      setConfirmOpen(false);
    }
  };

  const guest = error === 'guest';

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-2xl font-semibold">Bookmark</h1>
        {items && items.length > 0 && !guest && (
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={clearing}
            className="text-xs text-secondary hover:text-error transition-colors"
            title="Hapus semua bookmark"
          >
            {clearing ? 'Menghapus...' : 'Clear all'}
          </button>
        )}
      </div>

      {guest && (
        <div className="text-secondary text-sm">
          Masuk untuk lihat bookmark.{' '}
          <Link href="/login" prefetch={false} className="text-accent hover:underline">Masuk sekarang</Link>
        </div>
      )}
      {error && error !== 'guest' && <div className="text-error text-sm">{error}</div>}

      {items === null && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-[3/4] animate-pulse rounded border border-subtle bg-card" />
          ))}
        </div>
      )}

      {items && items.length === 0 && !guest && (
        <div className="text-center py-12">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-muted mb-3" aria-hidden="true">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          <p className="text-secondary mb-2">Belum ada bookmark.</p>
          <Link href="/search" prefetch={false} className="text-accent hover:underline">Cari manga</Link>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {items.map((m) => {
            const source = m.bookmark_source || 'komiku';
            return (
              <div key={m.slug} className="group">
                <MangaCard
                  source={source}
                  manga={{ id: m.external_id || m.slug, title: m.title ?? '', cover: m.cover_image || null, slug: m.slug }}
                  type={m.type ?? m.status}
                  sources={m.bookmark_source ? [m.bookmark_source] : undefined}
                />
                <div className="mt-1 text-[10px] text-muted truncate">{m.title}</div>
                {m.bookmark_created_at && <div className="text-[10px] text-muted/60">ditambahkan {relativeTime(m.bookmark_created_at)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* Clear-all confirmation (kept inline to avoid forcing a text-match gate) */}
      {confirmOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 backdrop-blur-sm" aria-modal="true" role="dialog">
          <div className="w-full max-w-sm rounded-2xl bg-card border border-border-default p-6 text-center">
            <h2 className="text-lg font-semibold text-primary">Hapus semua bookmark?</h2>
            <p className="text-sm text-secondary mt-2">Tindakan ini tidak bisa dibatalkan.</p>
            <div className="mt-4 flex gap-2 justify-center">
              <button onClick={() => setConfirmOpen(false)} disabled={clearing} className="px-4 py-2 text-sm border border-border-subtle rounded-lg hover:bg-bg-secondary">
                Batal
              </button>
              <button onClick={clearAll} disabled={clearing} className="px-4 py-2 text-sm bg-error/10 text-error rounded-lg hover:bg-error/20">
                {clearing ? 'Menghapus...' : 'Hapus semua'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
