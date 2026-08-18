'use client';
import { useState, useEffect, useRef, type ReactNode } from 'react';

// Windowed list: render PAGE awal, tambah PAGE tiap sentinel masuk viewport
// (IntersectionObserver). Untuk daftar panjang (chapter sheets) supaya DOM
// tidak membengkak — device ringan tanpa library virtualisasi.
const PAGE = 40;

export function WindowedList({
  total,
  renderItem,
  className = '',
}: {
  total: number;
  renderItem: (i: number) => ReactNode;
  className?: string;
}) {
  const [visible, setVisible] = useState(Math.min(total, PAGE));
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset window saat daftar berubah.
  useEffect(() => {
    setVisible(Math.min(total, PAGE));
  }, [total]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visible >= total) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setVisible((v) => Math.min(total, v + PAGE));
        }
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, total]);

  if (total === 0) return null;

  return (
    <div className={className}>
      {Array.from({ length: visible }, (_, i) => renderItem(i))}
      {visible < total && <div ref={sentinelRef} className="h-8" aria-hidden="true" />}
    </div>
  );
}
