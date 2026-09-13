import { useEffect, useState } from 'react';
import { getAuthApiUrl, safeType, typedChapterUrl } from '@/lib/api';

interface HistoryItem {
  id: string;
  series_slug: string;
  chapter_number: number;
  title?: string | null;
  series_title?: string | null;
  cover_image?: string | null;
  source?: string;
  type?: string | null;
  updated_at?: number;
}

export function ContinueReadingRail() {
  const [history, setHistory] = useState<HistoryItem[] | null>(null);

  useEffect(() => {
    let alive = true;

    // 1. Check local storage first (instant client cache)
    try {
      const raw = localStorage.getItem('oktz_history');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setHistory(parsed.slice(0, 4));
        }
      }
    } catch {
      // ignore JSON parse error
    }

    // 2. Fetch authenticated history in background
    (async () => {
      try {
        const base = await getAuthApiUrl();
        const res = await fetch(`${base}/api/user/history`, {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(4000),
        });
        if (!alive || !res.ok) return;
        const j = await res.json();
        if (Array.isArray(j.data) && j.data.length > 0) {
          setHistory(j.data.slice(0, 4));
        }
      } catch {
        // silent fail - non-intrusive
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  if (!history || history.length === 0) {
    return null;
  }

  return (
    <section className="mb-12 anim-rise">
      <div className="flex items-baseline justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
          <h2 className="font-display text-xl sm:text-2xl tracking-tight text-primary">Lanjut Baca</h2>
        </div>
        <a href="/history" className="text-xs sm:text-sm text-secondary hover:text-accent transition-colors">
          Riwayat lengkap →
        </a>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        {history.map((item) => {
          const rawId = item.id.includes(':') ? item.id.slice(item.id.lastIndexOf(':') + 1) : item.id;
          const href = typedChapterUrl(safeType(item.type), item.series_slug, rawId);

          return (
            <a
              key={item.id}
              href={href}
              className="group bento-card p-3 flex items-center gap-3.5 hover:border-border-default transition-all"
            >
              <div className="w-10 h-14 shrink-0 overflow-hidden rounded bg-bg-secondary border border-border-subtle flex items-center justify-center text-xs text-muted">
                {item.cover_image ? (
                  <img src={item.cover_image} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span className="font-mono text-[10px]">Ch.{item.chapter_number}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-secondary font-mono tracking-wider uppercase mb-0.5 truncate">
                  {item.series_title || item.series_slug.replace(/-/g, ' ')}
                </p>
                <p className="text-sm font-medium text-primary group-hover:text-accent transition-colors truncate">
                  Chapter {item.chapter_number}
                </p>
                <p className="text-[11px] text-muted mt-0.5">Lanjutkan membaca</p>
              </div>
              <span className="shrink-0 text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-all text-xs font-mono">
                →
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

export default ContinueReadingRail;
