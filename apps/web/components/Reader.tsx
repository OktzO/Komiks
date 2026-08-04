'use client';
import { useState } from 'react';

export function Reader({ pages, apiUrl }: { pages: { proxyUrl: string }[]; apiUrl: string }) {
  const [mode, setMode] = useState<'scroll' | 'page'>('scroll');
  const [idx, setIdx] = useState(0);

  const urls = pages.map((p) => `${apiUrl}${p.proxyUrl}`);

  if (mode === 'scroll') {
    return (
      <div>
        <div className="flex gap-2 mb-4">
          <button onClick={() => setMode('page')} className="px-3 py-1 text-xs border border-border-default rounded hover:bg-elevated">Mode Halaman</button>
        </div>
        <div className="flex flex-col items-center gap-1">
          {urls.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={u} alt={`Halaman ${i + 1}`} loading="lazy" className="max-w-full h-auto" />
          ))}
        </div>
      </div>
    );
  }

  const prev = () => setIdx((i) => Math.max(0, i - 1));
  const next = () => setIdx((i) => Math.min(urls.length - 1, i + 1));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => setMode('scroll')} className="px-3 py-1 text-xs border border-border-default rounded hover:bg-elevated">Mode Scroll</button>
        <span className="text-muted text-xs">{idx + 1} / {urls.length}</span>
      </div>
      <div className="flex flex-col items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={urls[idx]} alt={`Halaman ${idx + 1}`} className="max-w-full h-auto" />
        <div className="flex gap-3 mt-4">
          <button onClick={prev} disabled={idx === 0} className="px-4 py-2 text-sm border border-border-default rounded disabled:opacity-30 hover:bg-elevated">← Sebelumnya</button>
          <button onClick={next} disabled={idx === urls.length - 1} className="px-4 py-2 text-sm border border-border-default rounded disabled:opacity-30 hover:bg-elevated">Berikutnya →</button>
        </div>
      </div>
    </div>
  );
}
