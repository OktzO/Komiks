'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SOURCE_ORDER, sourceLabel } from './SourceBadge';
import { isValidType, typedChapterUrl, typedUrl, type ComicType } from '@/lib/api';
import { chooseSource, orderedSources, type SourceLink as ChoiceLink } from '@/lib/sourceChoice';

// Type tak dikenal/absen → 'manga' (route kanonik redirect ke type benar).
const safeType = (t?: string | null): ComicType =>
  isValidType(t ?? '') ? (t as ComicType) : 'manga';

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
  shinigami: '/sources/shinigami.png',
};

// Coalescing cache: 2 instance (settings popup + chapter sheet) di reader
// mount bersamaan dan fetch URL yang sama — bagi satu promise, bukan dua
// request. Cache 30s, cukup untuk satu sesi baca.
const inFlight = new Map<string, Promise<SourceData | null>>();

interface SourceData {
  sources: SourceLink[];
  recommendedSource: string | null;
}

async function fetchSourceLinks(apiUrl: string, source: string, sourceId: string): Promise<SourceData | null> {
  const url = `${apiUrl}/api/reader/${source}/series/${encodeURIComponent(sourceId)}/sources`;
  const hit = inFlight.get(url);
  if (hit) return hit;
  const p = fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.data ? { sources: (j.data.sources as SourceLink[]) ?? [], recommendedSource: (j.data.recommendedSource as string | null) ?? null } : null))
    .catch(() => null)
    .finally(() => setTimeout(() => inFlight.delete(url), 30000));
  inFlight.set(url, p);
  return p;
}

function SourceIcon({ source, dim = 'h-4 w-4' }: { source: string; dim?: string }) {
  const src = SOURCE_ICONS[source];
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={`${dim} rounded-full object-cover ring-1 ring-white/15`} />;
}

// Per-slug source preference. Single JSON key + LRU cap (else a key per manga
// slug grows localStorage unbounded for heavy readers).
const PREF_KEY = 'src-prefs';
const PREF_MAX = 50;

function readPref(slug: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as Record<string, string>;
    return map[slug] ?? null;
  } catch { return null; }
}

// Simpan pref di localStorage (highlight client) + cookie (server-side auto
// redirect di detail page). Cookie dipakai server utk skip redirect ketika
// user sudah memilih source manual. encodeURIComponent karena isi JSON
// (braces/quotes). Path=/ supaya terbaca semua route.
const PREF_COOKIE = 'src-prefs';

function writePref(slug: string, source: string) {
  try {
    const map = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as Record<string, string>;
    // LRU: delete lalu re-insert → entry terbaru selalu di akhir object.
    delete map[slug];
    map[slug] = source;
    const keys = Object.keys(map);
    if (keys.length > PREF_MAX) {
      for (const k of keys.slice(0, keys.length - PREF_MAX)) delete map[k];
    }
    localStorage.setItem(PREF_KEY, JSON.stringify(map));
    try {
      document.cookie = `${PREF_COOKIE}=${encodeURIComponent(JSON.stringify(map))}; path=/; max-age=31536000; samesite=Lax`;
    } catch { /* cookie best-effort — pref tetap jalan via localStorage */ }
  } catch {}
}

export function SourceSwitcher({
  currentSource,
  sourceId,
  canonicalSlug,
  chapterNumber,
  apiUrl,
  mode = 'reader',
  embedded = false,
  links: initialLinks,
  recommendedSource: initialRecommended,
  type,
}: {
  currentSource: string;
  sourceId: string;
  canonicalSlug: string | null;
  chapterNumber: number;
  apiUrl: string;
  mode?: 'reader' | 'detail';
  embedded?: boolean;
  links?: SourceLink[];
  recommendedSource?: string | null;
  type?: string;
}) {
  const router = useRouter();
  const [links, setLinks] = useState<SourceLink[]>(initialLinks ?? []);
  const [recommended, setRecommended] = useState<string | null>(initialRecommended ?? null);
  const [pref, setPref] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const recommendedRef = useRef(initialRecommended ?? null);

  // Load aggregated sources from API (live-resolve when aggregation empty).
  // Kalau data sudah datang dari server (prop links) → skip fetch.
  useEffect(() => {
    if (initialLinks) return;
    let alive = true;
    fetchSourceLinks(apiUrl, currentSource, sourceId).then((l) => {
      if (!alive || !l) return;
      setLinks(l.sources);
      if (!recommendedRef.current && l.recommendedSource) {
        recommendedRef.current = l.recommendedSource;
        setRecommended(l.recommendedSource);
      }
    });
    return () => { alive = false; };
  }, [apiUrl, currentSource, sourceId, initialLinks]);

  // Load user preference.
  useEffect(() => {
    if (!canonicalSlug) return;
    setPref(readPref(canonicalSlug));
  }, [canonicalSlug]);

  // Close panel + clear indikator saat navigasi selesai (route berubah).
  useEffect(() => { setOpen(false); }, [router]);
  useEffect(() => {
    if (!pending) setPendingSource(null);
  }, [pending]);

  if (links.length <= 1) return null;

  // Urutan stabil + "default" dihitung oleh helper yang sama dengan server,
  // supaya highlight di sini identik dengan badge di halaman komik/landing.
  const orderedLinks = orderedSources(links as ChoiceLink[]);
  const ordered = orderedLinks.map((l) => l.source);
  const defaultSource = chooseSource(links as ChoiceLink[], { recommended, pref, current: currentSource })?.source ?? null;

  // Progress bar pindah source — reuse animasi .route-progress (top bar),
  // plus label "Memuat…" di chip yang dipilih. Dibungkus useTransition supaya
  // indikator berhenti tepat saat render selesai, bukan tebakan durasi.
  const SwitchingBar = pending ? <div className="route-progress" aria-hidden="true" /> : null;

  const onPick = (source: string) => {
    const link = links.find((l) => l.source === source);
    if (!link) return;
    if (source !== currentSource && canonicalSlug) {
      writePref(canonicalSlug, source);
      setPref(source);
    }
    if (source === currentSource) { setOpen(false); return; }
    setPendingSource(source);
    const go = () => {
      if (mode === 'detail') {
        router.push(typedUrl(safeType(type), canonicalSlug ?? link.sourceSlug));
      } else {
        // Bawa ke chapter yang sama di source lain. Kalau tidak ada chapter
        // number (detail flow), mendarat di halaman detail source tersebut.
        const slug = canonicalSlug ?? link.sourceSlug;
        const t = safeType(type);
        router.push(
          chapterNumber > 0
            ? typedChapterUrl(t, slug, `${link.sourceSlug}-chapter-${chapterNumber}`)
            : typedUrl(t, slug)
        );
      }
    };
    startTransition(() => { go(); });
  };

  // ── Detail mode: "Source" button + dropdown panel with all badges ──
  if (mode === 'detail') {
    const active = ordered.find((s) => s === currentSource);
    return (
      <div className="relative mb-5">
        {SwitchingBar}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-busy={pending || undefined}
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
              const isDefault = !pref && s === defaultSource && !isActive;
              const isLoading = pendingSource === s;
              return (
                <button
                  key={s}
                  onClick={() => onPick(s)}
                  disabled={!link?.hasChapterList || pending}
                  title={`${sourceLabel(s)}${link?.hasChapterList ? '' : ' (belum ada daftar chapter)'}`}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors text-left ${
                    isActive ? 'bg-bg-secondary text-primary' : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
                  } ${!link?.hasChapterList ? 'opacity-40' : ''}`}
                >
                  <SourceIcon source={s} dim="h-5 w-5" />
                  <span className="capitalize flex-1">{sourceLabel(s)}</span>
                  {isLoading ? (
                    <span className="src-spinner" aria-label="Memuat sumber" />
                  ) : (
                    <>
                      {isActive && <span className="text-[10px] text-muted">aktif</span>}
                      {!isActive && isPref && <span className="text-[10px] text-accent">pilihanmu</span>}
                      {isDefault && <span className="text-[10px] text-muted">default</span>}
                    </>
                  )}
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
    const isDefault = !pref && s === defaultSource && !isActive;
    const isLoading = pendingSource === s;
    return (
      <button
        key={s}
        onClick={() => onPick(s)}
        disabled={!link?.hasChapterList || pending}
        aria-busy={isLoading || undefined}
        title={`${sourceLabel(s)}${link?.hasChapterList ? '' : ' (belum ada daftar chapter)'}`}
        className={`src-chip flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors shrink-0 ${
          isActive
            ? 'bg-bg-secondary text-primary ring-1 ring-border-default'
            : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
        } ${!link?.hasChapterList ? 'opacity-40' : ''} ${isLoading ? 'src-chip-loading' : ''}`}
      >
        <SourceIcon source={s} />
        <span className="capitalize">{sourceLabel(s)}</span>
        {isLoading ? (
          <span className="src-spinner" aria-label="Memuat sumber" />
        ) : (
          <>
            {isActive && <span className="text-[9px] text-muted">· aktif</span>}
            {!isActive && isPref && <span className="text-[9px] text-accent">· pilihanmu</span>}
            {isDefault && <span className="text-[9px] text-muted">· default</span>}
          </>
        )}
      </button>
    );
  });

  if (embedded) {
    return <div className="flex flex-wrap items-center gap-1.5">{orderedChips}</div>;
  }

  return (
    <div className="sticky top-16 z-40 mb-4">
      {SwitchingBar}
      <div className="nav-island mx-auto flex items-center gap-2 overflow-x-auto px-3 py-2 rounded-xl" style={{ maxWidth: 'min(1024px, 100%)' }}>
        <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">Sumber:</span>
        {orderedChips}
      </div>
    </div>
  );
}