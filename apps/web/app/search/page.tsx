import { SourceBadge } from '@/components/SourceBadge';
import { searchMerged, type MergedManga } from '@/lib/api';
import Link from 'next/link';
import { Suspense } from 'react';

export const metadata = { title: 'Cari' };

const POPULAR = ['one piece', 'solo leveling', 'jujutsu kaisen', 'blue lock', 'dandadan'];

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ResultsSkeleton({ q }: { q: string }) {
  return (
    <div aria-busy="true">
      <div className="flex items-center gap-2.5 mb-5">
        <div className="h-2 w-2 rounded-full bg-accent/60 animate-pulse" />
        <p className="text-sm text-secondary">
          Mencari <span className="text-primary font-medium">&ldquo;{q}&rdquo;</span> di 5 sumber&hellip;
        </p>
      </div>
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex gap-4 p-3 panel" aria-hidden="true">
            <div className="h-[104px] w-[72px] shrink-0 skeleton rounded-inner" />
            <div className="flex-1 space-y-2.5 py-1.5">
              <div className="h-4 w-2/3 skeleton rounded" />
              <div className="h-3 w-1/3 skeleton rounded" />
              <div className="h-3 w-1/4 skeleton rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ q }: { q: string }) {
  return (
    <div className="panel flex flex-col items-center text-center px-6 py-14">
      <div className="w-12 h-12 rounded-full border border-border-default flex items-center justify-center mb-4 bg-sunken">
        <SearchIcon className="w-5 h-5 text-muted" />
      </div>
      <p className="text-primary font-medium mb-1">Tidak ada hasil untuk &ldquo;{q}&rdquo;</p>
      <p className="text-sm text-secondary max-w-sm">
        Coba kata kunci lain, atau periksa ejaan judulnya. Pencarian mencakup komiku, BacaKomik, Thrive, Shinigami, dan ManhwaIndo.
      </p>
    </div>
  );
}

function ResultRow({ m }: { m: MergedManga }) {
  const source = m.sources?.includes('komiku') ? 'komiku' : m.source;
  return (
    <Link
      href={`/${source}/s/${m.slug}?id=${m.slug}`}
      prefetch={false}
      className="group flex gap-4 p-3 panel panel-hover items-center"
    >
      <div className="relative h-[104px] w-[72px] shrink-0 overflow-hidden rounded-inner border border-border-subtle bg-sunken">
        {m.cover_image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={m.cover_image}
            alt={m.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 ease-out-expo group-hover:scale-[1.06]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-1 text-center text-[9px] leading-tight text-muted">{m.title}</div>
        )}
      </div>

      <div className="flex flex-col flex-1 min-w-0 justify-center gap-1.5">
        <h3 className="text-[15px] text-primary font-medium line-clamp-2 leading-snug transition-colors group-hover:text-accent">
          {m.title}
        </h3>
        <div className="flex items-center gap-2 text-xs">
          {m.type && (
            <span className="px-2 py-0.5 border border-border-subtle rounded-full text-muted capitalize">{m.type}</span>
          )}
          {m.status && <span className="text-muted capitalize">{m.status.replace(/-/g, ' ')}</span>}
        </div>
        <SourceBadge sources={m.sources?.length ? m.sources : [m.source]} />
      </div>

      <svg
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        className="w-4 h-4 shrink-0 text-muted transition-all duration-200 group-hover:text-accent group-hover:translate-x-0.5" aria-hidden="true"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Link>
  );
}

// Hasil pencarian di-streaming terpisah (Suspense) — form langsung tampil,
// live search worker (bisa 1-5s) tidak memblokir First Paint.
async function Results({ q }: { q: string }) {
  let results: MergedManga[] = [];
  let error: string | null = null;
  try {
    const res = await searchMerged(q);
    results = res.data || [];
  } catch (e) {
    error = String(e);
  }

  if (error) {
    return (
      <div className="text-error text-sm panel px-4 py-3 mb-4" role="alert">
        Gagal memuat hasil. Coba lagi sebentar — {error}
      </div>
    );
  }

  if (results.length === 0) return <EmptyState q={q} />;

  return (
    <>
      <div className="flex items-baseline justify-between mb-5">
        <p className="text-sm text-secondary">
          <span className="text-primary font-semibold tabular">{results.length}</span> hasil untuk{' '}
          <span className="text-primary font-medium">&ldquo;{q}&rdquo;</span>
        </p>
      </div>
      <div className="flex flex-col gap-2.5 anim-slide-up">
        {results.map((m) => (
          <ResultRow key={`${m.source}-${m.slug}`} m={m} />
        ))}
      </div>
    </>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const q = sp.q?.trim();

  return (
    <main className="relative max-w-3xl mx-auto px-4 py-10 md:py-14 min-h-[80vh]">
      <div className="page-decoration" aria-hidden="true" />

      <div className="relative z-10">
        {/* Header */}
        <header className={q ? 'mb-8' : 'mb-10 text-center'}>
          {!q && (
            <p className="eyebrow mb-4">Cari di 5 sumber sekaligus</p>
          )}
          <h1 className={`font-display font-semibold tracking-tight text-primary ${q ? 'text-xl md:text-2xl' : 'text-4xl md:text-5xl'}`}>
            {q ? 'Hasil pencarian' : 'Mau baca apa hari ini?'}
          </h1>
          {!q && (
            <p className="mt-3 text-secondary text-sm md:text-base max-w-md mx-auto">
              Satu kotak pencarian, semua sumber komik Indonesia.
            </p>
          )}
        </header>

        {/* Search form — sticky feel, tegas */}
        <form action="/search" className="relative z-10 mb-8" role="search">
          <div className="flex items-center gap-2 panel !rounded-full p-1.5 pl-4 shadow-[0_8px_32px_-16px_oklch(0%_0_0/0.6)]">
            <SearchIcon className="w-[18px] h-[18px] shrink-0 text-muted" />
            <input
              type="search"
              name="q"
              defaultValue={q || ''}
              autoFocus
              placeholder="Judul manga, manhwa, manhua…"
              aria-label="Cari judul manga"
              className="flex-1 bg-transparent border-0 text-primary text-[15px] placeholder:text-muted focus:outline-none min-w-0 h-11"
            />
            <button type="submit" className="btn btn-primary !min-h-[44px] shrink-0">
              Cari
            </button>
          </div>
        </form>

        {/* Popular searches — hanya saat belum ada query */}
        {!q && (
          <div className="mb-10">
            <p className="eyebrow mb-3">Populer</p>
            <div className="flex flex-wrap gap-2">
              {POPULAR.map((term) => (
                <Link
                  key={term}
                  href={`/search?q=${encodeURIComponent(term)}`}
                  prefetch={false}
                  className="glass-pill rounded-full px-3.5 py-1.5 text-sm text-secondary hover:text-primary"
                >
                  {term}
                </Link>
              ))}
            </div>
          </div>
        )}

        {q && (
          <Suspense fallback={<ResultsSkeleton q={q} />}>
            <Results q={q} />
          </Suspense>
        )}
      </div>
    </main>
  );
}
