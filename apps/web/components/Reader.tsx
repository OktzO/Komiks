'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

// Virtualized scroll reader: renders only a viewport window + buffer instead
// of all pages at once. This caps concurrent image-proxy Worker invocations
// from ~N (all pages) to ~window+buffer (e.g. 8). Pages outside the window
// are unmounted; their <img> is re-fetched lazily when scrolled into view.
const WINDOW = 3; // pages rendered ahead of current viewport
const BEHIND = 1;  // pages kept rendered behind current viewport

export function Reader({
  pages,
  apiUrl,
  nextChapterUrl,
  mode: modeProp,
  onModeChange,
  onActivePage,
}: {
  pages: { proxyUrl: string; b2Url?: string | null }[];
  apiUrl: string;
  nextChapterUrl?: string | null;
  mode?: 'scroll' | 'page';
  onModeChange?: (m: 'scroll' | 'page') => void;
  onActivePage?: (i: number) => void;
}) {
  const [mode, setMode] = useState<'scroll' | 'page'>('scroll');
  const [idx, setIdx] = useState(0);
  const [retries, setRetries] = useState<Record<number, number>>({});
  const [visibleCount, setVisibleCount] = useState(Math.min(pages.length, WINDOW + BEHIND + 1));
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});
  const retryTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const router = useRouter();

  const activeMode = modeProp ?? mode;
  const switchMode = (m: 'scroll' | 'page') => {
    if (onModeChange) onModeChange(m);
    setMode(m);
  };

  // Storage-first: B2 presigned (primary) → proxy.
  // Proxy sekaligus meng-upload ke storage di background → request berikutnya
  // dapat URL langsung dari chapter detail lagi.
  const urls = pages.map((p) => p.b2Url ?? `${apiUrl}${p.proxyUrl}`);
  const fallbackUrls = pages.map((p) => `${apiUrl}${p.proxyUrl}`);

  const handleImageError = useCallback((i: number) => {
    const current = retries[i] ?? 0;
    if (current < 2) {
      retryTimers.current[i] = setTimeout(() => {
        setRetries((prev) => ({ ...prev, [i]: current + 1 }));
      }, 1000);
    }
  }, [retries]);

  // Cleanup semua pending retry timers saat unmount.
  useEffect(() => {
    return () => {
      for (const t of Object.values(retryTimers.current)) clearTimeout(t);
      retryTimers.current = {};
    };
  }, []);

  // Expand the visible window as the user scrolls near the bottom.
  const loadMore = useCallback(() => {
    setVisibleCount((v) => Math.min(pages.length, v + WINDOW));
  }, [pages.length]);

  useEffect(() => {
    const onScroll = () => {
      const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 1500;
      if (nearBottom) loadMore();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [loadMore]);

  // Lapor halaman terlihat sekarang (untuk tombol unduh di toolbar).
  const reportActive = useCallback(
    (i: number) => { if (onActivePage) onActivePage(i); },
    [onActivePage]
  );

  // Observer halaman aktif di mode scroll — pasif, satu IntersectionObserver.
  const ioRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    if (!onActivePage) return;
    ioRef.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = Number((e.target as HTMLElement).dataset.idx);
            if (!Number.isNaN(i)) reportActive(i);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.1 }
    );
    return () => ioRef.current?.disconnect();
  }, [reportActive]);

  // Prefetch next chapter image pages once user reaches the last rendered page.
  useEffect(() => {
    if (!nextChapterUrl || visibleCount < pages.length) return;
    const t = setTimeout(() => { router.prefetch(nextChapterUrl); }, 800);
    return () => clearTimeout(t);
  }, [visibleCount, pages.length, nextChapterUrl, router]);

  // Track loaded state → show skeleton slot until image resolves.
  const markLoaded = useCallback((i: number) => {
    setLoaded((prev) => (prev[i] ? prev : { ...prev, [i]: true }));
  }, []);

  const pageSlot = (i: number, u: string, r: number) => (
    <div className="relative w-full max-w-xl">
      {!loaded[i] && <div className="skeleton absolute inset-0" aria-hidden="true" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={r > 0 ? `${fallbackUrls[i]}?retry=${r}` : u}
        alt={`Halaman ${i + 1}`}
        loading="lazy"
        data-idx={i}
        ref={(el) => {
          if (el && ioRef.current && activeMode === 'scroll') ioRef.current.observe(el);
        }}
        className="max-w-full h-auto"
        onError={() => handleImageError(i)}
        onLoad={() => markLoaded(i)}
      />
    </div>
  );

  // Lapor idx default saat mode page.
  useEffect(() => {
    if (activeMode === 'page') reportActive(idx);
  }, [idx, activeMode, reportActive]);

  if (activeMode === 'scroll') {
    const visible = urls.slice(0, visibleCount);
    return (
      <div className="flex flex-col items-center">
        {visible.map((u, i) => pageSlot(i, u, retries[i] ?? 0))}
        {visibleCount < urls.length && (
          <button onClick={loadMore} className="px-4 py-2 text-sm border border-border-default rounded hover:bg-elevated mt-2">Muat lebih banyak</button>
        )}
      </div>
    );
  }

  const prev = () => setIdx((i) => Math.max(0, i - 1));
  const next = () => setIdx((i) => Math.min(urls.length - 1, i + 1));

  const r = retries[idx] ?? 0;
  return (
    <div className="flex flex-col items-center">
      {pageSlot(idx, urls[idx], r)}
      <div className="flex gap-3 mt-4">
        <button onClick={prev} disabled={idx === 0} className="px-4 py-2 text-sm border border-border-default rounded disabled:opacity-30 hover:bg-elevated">← Sebelumnya</button>
        <button onClick={next} disabled={idx === urls.length - 1} className="px-4 py-2 text-sm border border-border-default rounded disabled:opacity-30 hover:bg-elevated">Berikutnya →</button>
      </div>
    </div>
  );
}