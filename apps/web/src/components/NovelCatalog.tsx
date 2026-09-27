import { useEffect, useState } from 'react';
import { CoverImage } from '@/components/CoverImage';
import { getNovelCatalog, imgOriginFor, type NovelCatalogPage } from '@/lib/api';
import { catalogLastPage, novelCatalogUrl, novelSeriesUrl } from '@/lib/novelRoutes';

// The API clamps limit to 50; 24 keeps one page to a screenful of cards and
// still lands inside the shard merge ceiling.
export const CATALOG_PAGE_SIZE = 24;

// Async-first, same shape as ChapterSection: a series list that came back
// inside the server budget is already in the HTML, a late one shows a skeleton
// and fetches itself.
export function NovelCatalog({
  page,
  genre,
  initial,
}: {
  page: number;
  genre: string;
  initial: NovelCatalogPage | null;
}) {
  const [data, setData] = useState<{ page: number; res: NovelCatalogPage } | null>(
    initial ? { page: initial.page, res: initial } : null,
  );
  const [failed, setFailed] = useState(false);

  // The merge ceiling is only knowable from a response, so a hand-typed
  // /novel?page=99 first answers for a page that does not exist. Clamp the
  // REQUEST, not the label: the ceiling comes from that response's total, and
  // the corrected page answers with the same total, so this settles in one
  // extra request and cannot loop. Until it lands the payload in hand belongs
  // to no real page, so it is not rendered — the empty state would be a lie
  // next to a "Halaman 13 / 13" counter.
  const ceiling = data ? catalogLastPage(data.res.total, data.res.limit || CATALOG_PAGE_SIZE) : Number.MAX_SAFE_INTEGER;
  const target = Math.min(Math.max(1, page), ceiling);
  const loaded = data !== null && data.page === target;

  useEffect(() => {
    if (loaded) return;
    let alive = true;
    getNovelCatalog({ genre: genre || undefined, page: target, limit: CATALOG_PAGE_SIZE })
      .then((res) => { if (alive) setData({ page: target, res }); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [loaded, genre, target]);

  if (failed) {
    return (
      <div className="rounded-panel border border-border-default bg-card p-6 text-center text-sm text-secondary">
        Katalog novel gagal dimuat. Coba lagi sebentar.
      </div>
    );
  }

  if (!data || !loaded) {
    return (
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6" aria-busy="true" aria-label="Memuat katalog novel">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i}>
            <div className="skeleton aspect-[3/4] w-full" />
            <div className="skeleton mt-2 h-3 w-4/5" />
          </div>
        ))}
      </div>
    );
  }

  const lastPage = catalogLastPage(data.res.total, data.res.limit || CATALOG_PAGE_SIZE);
  const series = data.res.data ?? [];

  return (
    <div>
      {series.length === 0 ? (
        <p className="rounded-panel border border-border-default bg-card p-6 text-center text-sm text-secondary">
          Belum ada novel{fmtGenre(genre)} di katalog. Coba genre lain atau kembali lagi nanti.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {series.map((s) => (
            <a key={s.id} href={novelSeriesUrl(s.id)} className="group block">
              <div className="aspect-[3/4] w-full overflow-hidden rounded border border-subtle bg-card">
                <CoverImage src={novelCover(s)} trusted={s.cover_url != null} alt={s.title} title={s.title} className="h-full w-full" fit="cover" zoom />
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-snug text-secondary transition-colors group-hover:text-accent">
                {s.title}
              </p>
              {s.author && <p className="mt-0.5 line-clamp-1 text-[10px] text-muted">{s.author}</p>}
            </a>
          ))}
        </div>
      )}

      {lastPage > 1 && (
        <nav className="mt-8 flex items-center justify-center gap-2" aria-label="Halaman katalog novel">
          <PagerLink page={target - 1} genre={genre} disabled={target <= 1} label="← Sebelumnya" />
          <span className="px-2 font-mono text-[11px] text-muted">
            Halaman {target} / {lastPage}
          </span>
          <PagerLink page={target + 1} genre={genre} disabled={target >= lastPage} label="Berikutnya →" />
        </nav>
      )}
    </div>
  );
}

const fmtGenre = (genre: string) => (genre ? ` bergenre ${genre}` : '');

// cover_url is the API's signed /img path, minted from the stored cover_ref, so
// the bytes come from B2 and the reader's IP never reaches the source.
// cover_fallback is the source URL and is only used when nothing is stored.
const novelCover = (s: { cover_url?: string | null; cover_fallback?: string | null }): string | null => {
  const stored = s.cover_url;
  return stored ? `${imgOriginFor(stored)}${stored}` : (s.cover_fallback ?? null);
};

function PagerLink({ page, genre, disabled, label }: { page: number; genre: string; disabled: boolean; label: string }) {
  if (disabled) {
    return <span className="cursor-default rounded-inner border border-border-subtle bg-card/60 px-3 py-1.5 text-xs text-muted opacity-50">{label}</span>;
  }
  return (
    <a href={novelCatalogUrl({ page, genre: genre || null })} className="rounded-inner border border-border-default bg-card px-3 py-1.5 text-xs text-secondary transition-colors hover:border-accent-border hover:text-accent">
      {label}
    </a>
  );
}

export default NovelCatalog;
