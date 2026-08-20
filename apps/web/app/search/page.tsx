import { SourceBadge } from '@/components/SourceBadge';
import { searchMerged } from '@/lib/api';
import Link from 'next/link';
import { Suspense } from 'react';

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-3 p-2.5 border border-subtle rounded-xl bg-card">
          <div className="h-20 w-14 shrink-0 skeleton rounded-md" />
          <div className="flex-1 space-y-2 py-1">
            <div className="h-3.5 w-3/4 skeleton rounded" />
            <div className="h-3 w-1/2 skeleton rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Hasil pencarian di-streaming terpisah (Suspense) — form langsung tampil,
// live search worker (bisa 1-5s) tidak memblokir First Paint.
async function Results({ q }: { q: string }) {
  let results: any[] = [];
  let error: string | null = null;
  try {
    const res = await searchMerged(q);
    results = res.data || [];
  } catch (e) {
    error = String(e);
  }

  if (error) {
    return <div className="text-error text-sm border border-border-default rounded-lg p-3 bg-card mb-4">{error}</div>;
  }

  return (
    <>
      <p className="text-secondary text-sm mb-4">
        {results.length > 0 ? `${results.length} hasil untuk ` : 'Tidak ada hasil untuk '}
        <span className="text-primary font-medium">&ldquo;{q}&rdquo;</span>
      </p>

      {results.length > 0 && (
        <div className="flex flex-col gap-2">
          {results.map((m: any) => {
            const item = m.data || m;
            const source = (m.sources?.includes('komiku') ?? item.sources?.includes('komiku')) ? 'komiku' : item.source;
            const sources = (m.sources as string[]) || (item.sources as string[]) || [item.source];
            return (
              <Link
                key={`${item.source}-${item.slug}`}
                href={`/${source}/s/${item.slug}?id=${item.slug}`}
                prefetch={false}
                className="flex gap-3 p-2.5 border border-subtle rounded-xl bg-card hover:bg-elevated hover:border-border-default transition-colors group"
              >
                <div className="h-20 w-14 flex-shrink-0 overflow-hidden rounded-md border border-subtle bg-base">
                  {item.cover_image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.cover_image} alt={item.title} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[8px] text-muted text-center px-1 leading-tight">{item.title}</div>
                  )}
                </div>
                <div className="flex flex-col flex-1 min-w-0 justify-center">
                  <div className="text-sm text-primary font-medium line-clamp-2 group-hover:text-accent leading-snug">{item.title}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {item.type && <span className="text-[10px] px-1.5 py-0.5 border border-border-subtle rounded text-muted capitalize">{item.type}</span>}
                    {item.status && <span className="text-[10px] text-muted">{item.status}</span>}
                  </div>
                  <SourceBadge sources={sources} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const q = sp.q?.trim();

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Cari Manga</h1>
      <form action="/search" className="mb-6">
        <div className="flex gap-2">
          <input
            name="q"
            defaultValue={q || ''}
            autoFocus
            placeholder="Judul manga..."
            className="flex-1 bg-card border border-border-default rounded-lg px-4 py-2.5 text-primary placeholder:text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
          />
          <button type="submit" className="px-5 py-2.5 bg-accent text-base border border-border-default rounded-lg text-sm font-medium hover:bg-accent-hover hover:text-base transition-colors">Cari</button>
        </div>
      </form>

      {q && (
        <Suspense fallback={<ResultsSkeleton />}>
          <Results q={q} />
        </Suspense>
      )}
    </main>
  );
}