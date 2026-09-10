'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAuthApiUrl, isValidType, typedChapterUrl, type ComicType } from '@/lib/api';

// History API kirim `type` per row (nullable) — lama/legacy row → 'manga'.
const safeType = (t?: string | null): ComicType =>
  isValidType(t ?? '') ? (t as ComicType) : 'manga';

type HistoryChapter = { id: string; series_slug: string; chapter_number: number; title?: string | null; type?: string | null };

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
    </svg>
  );
}

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
    <main className="relative max-w-4xl mx-auto px-4 py-10 md:py-14">
      <div className="page-decoration" aria-hidden="true" />

      <div className="relative z-10">
        <header className="mb-8">
          <p className="eyebrow mb-2">Lanjutkan bacaan</p>
          <h1 className="font-display text-3xl md:text-4xl font-semibold tracking-tight text-primary">
            Riwayat Baca
          </h1>
          {chapters && chapters.length > 0 && (
            <p className="mt-1.5 text-sm text-secondary">
              <span className="text-primary font-semibold tabular">{chapters.length}</span> chapter terakhir yang kamu buka
            </p>
          )}
        </header>

        {guest && (
          <div className="panel flex flex-col items-center text-center px-6 py-14">
            <div className="w-12 h-12 rounded-full border border-border-default flex items-center justify-center mb-4 bg-sunken">
              <HistoryIcon className="w-5 h-5 text-muted" />
            </div>
            <p className="text-primary font-medium mb-1">Masuk untuk lihat riwayat</p>
            <p className="text-sm text-secondary max-w-sm mb-5">
              Riwayat baca tersimpan otomatis lewat akun Google.
            </p>
            <Link href="/login" prefetch={false} className="btn btn-primary">Masuk sekarang</Link>
          </div>
        )}
        {error && <div className="text-error text-sm panel px-4 py-3" role="alert">{error}</div>}

        {chapters === null && !guest && !error && (
          <div className="space-y-2.5" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 w-full skeleton" aria-hidden="true" />
            ))}
          </div>
        )}

        {chapters && chapters.length === 0 && !guest && (
          <div className="panel flex flex-col items-center text-center px-6 py-14">
            <div className="w-12 h-12 rounded-full border border-border-default flex items-center justify-center mb-4 bg-sunken">
              <HistoryIcon className="w-5 h-5 text-muted" />
            </div>
            <p className="text-primary font-medium mb-1">Belum ada riwayat</p>
            <p className="text-sm text-secondary max-w-sm mb-5">Mulai baca satu chapter — riwayatnya muncul di sini.</p>
            <Link href="/search" prefetch={false} className="btn btn-primary">Cari manga</Link>
          </div>
        )}

        {chapters && chapters.length > 0 && (
          <div className="panel divide-y divide-border-subtle overflow-hidden anim-slide-up">
            {chapters.map((c) => (
              <Link
                key={c.id}
                href={typedChapterUrl(safeType(c.type), c.series_slug, c.id)}
                className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm transition-colors hover:bg-elevated"
              >
                <span className="text-primary font-medium truncate">
                  Ch. <span className="tabular">{c.chapter_number}</span>{c.title ? <span className="text-secondary font-normal"> — {c.title}</span> : ''}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted shrink-0">
                  Lanjut
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
