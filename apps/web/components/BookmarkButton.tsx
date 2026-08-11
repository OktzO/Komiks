'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

// Bookmark toggle — kotak kecil persegi (border putih, bg hitam) di toolbox.
// Guest: POST bookmark → 401 → redirect login.
export function BookmarkButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [guest, setGuest] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await fetch(`${API_URL}/api/user/me`, { credentials: 'include', signal: AbortSignal.timeout(8000) }).then((r) => r.json());
        if (!alive || !me?.data) return;
        setGuest(false);
        const r = await fetch(`${API_URL}/api/user/bookmarks`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
        const j = r.ok ? await r.json() : null;
        if (alive && j?.data) setOn(j.data.some((b: { slug?: string }) => b.slug === slug));
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
    try {
      if (on) {
        const r = await fetch(`${API_URL}/api/user/bookmark/${encodeURIComponent(slug)}`, { method: 'DELETE', credentials: 'include' });
        if (r.ok) setOn(false);
      } else {
        const r = await fetch(`${API_URL}/api/user/bookmark`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seriesSlug: slug }),
        });
        if (r.status === 401) { router.push('/login'); return; }
        if (r.ok) setOn(true);
      }
    } catch {
      // best-effort — tidak ada feedback network error
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={toggle}
      aria-pressed={on}
      title={on ? 'Hapus bookmark' : 'Tambah bookmark'}
      className="h-11 w-11 shrink-0 grid place-items-center rounded-lg border border-white bg-black text-white transition-transform duration-150 active:scale-95"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3h12v18l-6-4-6 4z" />
      </svg>
    </button>
  );
}
