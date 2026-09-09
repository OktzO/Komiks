'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { WindowedList } from './WindowedList';

interface Ch { id: string; chapter_number: number; title?: string | null }

export function ChapterList({ chapters, source, slug, type }: { chapters: Ch[]; source: string; slug: string; type?: string }) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  // Default "Akhir → Awal": chapter 1 paling akhir. Sort numeric — data API
  // dari beberapa source tidak urut.
  const [asc, setAsc] = useState(false);

  const byNum = [...chapters].sort((a, b) => (a.chapter_number ?? 0) - (b.chapter_number ?? 0));
  const ordered = asc ? byNum : [...byNum].reverse();
  const first = chapters.reduce((m, c) => Math.max(m, c.chapter_number ?? 0), 0);

  const openSheet = () => {
    setRendered(true);
    setOpen(true);
  };
  const closeSheet = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const linkHref = (c: Ch) => {
    const rawId = c.id.includes(':') ? c.id.slice(c.id.lastIndexOf(':') + 1) : c.id;
    if (type) return `/${type}/${slug}/${rawId}?mangaId=${slug.split('--').pop()}`;
    return `/${source}/s/${slug}/${rawId}?mangaId=${slug.split('--').pop()}`;
  };

  return (
    <div>
      <button
        onClick={openSheet}
        className="w-full flex items-center justify-between px-4 py-3 border border-border-default rounded-xl bg-card text-sm font-medium hover:bg-elevated transition-colors"
      >
        <span className="text-primary flex items-center gap-2">
          <span>Daftar</span>
          <span className="text-muted text-xs">Ch. {first}</span>
        </span>
        <span className="flex items-center gap-3">
          <span className="text-muted text-xs">Bab {chapters.length}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {rendered && (
        <div
          aria-hidden={!open}
          className={`fixed inset-0 z-[60] transition-all duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${open ? 'visible opacity-100' : 'invisible opacity-0'}`}
        >
          <div
            onClick={closeSheet}
            className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${open ? 'opacity-100' : 'opacity-0'}`}
          />
          <div className="absolute inset-0 flex items-end justify-center px-0 sm:px-4" onClick={closeSheet}>
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Daftar chapter"
              onClick={(e) => e.stopPropagation()}
              className={`relative w-full max-w-2xl rounded-t-2xl border border-b-0 border-border-default bg-card overflow-hidden shadow-[0_-12px_48px_rgba(0,0,0,0.55)] transition-transform duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${open ? 'translate-y-0' : 'translate-y-full'}`}
            >
              <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-bg-secondary" />
              <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2.5 bg-card border-b border-border-subtle">
                <span className="text-xs text-muted">{chapters.length} chapter</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setAsc((a) => !a)}
                    className="text-xs px-2 py-1 border border-border-subtle rounded text-secondary hover:bg-elevated hover:text-primary transition-colors flex items-center gap-1.5"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={asc ? '' : 'rotate-180'}>
                      <path d="M12 5v14M5 12l7-7 7 7" />
                    </svg>
                    {asc ? 'Awal → Akhir' : 'Akhir → Awal'}
                  </button>
                  <button
                    onClick={closeSheet}
                    aria-label="Tutup"
                    className="p-1.5 border border-border-subtle rounded text-secondary hover:bg-elevated hover:text-primary transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="max-h-[70vh] overflow-y-auto divide-y divide-border-subtle pb-4">
                <WindowedList total={ordered.length} renderItem={(i) => {
                  const c = ordered[i];
                  return (
                    <Link
                      key={c.id}
                      href={linkHref(c)}
                      className="flex items-center justify-between px-4 py-3 hover:bg-elevated text-sm transition-colors"
                    >
                      <span className="text-primary">Ch. {c.chapter_number}{c.title ? ` — ${c.title}` : ''}</span>
                      <span className="text-muted text-xs flex items-center gap-1">
                        Baca
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                      </span>
                    </Link>
                  );
                }} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
