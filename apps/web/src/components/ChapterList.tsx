import { useMemo, useState } from 'react';
import { WindowedList } from './WindowedList';
import { isValidType, typedChapterUrl, type ComicType } from '@/lib/api';

// Type wajib (semua caller pass). Nilai aneh → 'manga' (route kanonik redirect).
const safeType = (t?: string | null): ComicType =>
  isValidType(t ?? '') ? (t as ComicType) : 'manga';

interface Ch { id: string; chapter_number: number; title?: string | null; published_at?: number | null; pages_count?: number }

const fmtDate = (ms?: number | null) => {
  if (!ms) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
};

// Inline section ala desu.xxx: header + cari + sort, baris chip nomor + judul + meta.
export function ChapterList({ chapters, slug, type }: { chapters: Ch[]; source?: string; slug: string; type: string }) {
  const [q, setQ] = useState('');
  const [asc, setAsc] = useState(false);

  const newest = chapters.reduce((m, c) => Math.max(m, c.chapter_number ?? 0), 0);
  const byNum = [...chapters].sort((a, b) => (a.chapter_number ?? 0) - (b.chapter_number ?? 0));

  const ordered = useMemo(() => {
    const list = asc ? byNum : [...byNum].reverse();
    const term = q.trim().toLowerCase();
    if (!term) return list;
    return list.filter((c) =>
      String(c.chapter_number).includes(term) || (c.title ?? '').toLowerCase().includes(term)
    );
  }, [asc, q, chapters]); // eslint-disable-line react-hooks/exhaustive-deps

  const linkHref = (c: Ch) => typedChapterUrl(safeType(type), slug, c.id);

  return (
    <section
      id="chapters-list"
      className="scroll-mt-20 bg-card border border-border-default rounded-panel p-4"
      aria-label="Daftar chapter"
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
        <h2 className="flex items-center gap-2.5 text-base font-bold text-primary tracking-tight">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden="true">
            <path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
          </svg>
          List Chapter <span className="text-muted font-mono text-xs">({chapters.length})</span>
        </h2>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <div className="relative flex-1 md:w-56">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden="true">
              <path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />
            </svg>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cari chapter, ex: 99"
              aria-label="Cari chapter"
              className="w-full bg-sunken border border-border-subtle rounded-inner pl-9 pr-3 py-2 text-xs text-primary placeholder:text-muted focus:outline-none focus:border-accent-border transition-colors"
            />
          </div>
          <button
            onClick={() => setAsc((a) => !a)}
            title={asc ? 'Awal → Akhir' : 'Akhir → Awal'}
            aria-label={`Urutkan: ${asc ? 'Awal ke Akhir' : 'Akhir ke Awal'}`}
            className="w-9 h-9 shrink-0 flex items-center justify-center rounded-inner bg-sunken border border-border-subtle text-muted hover:text-accent hover:border-accent-border transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={asc ? 'rotate-180' : ''} aria-hidden="true">
              <path d="m21 16-4 4-4-4" /><path d="M17 20V4" /><path d="m3 8 4-4 4 4" /><path d="M7 4v16" />
            </svg>
          </button>
        </div>
      </div>

      {ordered.length === 0 ? (
        <p className="text-secondary text-sm py-6 text-center">Chapter tidak cocok dengan pencarian.</p>
      ) : (
        <WindowedList
          className="space-y-2 max-h-[480px] overflow-y-auto pr-1 overscroll-contain"
          total={ordered.length}
          renderItem={(i) => {
            const c = ordered[i];
            const date = fmtDate(c.published_at);
            return (
              <a
                key={c.id}
                href={linkHref(c)}
                className="group flex items-center gap-3.5 p-3 rounded-inner border border-border-subtle bg-bg-secondary/40 hover:bg-elevated hover:border-accent-border transition-colors"
              >
                <span className="shrink-0 bg-accent-soft border border-accent-border text-accent font-mono font-black text-xs px-2.5 py-1.5 rounded-inner min-w-[45px] text-center tabular-nums select-none">
                  {c.chapter_number}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-primary truncate group-hover:text-accent transition-colors">
                      Chapter {c.chapter_number}{c.title ? ` — ${c.title}` : ''}
                    </span>
                    {c.chapter_number === newest && (
                      <span className="shrink-0 text-[9px] font-black uppercase tracking-tight bg-error/10 text-error px-1.5 py-0.5 rounded animate-pulse">New</span>
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-4 text-[9px] font-bold uppercase tracking-widest text-muted">
                    {date && (
                      <span className="flex items-center gap-1.5">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" aria-hidden="true">
                          <path d="M12 6v6l4 2" /><circle cx="12" cy="12" r="10" />
                        </svg>
                        {date}
                      </span>
                    )}
                    {c.pages_count ? (
                      <span className="flex items-center gap-1.5">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" aria-hidden="true">
                          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                        </svg>
                        {c.pages_count} hal
                      </span>
                    ) : null}
                  </span>
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted group-hover:text-accent transition-colors" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </a>
            );
          }}
        />
      )}
    </section>
  );
}

export default ChapterList;
