import { useEffect, useRef, useState } from 'react';
import { getAuthApiUrl } from '@/lib/api';

// Bookmark toggle — small black box per manga tile (reader + detail pages).
// Login is detected via GET /me (guest-friendly: 200 + {data:null}); only the
// mutating POST/DELETE bookmark endpoints are rate-limited + session-guarded.
export function BookmarkButton({ slug, size = 'md', title, cover, source }: { slug: string; size?: 'sm' | 'md'; title?: string | null; cover?: string | null; source?: string }) {
  const [on, setOn] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [failed, setFailed] = useState(false);
  const failedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    return () => {
      aliveRef.current = false;
      if (failedTimer.current) clearTimeout(failedTimer.current);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const base = await getAuthApiUrl();
        const me = await fetch(`${base}/api/user/me`, {
          credentials: 'include',
          signal: AbortSignal.timeout(8000),
        });
        if (alive && me.ok) {
          const j = await me.json();
          setSignedIn(!!j?.data);
          if (j?.data) {
            const bk = await fetch(`${base}/api/user/bookmark/${encodeURIComponent(slug)}`, {
              credentials: 'include',
              signal: AbortSignal.timeout(8000),
            });
            if (alive && bk.ok) {
              const b = await bk.json();
              setOn(!!b?.data?.bookmarked);
            }
          }
        }
      } catch {
        if (alive) { /* offline / blocked — treat as guest */ }
      }
    })();
    return () => { alive = false };
  }, [slug]);

  const dim = size === 'sm' ? 'h-9 w-9' : 'h-11 w-11';
  const iconSize = size === 'sm' ? 14 : 18;

  const toggle = async () => {
    if (busy) return;
    if (!signedIn) { window.location.href = '/login'; return; }
    setBusy(true);
    const prevOn = on;
    setOn(!prevOn); // optimistic
    try {
      const base = await getAuthApiUrl();
      if (!aliveRef.current) return;
      const r =
        prevOn
          ? await fetch(`${base}/api/user/bookmark/${encodeURIComponent(slug)}`, {
            method: 'DELETE',
            credentials: 'include',
            signal: AbortSignal.timeout(8000),
          })
          : await fetch(`${base}/api/user/bookmark`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
              seriesSlug: slug,
              title: title ?? undefined,
              cover_image: cover ?? undefined,
              source: source ?? undefined,
            }),
          });
      if (!aliveRef.current) return;
      if (r.status === 401) { setOn(false); window.location.href = '/login'; return; }
      if (!r.ok) { setOn(prevOn); setFailed(true); failedTimer.current = setTimeout(() => setFailed(false), 1500); }
    } catch {
      if (!aliveRef.current) return;
      setOn(prevOn);
      setFailed(true);
      failedTimer.current = setTimeout(() => setFailed(false), 1500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (!busy) toggle(); }}
      disabled={busy}
      aria-pressed={on}
      title={on ? 'Hapus bookmark' : 'Tambah bookmark'}
      className={`${dim} shrink-0 grid place-items-center rounded-lg border bg-black text-white transition-transform duration-150 active:scale-95 ${failed ? 'border-red-500' : 'border-white'} ${busy ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
    >
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3h12v18l-6-4-6 4z" />
      </svg>
    </button>
  );
}

export default BookmarkButton;
