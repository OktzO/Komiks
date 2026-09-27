import { useEffect, useState } from 'react';
import { CoverImage } from '@/components/CoverImage';
import { getNovelCatalog, type NovelCatalogPage } from '@/lib/api';
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
  const [data, setData] = useState<NovelCatalogPage | null>(initial);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initial !== null) return;
    let alive = true;
    getNovelCatalog({ genre: genre || undefined, page, limit: CATALOG_PAGE_SIZE })
      .then((res) => { if (alive) setData(res); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [initial, genre, page]);

  if (failed) {
    return (
      <div className="rounded-panel border border-border-default bg-card p-6 text-center text-sm text-secondary">
        Katalog novel gagal dimuat. Coba lagi sebentar.
      </div>
    );
  }

  if (!data) {
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

  const lastPage = catalogLastPage(data.total, data.limit || CATALOG_PAGE_SIZE);
  const series = data.data ?? [];

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
                <CoverImage src={novelCover(s)} alt={s.title} title={s.title} className="h-full w-full" fit="cover" zoom />
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
          <PagerLink page={page - 1} genre={genre} disabled={page <= 1} label="← Sebelumnya" />
          <span className="px-2 font-mono text-[11px] text-muted">
            Halaman {page} / {lastPage}
          </span>
          <PagerLink page={page + 1} genre={genre} disabled={page >= lastPage} label="Berikutnya →" />
        </nav>
      )}
    </div>
  );
}

const fmtGenre = (genre: string) => (genre ? ` bergenre ${genre}` : '');

// cover_ref is a storage ref with no producer until the cover pipeline lands,
// so cover_fallback (the upstream URL) is the only renderable source in V1.
const novelCover = (s: { cover_fallback?: string | null }): string | null => s.cover_fallback ?? null;

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
