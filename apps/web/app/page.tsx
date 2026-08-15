import { searchMerged } from '@/lib/api';
import { MangaCard } from '@/components/MangaCard';
import { CoverImage } from '@/components/CoverImage';
import { TypeBadge } from '@/components/TypeBadge';
import { SourceBadge, sourceLabel, SOURCE_ORDER } from '@/components/SourceBadge';
import { HomeSkeleton } from '@/components/Skeleton';
import { Suspense } from 'react';
import Link from 'next/link';

export const runtime = 'edge';
export const revalidate = 300;

const GENRES = ['Action', 'Adventure', 'Comedy', 'Fantasy', 'Romance', 'School Life', 'Isekai', 'Drama', 'Horror', 'Sci-Fi'];

const itemOf = (m: any) => m.data ?? m;

// Data fetch berjalan di background (streaming) — user langsung lihat
// skeleton, bukan blank/loading lama yang terkesan macet.
async function HomeFeed() {
  let manga: any[] = [];
  let error: string | null = null;
  try {
    const res = await searchMerged('');
    manga = res.data;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e);
  }

  const popular = manga.slice(0, 10);
  const updates = manga.slice(10, 22);

  if (error) {
    return <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">Gagal memuat: {error}</div>;
  }

  return (
    <>
      {/* ============ Ticker update terbaru ============ */}
      {updates.length > 0 && (
        <section aria-label="Judul terbaru" className="marquee relative mb-10 overflow-hidden border-y border-border-subtle py-3">
          <div className="marquee-track">
            {[0, 1].map((copy) => (
              <div key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
                {updates.slice(0, 8).map((m) => {
                  const it = itemOf(m);
                  return (
                    <span key={`${copy}-${it.slug}`} className="flex items-center shrink-0">
                      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted whitespace-nowrap">{it.title}</span>
                      <span className="mx-6 h-3 w-px bg-border-default" />
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ============ Populer Hari Ini ============ */}
      <section className="mb-12">
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="font-display text-2xl tracking-tight">Populer Hari Ini</h2>
          <Link href="/search" prefetch={false} className="text-sm text-secondary hover:text-accent">
            Semua →
          </Link>
        </div>
        <div className="flex gap-4 overflow-x-auto pb-4 snap-x" style={{ scrollbarWidth: 'thin' }} aria-label="Judul populer">
          {popular.map((m) => {
            const item = itemOf(m);
            const source = (m.sources?.includes('komiku') ?? item.sources?.includes('komiku')) ? 'komiku' : item.source;
            return (
              <Link
                key={`${item.source}-${item.slug}`}
                href={`/${source}/s/${item.slug}?id=${item.slug}`}
                prefetch={false}
                className="group relative shrink-0 snap-start w-36 sm:w-40 transition-transform duration-200 hover:-translate-y-1"
              >
                <MangaCard
                  manga={{ id: item.slug, title: item.title, cover: item.cover_image || null, slug: item.slug }}
                  source={source}
                  sources={(m.sources as string[]) || (item.sources as string[]) || [item.source]}
                  type={item.type}
                />
              </Link>
            );
          })}
        </div>
      </section>

      {/* ============ Update Terbaru ============ */}
      {updates.length > 0 && (
        <section className="cv-feed mb-12">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="font-display text-2xl tracking-tight">Update Terbaru</h2>
            <Link href="/search" prefetch={false} className="text-sm text-secondary hover:text-primary">
              semua →
            </Link>
          </div>
          <div className="grid md:grid-cols-2 md:gap-x-8">
            {updates.map((m) => {
              const item = itemOf(m);
              const source = (m.sources?.includes('komiku') ?? item.sources?.includes('komiku')) ? 'komiku' : item.source;
              return (
                <Link
                  key={`${item.source}-${item.slug}`}
                  href={`/${source}/s/${item.slug}?id=${item.slug}`}
                  prefetch={false}
                  className="flex items-center gap-3 py-3 border-b border-border-subtle group"
                >
                  <div className="w-11 h-14 shrink-0 overflow-hidden rounded border border-border-subtle bg-card">
                    <CoverImage src={item.cover_image} alt="" title={item.title} className="h-full w-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-primary truncate group-hover:text-accent transition-colors">{item.title}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <TypeBadge type={item.type} />
                      {item.status && <span className="text-[11px] text-muted capitalize">{item.status}</span>}
                    </div>
                  </div>
                    <SourceBadge sources={(m.sources as string[]) || (item.sources as string[]) || [item.source]} size="sm" />
                  </Link>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

export default function Home() {
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 pb-16 overflow-x-hidden">
      {/* ============ Hero ============ */}
      <section className="relative overflow-hidden pt-14 pb-10 md:pt-20 md:pb-14 text-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-28 mx-auto h-72 w-72 rounded-full bg-[radial-gradient(closest-side,oklch(98%_0_0/0.07),transparent)] md:h-96 md:w-96"
        />
        <div className="relative">
          <p className="anim-rise font-mono text-[11px] uppercase tracking-[0.28em] text-muted mb-4">Koleksi komik Indonesia</p>
          <h1 className="anim-rise font-display text-4xl md:text-6xl tracking-tight text-primary leading-[1.05] text-balance" style={{ animationDelay: '60ms' }}>
            Baca manga, manhwa,
            <br /> dan manhua. Satu tempat.
          </h1>
          <p className="anim-rise mt-5 text-secondary max-w-xl mx-auto text-balance" style={{ animationDelay: '120ms' }}>
            Ribuan judul terjemahan Indonesia, dikemas rapi dan ringan. Cepat, nyaman, tanpa ribet.
          </p>
          <form action="/search" method="get" className="anim-rise mt-8 max-w-xl mx-auto" style={{ animationDelay: '180ms' }}>
            <div className="flex items-center gap-2 rounded-full border border-border-default bg-card/60 px-4 py-2 sm:backdrop-blur focus-within:border-border-default">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted shrink-0" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                name="q"
                type="search"
                placeholder="Cari judul manga…"
                className="w-full bg-transparent text-primary placeholder:text-muted outline-none py-1.5"
                aria-label="Cari manga"
              />
              <button type="submit" className="shrink-0 rounded-full bg-accent text-zinc-950 px-4 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity">
                Cari
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* ============ Genre (statis, instan) ============ */}
      <section className="mb-12">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted mb-3">Jelajah genre</p>
        <div className="flex gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }} aria-label="Filter genre">
          {GENRES.map((g) => (
            <Link
              key={g}
              href={`/search?genre=${encodeURIComponent(g)}`}
              prefetch={false}
              className="shrink-0 rounded-full border border-border-subtle px-3.5 py-1.5 text-xs text-secondary hover:text-primary hover:border-border-default hover:bg-bg-secondary/60 transition-colors"
            >
              {g}
            </Link>
          ))}
        </div>
      </section>

      {/* ============ Feed (ticker + popular + updates) — skeleton instan, fetch background ============ */}
      <Suspense fallback={<HomeSkeleton />}>
        <HomeFeed />
      </Suspense>

      {/* ============ Footer ============ */}
      <footer className="cv-footer border-t border-border-subtle mt-16 pt-8 text-sm text-muted">
        <div className="grid gap-6 sm:grid-cols-3">
          <div>
            <p className="font-display text-base text-primary tracking-tight mb-1">Manga</p>
            <p className="text-xs leading-relaxed">Kompilasi baca manga, manhwa, dan manhua terjemahan Indonesia dari empat sumber independen.</p>
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-secondary mb-2">Sumber</p>
            <div className="flex flex-col">
              {SOURCE_ORDER.map((s) => (
                <Link
                  key={s}
                  href="/status"
                  prefetch={false}
                  className="flex items-center gap-2 py-1 text-xs text-secondary hover:text-primary transition-colors"
                  title={`Status ${sourceLabel(s)}`}
                >
                  <SourceBadge sources={[s]} size="sm" />
                  <span>{sourceLabel(s)}</span>
                </Link>
              ))}
            </div>
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-secondary mb-2">Navigasi</p>
            {[
              { href: '/search', label: 'Cari' },
              { href: '/bookmark', label: 'Bookmark' },
              { href: '/history', label: 'Riwayat' },
              { href: '/status', label: 'Status sumber' },
            ].map((l) => (
              <Link key={l.href} href={l.href} prefetch={false} className="block py-0.5 text-xs hover:text-primary transition-colors">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <p className="mt-8 text-xs text-muted/70">© 2026 Manga. Konten milik masing-masing penerbit.</p>
      </footer>
    </main>
  );
}
