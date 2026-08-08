import { searchMerged, getSourceStatus } from '@/lib/api';
import { MangaCard } from '@/components/MangaCard';
import { CoverImage } from '@/components/CoverImage';
import { SourceBadge, sourceLabel, SOURCE_ORDER } from '@/components/SourceBadge';
import Link from 'next/link';

export const runtime = 'edge';
export const revalidate = 300;

const GENRES = ['Action', 'Adventure', 'Comedy', 'Fantasy', 'Romance', 'School Life', 'Isekai', 'Drama', 'Horror', 'Sci-Fi'];

const itemOf = (m: any) => m.data ?? m;

export default async function Home() {
  let manga: any[] = [];
  let sourcesQueried: string[] = [];
  let statuses: any[] = [];
  let error: string | null = null;
  try {
    const [res, st] = await Promise.all([
      searchMerged(''),
      getSourceStatus().catch(() => ({ data: [] })),
    ]);
    manga = res.data;
    sourcesQueried = res.sources_queried;
    statuses = st.data;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e);
  }

  const typeCounts: Record<string, number> = {};
  const srcCounts: Record<string, number> = {};
  for (const m of manga) {
    const it = itemOf(m);
    typeCounts[it.type ?? 'manga'] = (typeCounts[it.type ?? 'manga'] ?? 0) + 1;
    srcCounts[it.source] = (srcCounts[it.source] ?? 0) + 1;
  }

  const popular = manga.slice(0, 10);
  const updates = manga.slice(0, 12);
  const healthyCount = statuses.filter((s) => s.healthy).length;
  const healthOf = (s: string) => statuses.find((st) => st.source === s);

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 pb-16">
      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">Gagal memuat: {error}</div>}

      {/* ============ Hero ============ */}
      <section className="relative overflow-hidden pt-14 pb-12 md:pt-20 md:pb-14 text-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-28 mx-auto h-72 w-72 rounded-full bg-[radial-gradient(closest-side,oklch(98%_0_0/0.07),transparent)] md:h-96 md:w-96"
        />
        <div className="relative">
          <p className="anim-rise font-mono text-[11px] uppercase tracking-[0.28em] text-muted mb-4">Baca manga bahasa Indonesia</p>
          <h1 className="anim-rise font-display text-4xl md:text-6xl tracking-tight text-primary leading-[1.05] text-balance" style={{ animationDelay: '60ms' }}>
            Komik yang <span className="text-glow">baru terbit</span>,
            <br /> tanpa ribet.
          </h1>
          <p className="anim-rise mt-5 text-secondary max-w-xl mx-auto text-balance" style={{ animationDelay: '120ms' }}>
            Empat sumber terjemahan Indonesia, digabung jadi satu. Rapi, cepat, dan ringan.
          </p>
          <form action="/search" method="get" className="anim-rise mt-8 max-w-xl mx-auto" style={{ animationDelay: '180ms' }}>
            <div className="flex items-center gap-2 rounded-full border border-border-default bg-card/60 px-4 py-2 backdrop-blur focus-within:border-border-default">
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

      {/* ============ Ticker update terbaru ============ */}
      {updates.length > 0 && (
        <section aria-label="Judul terbaru" className="marquee relative mb-12 overflow-hidden border-y border-border-subtle py-3">
          <div className="marquee-track">
            {[0, 1].map((copy) => (
              <div key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
                {updates.map((m) => {
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

      {/* ============ Status sumber ============ */}
      <section className="mb-14" aria-label="Status sumber bacaan">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-card/60 px-3.5 py-1.5 text-xs text-secondary backdrop-blur">
            {healthyCount}/{statuses.length || '?'} sumber online
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-card/60 px-3.5 py-1.5 text-xs text-secondary backdrop-blur">
            {manga.length} judul dimuat
          </span>
          {Object.entries(typeCounts)
            .filter(([, n]) => n > 0)
            .map(([t, n]) => (
              <span key={t} className="hidden sm:inline-flex items-center gap-2 rounded-full border border-border-subtle bg-card/60 px-3.5 py-1.5 text-xs text-secondary backdrop-blur">
                {n} {t}
              </span>
            ))}
          {SOURCE_ORDER.filter((s) => sourcesQueried.includes(s)).map((s) => {
            const h = healthOf(s);
            return (
              <Link
                key={s}
                href="/status"
                prefetch={false}
                className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-card/60 px-3 py-1.5 text-xs text-secondary backdrop-blur hover:text-primary hover:border-border-default transition-colors"
                title={`Status ${sourceLabel(s)}`}
              >
                <SourceBadge sources={[s]} size="sm" />
                {sourceLabel(s)}
                <span className="text-muted">{srcCounts[s] ?? 0} judul</span>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${h ? 'bg-success' : 'bg-error'}`} aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      </section>

      {/* ============ Populer Hari Ini ============ */}
      <section className="mb-14">
        <div className="flex items-baseline justify-between mb-6">
          <h2 className="font-display text-2xl tracking-tight">Populer Hari Ini</h2>
          <Link href="/search" prefetch={false} className="text-sm text-secondary hover:text-accent">
            Semua →
          </Link>
        </div>
        <div className="flex gap-4 overflow-x-auto pb-4 snap-x" style={{ scrollbarWidth: 'thin' }} aria-label="Judul populer">
          {popular.map((m, i) => {
            const item = itemOf(m);
            const source = item.sources?.includes('komiku') ? 'komiku' : item.source;
            return (
              <Link
                key={`${item.source}-${item.slug}`}
                href={`/${source}/s/${item.slug}?id=${item.slug}`}
                prefetch={false}
                className="group relative shrink-0 snap-start w-40 transition-transform duration-200 hover:-translate-y-1"
              >
                <span
                  className={`absolute -top-3 -left-1 z-10 font-display text-6xl font-light leading-none select-none ${
                    i < 3 ? 'text-primary/25' : 'text-primary/10'
                  }`}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <div className="aspect-[3/4] w-full overflow-hidden rounded-xl border border-border-subtle bg-card relative">
                  <CoverImage src={item.cover_image} alt={item.title} title={item.title} className="h-full w-full" zoom />
                  <div className="absolute top-1.5 right-1.5 z-10">
                    <SourceBadge sources={(item.sources as string[]) || [item.source]} size="sm" />
                  </div>
                  {item.status && (
                    <span className="absolute bottom-1.5 left-1.5 z-10 rounded-full bg-base/70 px-2 py-0.5 text-[10px] capitalize text-secondary backdrop-blur">
                      {item.status}
                    </span>
                  )}
                </div>
                <div className="mt-2">
                  <div className="text-sm text-primary line-clamp-2 group-hover:text-accent transition-colors">{item.title}</div>
                  <div className="text-[11px] text-muted mt-0.5 capitalize">{item.type}</div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ============ Genre ============ */}
      <section className="mb-14">
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

      {/* ============ Update Terbaru ============ */}
      {updates.length > 0 && (
        <section className="mb-14">
          <div className="flex items-baseline justify-between mb-6">
            <h2 className="font-display text-2xl tracking-tight">Update Terbaru</h2>
            <Link href="/search" prefetch={false} className="text-sm text-secondary hover:text-primary">
              semua →
            </Link>
          </div>
          <div className="grid md:grid-cols-2 md:gap-x-8">
            {updates.map((m) => {
              const item = itemOf(m);
              const source = item.sources?.includes('komiku') ? 'komiku' : item.source;
              return (
                <Link
                  key={`${item.source}-${item.slug}`}
                  href={`/${source}/s/${item.slug}?id=${item.slug}`}
                  prefetch={false}
                  className="flex items-center gap-4 py-3 border-b border-border-subtle group"
                >
                  <div className="w-12 h-16 shrink-0 overflow-hidden rounded border border-border-subtle bg-card">
                    <CoverImage src={item.cover_image} alt="" title={item.title} className="h-full w-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-primary truncate group-hover:text-accent transition-colors">{item.title}</div>
                    <div className="text-xs text-muted mt-0.5 capitalize">
                      {item.type}
                      {item.status ? ` · ${item.status}` : ''}
                    </div>
                  </div>
                  <SourceBadge sources={(item.sources as string[]) || [item.source]} size="sm" />
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* ============ Semua Komik ============ */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="font-display text-2xl tracking-tight">Semua Komik</h2>
          <Link href="/search" prefetch={false} className="text-sm text-secondary hover:text-accent">
            Lihat semua →
          </Link>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-x-4 gap-y-6">
          {manga.map((m) => {
            const item = itemOf(m);
            const source = item.sources?.includes('komiku') ? 'komiku' : item.source;
            return (
              <MangaCard
                key={`${item.source}-${item.slug}`}
                manga={{ id: item.slug, title: item.title, cover: item.cover_image, slug: item.slug }}
                source={source}
                sources={(item.sources as string[]) || [item.source]}
                status={item.type}
              />
            );
          })}
        </div>
      </section>

      {/* ============ Footer ============ */}
      <footer className="border-t border-border-subtle mt-16 pt-8 text-sm text-muted">
        <div className="grid gap-6 sm:grid-cols-3">
          <div>
            <p className="font-display text-base text-primary tracking-tight mb-1">Manga</p>
            <p className="text-xs leading-relaxed">Kompilasi baca manga, manhwa, dan manhua terjemahan Indonesia dari empat sumber independen.</p>
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-secondary mb-2">Sumber</p>
            {['komiku.org', 'bacakomik.my', 'thrive.moe', 'manhwaindo.my'].map((d) => (
              <p key={d} className="text-xs py-0.5">{d}</p>
            ))}
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