import { useEffect, useState } from 'react';
import { getNovelChapters, type NovelChapter } from '@/lib/api';
import { novelChapterUrl } from '@/lib/novelRoutes';

// One page, both server and client side: the API clamps to 50, and the detail
// payload embeds exactly this first window, so page 1 of the island and the
// SSR'd rows line up without a refetch.
const PAGE_SIZE = 50;

// Async-first like ChapterSection: `initial` arrives when the server fetch beat
// its budget, otherwise the island fetches page 1 itself and the page keeps its
// skeleton.
//
// `total` starts null because the series detail payload does not carry one.
// Until the first client fetch lands the heading shows a range, never a bare
// count that would read as a total — a novel with 147 chapters must not look
// like it has 50. One click on "next" resolves it, because that response
// carries `total`.
export function NovelChapterList({
  slug,
  initialChapters,
}: {
  slug: string;
  initialChapters: NovelChapter[] | null;
}) {
  const [rows, setRows] = useState<NovelChapter[] | null>(initialChapters);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialChapters !== null) return;
    let alive = true;
    getNovelChapters(slug, { page: 1, limit: PAGE_SIZE })
      .then((res) => {
        if (!alive) return;
        setRows(res.data ?? []);
        setTotal(res.total);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [initialChapters, slug]);

  const goTo = (next: number) => {
    if (next < 1 || busy) return;
    setBusy(true);
    getNovelChapters(slug, { page: next, limit: PAGE_SIZE })
      .then((res) => {
        const list = res.data ?? [];
        setTotal(res.total);
        // An empty page means the requested window is past the end; keep the
        // current rows rather than blanking the list.
        if (list.length > 0) {
          setRows(list);
          setPage(next);
        } else {
          setPage(Math.max(1, Math.ceil((res.total || 1) / PAGE_SIZE)));
        }
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  if (failed) {
    return (
      <div className="rounded-panel border border-border-default bg-card p-6 text-center text-sm text-secondary">
        Daftar bab gagal dimuat. <button type="button" onClick={() => location.reload()} className="text-accent hover:underline">Muat ulang</button>
      </div>
    );
  }

  if (!rows) {
    return (
      <section className="rounded-panel border border-border-default bg-card p-4" aria-busy="true" aria-label="Memuat daftar bab">
        <div className="skeleton mb-3 h-4 w-32" />
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton mb-2 h-10 w-full" />)}
      </section>
    );
  }

  if (rows.length === 0) {
    return <p className="rounded-panel border border-border-default bg-card p-6 text-center text-sm text-secondary">Bab novel ini belum tersedia di sumber.</p>;
  }

  const lastPage = total === null ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = first + rows.length - 1;

  return (
    <section className="rounded-panel border border-border-default bg-card p-4" aria-label="Daftar bab">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted">
          {total === null ? 'Daftar Bab' : `Daftar Bab (${total})`}
        </h2>
        <p className="font-mono text-[11px] text-muted">
          {total === null ? `Bab ${first}–${last} termuat` : `Bab ${first}–${last} dari ${total}`}
        </p>
      </div>

      <ol className="divide-y divide-border-subtle">
        {rows.map((c) => (
          <li key={c.source_chapter_id}>
            <a
              href={novelChapterUrl(slug, c.source_chapter_id)}
              className="flex items-baseline justify-between gap-3 py-2.5 text-sm text-secondary transition-colors hover:text-primary"
            >
              <span className="shrink-0">Bab {c.number}</span>
              {c.title && <span className="truncate text-xs text-muted">{c.title}</span>}
            </a>
          </li>
        ))}
      </ol>

      {total === null ? (
        // Total still unknown (SSR'd first window). One click resolves it: the
        // page-2 response carries `total`, which turns this into real paging.
        <nav className="mt-4 flex justify-center border-t border-border-subtle pt-4" aria-label="Daftar bab lanjutan">
          <PageButton onClick={() => goTo(page + 1)} disabled={busy} label="Selengkapnya →" />
        </nav>
      ) : lastPage > 1 ? (
        <nav className="mt-4 flex items-center justify-center gap-2 border-t border-border-subtle pt-4" aria-label="Halaman daftar bab">
          <PageButton onClick={() => goTo(page - 1)} disabled={busy || page <= 1} label="← Sebelumnya" />
          <span className="px-2 font-mono text-[11px] text-muted">Hal. {page} / {lastPage}</span>
          <PageButton onClick={() => goTo(page + 1)} disabled={busy || page >= lastPage} label="Berikutnya →" />
        </nav>
      ) : null}
    </section>
  );
}

function PageButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-inner border border-border-default bg-card px-3 py-1.5 text-xs text-secondary transition-colors hover:border-accent-border hover:text-accent disabled:cursor-default disabled:opacity-40 disabled:hover:border-border-default disabled:hover:text-secondary"
    >
      {label}
    </button>
  );
}

export default NovelChapterList;
