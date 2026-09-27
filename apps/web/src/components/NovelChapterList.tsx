import { useEffect, useState } from 'react';
import { getNovelChapters, type NovelChapter } from '@/lib/api';
import { novelChapterUrl } from '@/lib/novelRoutes';

// Async-first like ChapterSection: `initial` arrives when the server fetch beat
// its budget (the detail payload embeds the first chapter page), otherwise the
// island fetches the chapter list itself and the page keeps its skeleton.
export function NovelChapterList({
  slug,
  initialChapters,
}: {
  slug: string;
  initialChapters: NovelChapter[] | null;
}) {
  const [chapters, setChapters] = useState<NovelChapter[] | null>(initialChapters);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialChapters !== null) return;
    let alive = true;
    getNovelChapters(slug, { limit: 50 })
      .then((res) => { if (alive) setChapters(res.data ?? []); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [initialChapters, slug]);

  if (failed) {
    return (
      <div className="rounded-panel border border-border-default bg-card p-6 text-center text-sm text-secondary">
        Daftar bab gagal dimuat. Coba lagi sebentar.
      </div>
    );
  }

  if (!chapters) {
    return (
      <section className="rounded-panel border border-border-default bg-card p-4" aria-busy="true" aria-label="Memuat daftar bab">
        <div className="skeleton mb-3 h-4 w-32" />
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton mb-2 h-10 w-full" />)}
      </section>
    );
  }

  if (chapters.length === 0) {
    return <p className="rounded-panel border border-border-default bg-card p-6 text-center text-sm text-secondary">Bab novel ini belum tersedia di sumber.</p>;
  }

  return (
    <section className="rounded-panel border border-border-default bg-card p-4" aria-label="Daftar bab">
      <h2 className="mb-3 font-mono text-[10px] font-black uppercase tracking-[0.2em] text-muted">
        Daftar Bab ({chapters.length})
      </h2>
      <ol className="divide-y divide-border-subtle">
        {chapters.map((c) => (
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
    </section>
  );
}

export default NovelChapterList;
