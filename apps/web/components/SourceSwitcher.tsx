'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SOURCE_ORDER } from './SourceBadge';

// Sticky source switcher. Two modes:
// - 'reader': sticky bar above the reader; switches to the same chapter
//   number on another source.
// - 'detail': appears under the manga title on the detail page; switches to
//   the manga detail on another source (source acts as an independent source).
// Default: user preference (localStorage per canonical slug) → komiku → first
// source with a chapter list.

interface SourceLink {
  source: string;
  sourceSlug: string;
  hasChapterList: boolean;
  chapterCount: number;
}

export function SourceSwitcher({
  currentSource,
  sourceId,
  canonicalSlug,
  chapterNumber,
  apiUrl,
  mode = 'reader',
}: {
  currentSource: string;
  sourceId: string;
  canonicalSlug: string | null;
  chapterNumber: number;
  apiUrl: string;
  mode?: 'reader' | 'detail';
}) {
  const router = useRouter();
  const [links, setLinks] = useState<SourceLink[]>([]);
  const [pref, setPref] = useState<string | null>(null);

  // Load aggregated sources from API.
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

  if (links.length <= 1) return null;

  const ordered = SOURCE_ORDER.filter((s) => links.some((l) => l.source === s));
  const active = ordered.find((s) => s === currentSource);

  const onPick = (source: string) => {
    if (source === currentSource) return;
    const link = links.find((l) => l.source === source);
    if (!link) return;
    if (canonicalSlug) {
      localStorage.setItem(`src-pref:${canonicalSlug}`, source);
      setPref(source);
    }
    if (mode === 'detail') {
      // Independent source: go to that source's manga detail page.
      router.push(`/${source}/s/${encodeURIComponent(link.sourceSlug)}?id=${encodeURIComponent(link.sourceSlug)}`);
    } else {
      // Chapter-number matching: the chapter URL on the new source follows the
      // same `<slug>-chapter-<n>` convention.
      router.push(`/${source}/s/${encodeURIComponent(link.sourceSlug)}?ch=${chapterNumber || 1}`);
    }
  };

  return (
    <div className={mode === 'detail' ? 'mb-4' : 'sticky top-16 z-40 mb-4'}>
      <div className={mode === 'detail'
        ? 'flex flex-wrap items-center justify-center gap-2'
        : 'nav-island mx-auto flex items-center gap-2 overflow-x-auto px-3 py-2 rounded-xl'}
        style={mode === 'reader' ? { maxWidth: 'min(1024px, 100%)' } : undefined}>
        <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">Sumber:</span>
        {ordered.map((s) => {
          const link = links.find((l) => l.source === s);
          const isActive = s === currentSource;
          const isDefault = !pref && s === 'komiku';
          const isPref = pref === s;
          return (
            <button
              key={s}
              onClick={() => onPick(s)}
              disabled={!link?.hasChapterList}
              title={`${s}${link?.hasChapterList ? '' : ' (belum ada daftar chapter)'}`}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors shrink-0 ${
                isActive
                  ? 'bg-bg-secondary text-primary ring-1 ring-border-default'
                  : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
              } ${!link?.hasChapterList ? 'opacity-40' : ''}`}
            >
              <SourceIcon source={s} />
              <span className="capitalize">{s}</span>
              {isActive && <span className="text-[9px] text-muted">· aktif</span>}
              {!isActive && isPref && <span className="text-[9px] text-accent">· pilihanmu</span>}
              {!pref && isDefault && !isActive && <span className="text-[9px] text-muted">· default</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SourceIcon({ source }: { source: string }) {
  const icons: Record<string, string> = {
    komiku: '/sources/komiku.png',
    bacakomik: '/sources/bacakomik.png',
    thrive: '/sources/thrive.png',
    manhwaindo: '/sources/manhwaindo.png',
  };
  const src = icons[source];
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="h-4 w-4 rounded-full object-cover ring-1 ring-white/15" />;
}