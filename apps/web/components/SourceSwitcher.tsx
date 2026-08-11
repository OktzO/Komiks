'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SOURCE_ORDER, sourceLabel } from './SourceBadge';

// Source switcher. Two modes:
// - 'detail': a "Source" button under the manga title. Tap → dropdown panel
//   listing every source that hosts this manga (all badges). Picking one
//   navigates to that source's manga detail page (independent source).
// - 'reader': sticky bar above the reader; switches to the same chapter
//   number on another source.
// Default: user preference (localStorage per canonical slug) → komiku → first
// source with a chapter list.

interface SourceLink {
  source: string;
  sourceSlug: string;
  hasChapterList: boolean;
  chapterCount: number;
}

const SOURCE_ICONS: Record<string, string> = {
  komiku: '/sources/komiku.png',
  bacakomik: '/sources/bacakomik.png',
  thrive: '/sources/thrive.png',
  manhwaindo: '/sources/manhwaindo.png',
};

function SourceIcon({ source, dim = 'h-4 w-4' }: { source: string; dim?: string }) {
  const src = SOURCE_ICONS[source];
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={`${dim} rounded-full object-cover ring-1 ring-white/15`} />;
}

export function SourceSwitcher({
  currentSource,
  sourceId,
  canonicalSlug,
  chapterNumber,
  apiUrl,
  mode = 'reader',
  embedded = false,
}: {
  currentSource: string;
  sourceId: string;
  canonicalSlug: string | null;
  chapterNumber: number;
  apiUrl: string;
  mode?: 'reader' | 'detail';
  embedded?: boolean;
}) {
  const router = useRouter();
  const [links, setLinks] = useState<SourceLink[]>([]);
  const [pref, setPref] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Load aggregated sources from API (live-resolve when aggregation empty).
  useEffect(() => {
    let alive = true;
    fetch(`${apiUrl}/api/reader/${currentSource}/series/${encodeURIComponent(sourceId)}/sources`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j?.data?.sources) return;
        setLinks(j.data.sources);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [apiUrl, currentSource, sourceId]);

  // Load user preference.
  useEffect(() => {
    if (!canonicalSlug) return;
    const saved = localStorage.getItem(`src-pref:${canonicalSlug}`);
    setPref(saved);
  }, [canonicalSlug]);

  // Close panel on route change.
  useEffect(() => { setOpen(false); }, [router]);

  if (links.length <= 1) return null;

  const ordered = SOURCE_ORDER.filter((s) => links.some((l) => l.source === s));

  const onPick = (source: string) => {
    const link = links.find((l) => l.source === source);
    if (!link) return;
    if (source !== currentSource && canonicalSlug) {
      localStorage.setItem(`src-pref:${canonicalSlug}`, source);
      setPref(source);
    }
    if (mode === 'detail') {
      if (source === currentSource) { setOpen(false); return; }
      router.push(`/${source}/s/${encodeURIComponent(link.sourceSlug)}?id=${encodeURIComponent(link.sourceSlug)}`);
    } else {
      if (source === currentSource) return;
      // Bawa ke chapter yang sama di source lain. Kalau tidak ada chapter
      // number (detail flow), mendarat di halaman detail source tersebut.
      const base = `/${source}/s/${encodeURIComponent(link.sourceSlug)}`;
      router.push(chapterNumber > 0 ? `${base}/${encodeURIComponent(link.sourceSlug)}-chapter-${chapterNumber}?id=${encodeURIComponent(link.sourceSlug)}` : `${base}?id=${encodeURIComponent(link.sourceSlug)}`);
    }
  };

  // ── Detail mode: "Source" button + dropdown panel with all badges ──
  if (mode === 'detail') {
    const active = ordered.find((s) => s === currentSource);
    return (
      <div className="relative mb-5">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="inline-flex items-center gap-2 rounded-full border border-border-default bg-card/60 px-3.5 py-1.5 text-xs text-secondary hover:text-primary hover:border-border-subtle transition-colors"
        >
          <SourceIcon source={currentSource} />
          <span className="text-primary font-medium capitalize">{active ?? currentSource}</span>
          <span className="text-muted text-[10px]">· {ordered.length} sumber</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-2 z-40 min-w-[220px] rounded-xl border border-border-subtle bg-elevated shadow-xl p-1.5 anim-slide-up">
            {ordered.map((s) => {
              const link = links.find((l) => l.source === s);
              const isActive = s === currentSource;
              const isPref = pref === s;
              const isDefault = !pref && s === 'komiku';
              return (
                <button
                  key={s}
                  onClick={() => onPick(s)}
                  disabled={!link?.hasChapterList}
                  title={`${sourceLabel(s)}${link?.hasChapterList ? '' : ' (belum ada daftar chapter)'}`}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors text-left ${
                    isActive ? 'bg-bg-secondary text-primary' : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
                  } ${!link?.hasChapterList ? 'opacity-40' : ''}`}
                >
                  <SourceIcon source={s} dim="h-5 w-5" />
                  <span className="capitalize flex-1">{sourceLabel(s)}</span>
                  {isActive && <span className="text-[10px] text-muted">aktif</span>}
                  {!isActive && isPref && <span className="text-[10px] text-accent">pilihanmu</span>}
                  {!pref && isDefault && !isActive && <span className="text-[10px] text-muted">default</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── Reader mode: sticky bar with all source badges ──
  const orderedChips = ordered.map((s) => {
    const link = links.find((l) => l.source === s);
    const isActive = s === currentSource;
    const isPref = pref === s;
    const isDefault = !pref && s === 'komiku';
    return (
      <button
        key={s}
        onClick={() => onPick(s)}
        disabled={!link?.hasChapterList}
        title={`${sourceLabel(s)}${link?.hasChapterList ? '' : ' (belum ada daftar chapter)'}`}
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors shrink-0 ${
          isActive
            ? 'bg-bg-secondary text-primary ring-1 ring-border-default'
            : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
        } ${!link?.hasChapterList ? 'opacity-40' : ''}`}
      >
        <SourceIcon source={s} />
        <span className="capitalize">{sourceLabel(s)}</span>
        {isActive && <span className="text-[9px] text-muted">· aktif</span>}
        {!isActive && isPref && <span className="text-[9px] text-accent">· pilihanmu</span>}
        {!pref && isDefault && !isActive && <span className="text-[9px] text-muted">· default</span>}
      </button>
    );
  });

  if (embedded) {
    return <div className="flex flex-wrap items-center gap-1.5">{orderedChips}</div>;
  }

  return (
    <div className="sticky top-16 z-40 mb-4">
      <div className="nav-island mx-auto flex items-center gap-2 overflow-x-auto px-3 py-2 rounded-xl" style={{ maxWidth: 'min(1024px, 100%)' }}>
        <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">Sumber:</span>
        {orderedChips}
      </div>
    </div>
  );
}