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

function BookmarkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export default function BookmarksPage() {
  const [items, setItems] = useState<BookmarkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  type LoadResult = { guest: boolean; items: BookmarkRow[] | null };

  const load = async (): Promise<LoadResult> => {
    try {
      const base = await getAuthApiUrl();
      const r = await fetch(`${base}/api/user/bookmarks`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
      if (r.status === 401) return { guest: true, items: null };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return { guest: false, items: (j.data || []) as BookmarkRow[] };
    } catch (e) { throw e; }
  };

  useEffect(() => {
    let alive = true;
    load().then((res) => {
      if (!alive) return;
      setItems(res.items);
      if (res.guest) setError('guest');
    }).catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false };
  }, []);

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
    <main className="relative max-w-6xl mx-auto px-4 py-10 md:py-14">
      <div className="page-decoration" aria-hidden="true" />

      <div className="relative z-10">
        <header className="flex items-end justify-between gap-4 mb-8">
          <div>
            <p className="eyebrow mb-2">Koleksimu</p>
            <h1 className="font-display text-3xl md:text-4xl font-semibold tracking-tight text-primary">
              Bookmark
            </h1>
            {items && items.length > 0 && (
              <p className="mt-1.5 text-sm text-secondary">
                <span className="text-primary font-semibold tabular">{items.length}</span> judul tersimpan
              </p>
            )}
          </div>
          {items && items.length > 0 && !guest && (
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={clearing}
              className="btn btn-ghost !min-h-[38px] text-xs text-secondary hover:text-error"
              title="Hapus semua bookmark"
            >
              {clearing ? 'Menghapus…' : 'Hapus semua'}
            </button>
          )}
        </header>

        {guest && (
          <div className="panel flex flex-col items-center text-center px-6 py-14">
            <div className="w-12 h-12 rounded-full border border-border-default flex items-center justify-center mb-4 bg-sunken">
              <BookmarkIcon className="w-5 h-5 text-muted" />
            </div>
            <p className="text-primary font-medium mb-1">Masuk untuk lihat bookmark</p>
            <p className="text-sm text-secondary max-w-sm mb-5">
              Bookmark tersinkron otomatis antar perangkat lewat akun Google.
            </p>
            <Link href="/login" prefetch={false} className="btn btn-primary">Masuk sekarang</Link>
          </div>
        )}
        {error && error !== 'guest' && (
          <div className="text-error text-sm panel px-4 py-3" role="alert">{error}</div>
        )}

        {items === null && !error && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4" aria-busy="true">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] skeleton" aria-hidden="true" />
            ))}
          </div>
        )}

        {items && items.length === 0 && !guest && (
          <div className="panel flex flex-col items-center text-center px-6 py-14">
            <div className="w-12 h-12 rounded-full border border-border-default flex items-center justify-center mb-4 bg-sunken">
              <BookmarkIcon className="w-5 h-5 text-muted" />
            </div>
            <p className="text-primary font-medium mb-1">Belum ada bookmark</p>
            <p className="text-sm text-secondary max-w-sm mb-5">
              Simpan judul favoritmu dengan tombol bookmark di halaman detail.
            </p>
            <Link href="/search" prefetch={false} className="btn btn-primary">Cari manga</Link>
          </div>
        )}

        {items && items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-6 anim-slide-up">
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
                  <div className="mt-1.5 text-[10px] text-muted/70">
                    {m.bookmark_created_at ? `ditambahkan ${relativeTime(m.bookmark_created_at)}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Clear-all confirmation — irreversible, dialog eksplisit */}
        {confirmOpen && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" aria-modal="true" role="dialog" aria-labelledby="clear-all-title">
            <div className="w-full max-w-sm panel p-6 text-center shadow-[0_24px_64px_-16px_oklch(0%_0_0/0.8)]">
              <h2 id="clear-all-title" className="text-lg font-semibold text-primary">Hapus semua bookmark?</h2>
              <p className="text-sm text-secondary mt-2">Semua judul yang tersimpan akan hilang. Tindakan ini tidak bisa dibatalkan.</p>
              <div className="mt-5 flex gap-2 justify-center">
                <button onClick={() => setConfirmOpen(false)} disabled={clearing} className="btn btn-ghost !min-h-[40px] text-sm">
                  Batal
                </button>
                <button onClick={clearAll} disabled={clearing} className="btn !min-h-[40px] text-sm bg-error/15 text-error border border-error/30 hover:bg-error/25">
                  {clearing ? 'Menghapus…' : 'Hapus semua'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
