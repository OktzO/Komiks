import { searchMerged, getSourceStatus } from '@/lib/api';
import { MangaCard } from '@/components/MangaCard';
import { SourceBadge } from '@/components/SourceBadge';
import Link from 'next/link';

export const runtime = 'edge';
export const revalidate = 300;

const GENRES = ['Action', 'Adventure', 'Comedy', 'Fantasy', 'Romance', 'School Life', 'Isekai', 'Drama', 'Horror', 'Sci-Fi'];

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

  const popular = manga.slice(0, 10);
  const updates = manga.slice(0, 15);
  const healthyCount = statuses.filter((s) => s.healthy).length;

  return (
    <main className="max-w-6xl mx-auto px-4 py-10">
      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">Gagal memuat: {error}</div>}

      {/* ── Hero: statement + search bar prominent ── */}
      <section className="mb-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-muted mb-3">Baca manga bahasa Indonesia</p>
        <h1 className="font-display text-4xl md:text-6xl tracking-tight text-primary leading-[1.05] text-balance">
          Komik yang <span className="text-glow">baru terbit</span>,
          <br /> tanpa ribet.
        </h1>
        <p className="mt-4 text-secondary max-w-xl mx-auto text-balance">
          Satu tempat untuk komiku, bacakomik, thrive, dan manhwaindo — terjemahan Indonesia, rapi, dan cepat.
        </p>
        <form action="/search" method="get" className="mt-8 max-w-xl mx-auto">
          <div className="flex items-center gap-2 rounded-full border border-border-default bg-card/60 px-4 py-2 backdrop-blur focus-within:border-border-default">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted shrink-0" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              name="q"
              type="search"
              placeholder="Cari judul manga…"
              className="w-full bg-transparent text-primary placeholder:text-muted outline-none py-1.5"
              aria-label="Cari manga"
            />
            <button type="submit" className="shrink-0 rounded-full bg-accent text-base px-4 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity">
              Cari
            </button>
          </div>
        </form>
      </section>

      {/* ── Status strip: mini live numbers ── */}
      <section className="mb-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted">
        <Link href="/status" prefetch={false} className="hover:text-accent transition-colors">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-success mr-1.5 align-middle" />
          {healthyCount}/{statuses.length || '?'} sumber online
        </Link>
        {sourcesQueried.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 capitalize">
            <SourceBadge sources={[s]} size="sm" />
            {s}
          </span>
        ))}
      </section>

      {/* ── Populer Hari Ini: horizontal carousel with big rank numbers ── */}
      <section className="mb-12">
        <h2 className="font-display text-2xl tracking-tight mb-6">Populer Hari Ini</h2>
        <div className="flex gap-4 overflow-x-auto pb-4 snap-x" style={{ scrollbarWidth: 'thin' }}>
          {popular.map((m: any, i) => {
            const item = m.data || m;
            const source = item.sources?.includes('komiku') ? 'komiku' : item.source;
            return (
              <Link
                key={`${item.source}-${item.slug}`}
                href={`/${source}/s/${item.slug}?id=${item.slug}`}
                prefetch={false}
                className="group relative shrink-0 snap-start w-40 transition-transform duration-200 hover:-translate-y-1"
              >
                <span className="absolute -top-3 -left-1 z-10 font-display text-6xl font-light text-primary/10 leading-none select-none" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="aspect-[3/4] w-full overflow-hidden rounded-xl border border-border-subtle bg-card relative">
                  {item.cover_image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.cover_image} alt={item.title} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                  ) : (
                    <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">{item.title}</div>
                  )}
                  <div className="absolute top-1.5 right-1.5">
                    <SourceBadge sources={(item.sources as string[]) || [item.source]} size="sm" />
                  </div>
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

      {/* ── Genre quick filter pills ── */}
      <section className="mb-12">
        <div className="flex gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
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

      {/* ── Update Project: activity feed (thumbnail left, meta right) ── */}
      <section className="mb-12">
        <h2 className="font-display text-2xl tracking-tight mb-6">Update Terbaru</h2>
        <div className="border-t border-border-subtle divide-y divide-border-subtle">
          {updates.map((m: any) => {
            const item = m.data || m;
            const source = item.sources?.includes('komiku') ? 'komiku' : item.source;
            return (
              <Link
                key={`${item.source}-${item.slug}`}
                href={`/${source}/s/${item.slug}?id=${item.slug}`}
                prefetch={false}
                className="flex items-center gap-4 py-3 group"
              >
                <div className="w-12 h-16 shrink-0 overflow-hidden rounded border border-border-subtle bg-card">
                  {item.cover_image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.cover_image} alt="" loading="lazy" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-primary truncate group-hover:text-accent transition-colors">{item.title}</div>
                  <div className="text-xs text-muted mt-0.5 capitalize">{item.type}</div>
                </div>
                <SourceBadge sources={(item.sources as string[]) || [item.source]} size="sm" />
              </Link>
            );
          })}
        </div>
      </section>

      {/* ── All grid (fallback full listing) ── */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="font-display text-2xl tracking-tight">Semua Komik</h2>
          <Link href="/search" prefetch={false} className="text-sm text-secondary hover:text-accent">Lihat semua →</Link>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-4">
          {manga.map((m: any) => {
            const item = m.data || m;
            const source = item.sources?.includes('komiku') ? 'komiku' : item.source;
            return (
              <MangaCard
                key={`${item.source}-${item.slug}`}
                manga={{ id: item.slug, title: item.title, cover: item.cover_image, slug: item.slug }}
                source={source}
                sources={(item.sources as string[]) || [item.source]}
              />
            );
          })}
        </div>
      </section>
    </main>
  );
}
