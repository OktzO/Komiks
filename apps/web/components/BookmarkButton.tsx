'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthApiUrl } from '@/lib/api';

// Bookmark toggle — kotak kecil persegi (border putih, bg hitam) di toolbox.
// Guest: GET status → 401 → tombol tampil, aksi redirect login.
// Uses getAuthApiUrl() so the session cookie (set by the auth origin) is sent
// to the correct Worker. Without this, bookmark add/remove can fail silently
// when the main API_URL origin differs from the auth origin.
export function BookmarkButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [guest, setGuest] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const base = await getAuthApiUrl();
        const r = await fetch(`${base}/api/user/bookmark/${encodeURIComponent(slug)}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(8000),
        });
        if (r.status === 401) return; // guest
        const j = r.ok ? await r.json() : null;
        if (alive && j?.data) { setGuest(false); setOn(!!j.data.bookmarked); }
      } catch {
        // best-effort — tombol tetap tampil, aksi akan redirect ke login
      }
    })();
    return () => { alive = false; };
  }, [slug]);

  const toggle = async () => {
    if (busy) return;
    if (guest) { router.push('/login'); return; }
    setBusy(true);
    const prev = on;
    setOn(!prev); // optimistic
    try {
      const base = await getAuthApiUrl();
      const r = prev
        ? await fetch(`${base}/api/user/bookmark/${encodeURIComponent(slug)}`, { method: 'DELETE', credentials: 'include' })
        : await fetch(`${base}/api/user/bookmark`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seriesSlug: slug }),
          });
      if (r.status === 401) { setOn(false); router.push('/login'); return; }
      if (!r.ok) {
        // Retry once with main API_URL in case the auth origin is stale/unreachable
        try {
          const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';
          const r2 = prev
            ? await fetch(`${API_URL}/api/user/bookmark/${encodeURIComponent(slug)}`, { method: 'DELETE', credentials: 'include', signal: AbortSignal.timeout(8000) })
            : await fetch(`${API_URL}/api/user/bookmark`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seriesSlug: slug }),
                signal: AbortSignal.timeout(8000),
              });
          if (r2.status === 401) { setOn(false); router.push('/login'); return; }
          if (!r2.ok) { setOn(prev); setFailed(true); setTimeout(() => setFailed(false), 1500); }
        } catch {
          setOn(prev);
          setFailed(true);
          setTimeout(() => setFailed(false), 1500);
        }
      }
    } catch {
      // Retry with main API_URL as fallback
      try {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';
        const r2 = prev
          ? await fetch(`${API_URL}/api/user/bookmark/${encodeURIComponent(slug)}`, { method: 'DELETE', credentials: 'include', signal: AbortSignal.timeout(8000) })
          : await fetch(`${API_URL}/api/user/bookmark`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seriesSlug: slug }),
              signal: AbortSignal.timeout(8000),
            });
        if (r2.status === 401) { setOn(false); router.push('/login'); return; }
        if (!r2.ok) { setOn(prev); setFailed(true); setTimeout(() => setFailed(false), 1500); }
      } catch {
        setOn(prev);
        setFailed(true);
        setTimeout(() => setFailed(false), 1500);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={toggle}
      aria-pressed={on}
      title={on ? 'Hapus bookmark' : 'Tambah bookmark'}
      className={`h-11 w-11 shrink-0 grid place-items-center rounded-lg border bg-black text-white transition-transform duration-150 active:scale-95 ${failed ? 'border-red-500' : 'border-white'}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3h12v18l-6-4-6 4z" />
      </svg>
    </button>
  );
}
