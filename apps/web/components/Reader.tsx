'use client';
import { useState, useCallback } from 'react';

export function Reader({ pages, apiUrl }: { pages: { proxyUrl: string }[]; apiUrl: string }) {
  const [mode, setMode] = useState<'scroll' | 'page'>('scroll');
  const [idx, setIdx] = useState(0);
  const [retries, setRetries] = useState<Record<number, number>>({});

  const urls = pages.map((p) => `${apiUrl}${p.proxyUrl}`);

  const handleImageError = useCallback((i: number) => {
    const current = retries[i] ?? 0;
    if (current < 2) {
      setTimeout(() => {
        setRetries((prev) => ({ ...prev, [i]: current + 1 }));
      }, 1000);
    }
  }, [retries]);

  if (mode === 'scroll') {
    return (
      <div>
        <div className="flex gap-2 mb-4">
          <button onClick={() => setMode('page')} className="px-3 py-1 text-xs border border-border-default rounded hover:bg-elevated">Mode Halaman</button>
        </div>
        <div className="flex flex-col items-center gap-1">
          {urls.map((u, i) => {
            const r = retries[i] ?? 0;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${i}-${r}`}
                src={r > 0 ? `${u}?retry=${r}` : u}
                alt={`Halaman ${i + 1}`}
                loading="lazy"
                className="max-w-full h-auto"
                onError={() => handleImageError(i)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  const prev = () => setIdx((i) => Math.max(0, i - 1));
  const next = () => setIdx((i) => Math.min(urls.length - 1, i + 1));

  const r = retries[idx] ?? 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => setMode('scroll')} className="px-3 py-1 text-xs border border-border-default rounded hover:bg-elevated">Mode Scroll</button>
        <span className="text-muted text-xs">{idx + 1} / {urls.length}</span>
      </div>
      <div className="flex flex-col items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={`${idx}-${r}`}
          src={r > 0 ? `${urls[idx]}?retry=${r}` : urls[idx]}
          alt={`Halaman ${idx + 1}`}
          className="max-w-full h-auto"
          onError={() => handleImageError(idx)}
        />
        <div className="flex gap-3 mt-4">
          <button onClick={prev} disabled={idx === 0} className="px-4 py-2 text-sm border border-border-default rounded disabled:opacity-30 hover:bg-elevated">← Sebelumnya</button>
          <button onClick={next} disabled={idx === urls.length - 1} className="px-4 py-2 text-sm border border-border-default rounded disabled:opacity-30 hover:bg-elevated">Berikutnya →</button>
        </div>
      </div>
    </div>
  );
}
