import { useState, useCallback, useEffect, useRef } from 'react';
import { getChapter, imgOriginFor } from '@/lib/api';

// Virtualized scroll reader: renders only a viewport window + buffer instead
// of all pages at once. This caps concurrent image-proxy Worker invocations
// from ~N (all pages) to ~window+buffer (e.g. 8). Pages outside the window
// are unmounted; their <img> is re-fetched lazily when scrolled into view.
const WINDOW = 3; // pages rendered ahead of current viewport
const BEHIND = 1;  // pages kept rendered behind current viewport

export function Reader({
  source,
  pages,
  apiUrl,
  nextChapterId,
  mode: modeProp,
  onModeChange,
  onActivePage,
}: {
  source: string;
  pages: { proxyUrl: string; imgUrl?: string | null; b2Url?: string | null }[];
  apiUrl: string;
  nextChapterId?: string | null;
  mode?: 'scroll' | 'page';
  onModeChange?: (m: 'scroll' | 'page') => void;
  onActivePage?: (i: number) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [retries, setRetries] = useState<Record<number, number>>({});
  const [visibleCount, setVisibleCount] = useState(Math.min(pages.length, WINDOW + BEHIND + 1));
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});
  const retryTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const activeMode = modeProp ?? 'scroll';

  // Round-robin /img/*: hash stabil per halaman → worker sama (cache hangat),
  // retry>0 → geser ke worker lain (failover). Akun-1 (origin utama) dieksklusi.
  const pageImageUrl = (p: { proxyUrl: string; imgUrl?: string | null; b2Url?: string | null }, retry = 0): string => {
    const base = p.imgUrl ? imgOriginFor(p.imgUrl, retry) : apiUrl;
    return `${base}${p.imgUrl ?? p.proxyUrl}${retry > 0 ? `?retry=${retry}` : ''}`;
  };
  const urls = pages.map((p) => pageImageUrl(p, 0));

  const handleImageError = useCallback((i: number) => {
    const current = retries[i] ?? 0;
    if (current < 2) {
      clearTimeout(retryTimers.current[i]);
      retryTimers.current[i] = setTimeout(() => {
        setRetries((prev) => ({ ...prev, [i]: (prev[i] ?? 0) + 1 }));
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

  // Observer halaman aktif di mode scroll — satu IntersectionObserver,
  // re-observe semua img terpasang saat observer dibuat ulang.
  const ioRef = useRef<IntersectionObserver | null>(null);
  const imgEls = useRef(new Map<number, HTMLElement>());
  const activeModeRef = useRef(activeMode);
  activeModeRef.current = activeMode;

  const setImgRef = useCallback((i: number, el: HTMLElement | null) => {
    const prev = imgEls.current.get(i);
    if (prev && prev !== el) {
      ioRef.current?.unobserve(prev);
      imgEls.current.delete(i);
    }
    if (el) {
      imgEls.current.set(i, el);
      if (activeModeRef.current === 'scroll') ioRef.current?.observe(el);
    }
  }, []);

  useEffect(() => {
    if (!onActivePage) return;
    const io = new IntersectionObserver(
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
    ioRef.current = io;
    imgEls.current.forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      ioRef.current = null;
    };
  }, [reportActive]);

  useEffect(() => {
    if (!ioRef.current) return;
    if (activeMode === 'scroll') imgEls.current.forEach((el) => ioRef.current?.observe(el));
    else imgEls.current.forEach((el) => ioRef.current?.unobserve(el));
  }, [activeMode]);

  useEffect(() => {
    const els = imgEls.current;
    return () => {
      els.clear();
    };
  }, [pages]);

  // Prefetch bab berikutnya: max 1 bab, fire sekali, saat user tiba di
  // halaman terakhir. Hanya menghangatkan KV/metadata via getChapter —
  // gambar tetap lazy saat navigate. Gagal = silent.
  const prefetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!nextChapterId || visibleCount < pages.length || prefetchedRef.current === nextChapterId) return;
    prefetchedRef.current = nextChapterId;
    const t = setTimeout(() => {
      getChapter(source, nextChapterId).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [visibleCount, pages.length, nextChapterId, source]);

  // Track loaded state → show skeleton slot until image resolves.
  const markLoaded = useCallback((i: number) => {
    setLoaded((prev) => (prev[i] ? prev : { ...prev, [i]: true }));
  }, []);

  const pageSlot = (i: number, u: string, r: number) => (
    <div className="relative w-full max-w-xl">
      {!loaded[i] && <div className="skeleton absolute inset-0" aria-hidden="true" />}
      <img
        src={r > 0 ? pageImageUrl(pages[i], r) : u}
        alt={`Halaman ${i + 1}`}
        loading="lazy" referrerpolicy="no-referrer"
        data-idx={i}
        ref={(el) => setImgRef(i, el)}
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

export default Reader;
