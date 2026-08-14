'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MangaCard } from '@/components/MangaCard';
import { getAuthApiUrl } from '@/lib/api';

type BookmarkRow = { slug: string; title: string | null; cover_image: string | null; external_id: string | null };

export default function BookmarksPage() {
  const [items, setItems] = useState<BookmarkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const base = await getAuthApiUrl();
        const r = await fetch(`${base}/api/user/bookmarks`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (r.status === 401) { if (alive) setError('guest'); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) setItems(j.data || []);
      } catch (e) { if (alive) setError(String(e)); }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Bookmark</h1>
      {error === 'guest' && (
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
      {items && items.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {items.map((m) => (
            <MangaCard key={m.slug} manga={{ id: m.external_id || m.slug, title: m.title ?? '', cover: m.cover_image || null, slug: m.slug }} />
          ))}
        </div>
      ) : items && items.length === 0 && !error ? (
        <p className="text-muted text-sm">
          Belum ada bookmark.{' '}
          <Link href="/search" prefetch={false} className="text-accent hover:underline">Cari manga</Link>
        </p>
      ) : null}
    </main>
  );
}
