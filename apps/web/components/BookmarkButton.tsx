'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthApiUrl } from '@/lib/api';

// Bookmark toggle — small black box per manga tile (reader + detail pages).
// Login is detected via GET /me (guest-friendly: 200 + {data:null}); only the
// mutating POST/DELETE bookmark endpoints are rate-limited + session-guarded.
export function BookmarkButton({ slug, size = 'md' }: { slug: string; size?: 'sm' | 'md' }) {
  const router = useRouter();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const base = await getAuthApiUrl();
        const r = await fetch(`${base}/api/user/me`, {
          credentials: 'include',
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return; // treat as guest
        const j = await r.json();
        if (alive) setSignedIn(!!j?.data);
      } catch {
        // offline / blocked — treat as guest, actions will redirect to login
      }
    })();
    return () => { alive = false };
  }, []);

  const dim = size === 'sm' ? 'h-9 w-9' : 'h-11 w-11';
  const iconSize = size === 'sm' ? 14 : 18;

  const toggle = async () => {
    if (busy) return;
    if (!signedIn) { router.push('/login'); return; }
    setBusy(true);
    const prev = on;
    setOn(!prev); // optimistic
    try {
      const base = await getAuthApiUrl();
      const r =
        prev
          ? await fetch(`${base}/api/user/bookmark/${encodeURIComponent(slug)}`, {
              method: 'DELETE',
              credentials: 'include',
              signal: AbortSignal.timeout(8000),
            })
          : await fetch(`${base}/api/user/bookmark`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seriesSlug: slug }),
            });
      if (r.status === 401) { setOn(false); router.push('/login'); return; }
      if (!r.ok) { setOn(prev); setFailed(true); setTimeout(() => setFailed(false), 1500); }
    } catch {
      setOn(prev);
      setFailed(true);
      setTimeout(() => setFailed(false), 1500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggle(); }}
      aria-pressed={on}
      title={on ? 'Hapus bookmark' : 'Tambah bookmark'}
      className={`${dim} shrink-0 grid place-items-center rounded-lg border bg-black text-white transition-transform duration-150 active:scale-95 ${failed ? 'border-red-500' : 'border-white'}`}
    >
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3h12v18l-6-4-6 4z" />
      </svg>
    </button>
  );
}
