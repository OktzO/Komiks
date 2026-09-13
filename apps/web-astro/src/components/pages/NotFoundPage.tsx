'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchHomepage, safeType, typedUrl } from '@/lib/api';

/* ── Terminal log lines — animasi dikte, baris demi baris ────────────────── */
const LOG = [
  { text: '$ navigate --to requested-page', cls: 'text-primary' },
  { text: '  → resolving route segment…', cls: 'text-muted' },
  { text: '  → querying D1 catalog…', cls: 'text-muted' },
  { text: '  → probing 5 sources…', cls: 'text-muted' },
  { text: '  ✗ no match in any source', cls: 'text-error' },
  { text: 'Error 404 — Page not found', cls: 'text-error font-semibold' },
];

const QUICK_LINKS = [
  { href: '/', label: 'Beranda' },
  { href: '/search', label: 'Cari Judul' },
  { href: '/bookmark', label: 'Bookmark' },
  { href: '/history', label: 'Riwayat' },
  { href: '/status', label: 'Status Sumber' },
];

type Suggest = { slug: string; title: string; type?: string | null; cover_image?: string | null; cover?: string | null };

const itemOf = (m: any) => m.data ?? m;

export default function NotFound() {
  const [pathname, setPathname] = useState('');
  useEffect(() => { setPathname(window.location.pathname); }, []);
  const [suggestions, setSuggestions] = useState<Suggest[]>([]);

  // Pencarian judul acak — hanya untuk mengisi slot "mungkin yang kamu cari".
  useEffect(() => {
    let cancelled = false;
    fetchHomepage()
      .then((res) => {
        if (cancelled) return;
        const items: Suggest[] = (res.data ?? [])
          .map(itemOf)
          .filter((m: any) => m?.slug && m?.title)
          .map((m: any) => ({
            slug: m.slug,
            title: m.title,
            type: m.type ?? null,
            cover_image: m.cover_image ?? m.cover ?? null,
          }));
        // Acak → tidak selalu 5 judul yang sama tiap kali kena 404.
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [items[i], items[j]] = [items[j], items[i]];
        }
        setSuggestions(items.slice(0, 5));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const badPath = useMemo(() => {
    const p = pathname.length > 44 ? `${pathname.slice(0, 44)}…` : pathname;
    return p || '/';
  }, [pathname]);

  return (
    <main className="relative mx-auto flex min-h-[calc(100dvh-6rem)] max-w-3xl flex-col justify-center px-5 pb-24 pt-10">
      {/* Ambient glow — sama dgn hero homepage, dipoles ulang di sini */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-72 w-72 md:h-[380px] md:w-[520px] rounded-full radial-ambient opacity-70 blur-2xl"
      />

      <div className="relative z-10">
        {/* ── Eyebrow ── */}
        <div className="anim-rise inline-flex items-center gap-2 rounded-full glass-pill px-3.5 py-1.5">
          <span className="status-dot down live" aria-hidden="true" />
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-secondary">
            HTTP 404 · Route Not Found
          </span>
        </div>

        {/* ── Terminal card ── */}
        <div className="anim-rise bento-card mt-5 overflow-hidden" style={{ animationDelay: '60ms' }}>
          {/* Title bar */}
          <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-secondary/50 px-4 py-2.5">
            <span className="flex gap-1.5" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-error/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-muted/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
            </span>
            <span className="ml-1 font-mono text-[11px] text-muted">terminal — oktz. router</span>
          </div>

          {/* Log body */}
          <div className="px-4 py-4 sm:px-5 sm:py-5">
            {/* Baris tetap ada di HTML (aman tanpa JS) — reveal distagger via
                animation-delay murni CSS (opacity+transform → compositor). */}
            <pre className="overflow-x-auto font-mono text-[11.5px] leading-relaxed sm:text-[13px]">
              {LOG.map((l, i) => (
                <div key={i} className={`${l.cls} anim-rise`} style={{ animationDelay: `${i * 340}ms` }}>
                  {l.text}
                </div>
              ))}
              <span
                className="anim-rise inline-block h-[1.05em] w-[7px] translate-y-[2px] animate-pulse bg-accent"
                style={{ animationDelay: `${LOG.length * 340}ms` }}
                aria-hidden="true"
              />
            </pre>

            {/* 404 raksasa — outline stroke, selaras dgn angka "5" di hero */}
            <div className="mt-5 flex items-end justify-between gap-4">
              <div
                aria-hidden="true"
                className="select-none font-display text-[5.5rem] font-bold leading-[0.82] tracking-tighter text-transparent sm:text-[7.5rem]"
                style={{ WebkitTextStroke: '1.5px var(--border-default)' }}
              >
                404
              </div>
              <p className="pb-1 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                exit code: 404
                <br />
                handler: not-found
              </p>
            </div>
          </div>
        </div>

        {/* ── Copy ── */}
        <h1 className="anim-rise mt-7 font-display text-2xl font-semibold tracking-tight text-primary sm:text-3xl" style={{ animationDelay: '120ms' }}>
          Halaman ini nggak ada di katalog.
        </h1>
        <p className="anim-rise mt-2.5 max-w-xl text-sm leading-relaxed text-secondary sm:text-base" style={{ animationDelay: '170ms' }}>
          Kami sudah mencari ke seluruh sumber. Dua kali. Tetap nggak ketemu — tapi setidaknya error handling-nya jalan dengan sempurna.
        </p>
        <p className="anim-rise mt-2 font-mono text-xs text-muted" style={{ animationDelay: '210ms' }}>
          path: <span className="text-secondary">{badPath}</span>
        </p>

        {/* ── Actions ── */}
        <div className="anim-rise mt-6 flex flex-wrap items-center gap-3" style={{ animationDelay: '250ms' }}>
          <a href="/"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-zinc-950 shadow-sm transition-all hover:opacity-90 active:scale-95"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 3l-1.4 1.4L16.2 10H4v2h12.2l-5.6 5.6L12 19l8-8-8-8z" transform="rotate(180 12 11)" />
            </svg>
            Kembali ke Beranda
          </a>
          <a href="/search"
            className="inline-flex h-11 items-center gap-2 rounded-full border border-border-default bg-bg-secondary px-6 text-sm font-medium text-primary transition-colors hover:border-border-default hover:bg-bg-secondary/80"
          >
            Cari Judul
          </a>
        </div>

        {/* ── Quick links ── */}
        <div className="anim-rise mt-8 border-t border-border-subtle pt-5" style={{ animationDelay: '290ms' }}>
          <p className="mb-3 font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted">
            Atau mungkin kamu mencari salah satu dari ini?
          </p>
          <div className="flex flex-wrap gap-2">
            {QUICK_LINKS.map((l) => (
              <a key={l.href}
                href={l.href}
                className="rounded-full border border-border-subtle bg-card/60 px-4 py-2 text-xs text-secondary transition-all hover:scale-[1.02] hover:border-border-default hover:bg-bg-secondary hover:text-primary"
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>

        {/* ── Suggestions: judul acak dari katalog (client fetch, graceful) ── */}
        {suggestions.length > 0 && (
          <div className="anim-rise mt-8" style={{ animationDelay: '330ms' }}>
            <div className="mb-3 flex items-baseline justify-between">
              <p className="font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted">
                Sambil di sini, coba ini
              </p>
              <a href="/search?sort=popular" className="font-mono text-xs text-secondary transition-colors hover:text-accent">
                Lihat populer →
              </a>
            </div>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {suggestions.map((s) => (
                <a key={s.slug}
                  href={typedUrl(safeType(s.type), s.slug)}
                  className="group block"
                >
                  <div className="aspect-[3/4] overflow-hidden rounded-lg border border-border-subtle bg-bg-secondary transition-colors group-hover:border-border-default">
                    {s.cover_image ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={s.cover_image}
                        alt={s.title}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center font-mono text-[10px] text-muted">
                        no cover
                      </div>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-secondary transition-colors group-hover:text-primary">
                    {s.title}
                  </p>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
