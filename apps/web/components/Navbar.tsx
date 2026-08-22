'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { fetchMe, logout, type AuthUser } from '../lib/api';

const LINKS = [
  { href: '/search', label: 'Cari' },
  { href: '/bookmark', label: 'Bookmark' },
  { href: '/history', label: 'Riwayat' },
  { href: '/status', label: 'Status' },
] as const;

export function Navbar() {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const pathname = usePathname();

  // Reader pages render null (Navbar tidak tampil) — skip fetchMe di sana.
  const readerRoute = (() => {
    const segments = pathname.split('/').filter(Boolean);
    return segments.length === 4 && segments[1] === 's';
  })();

  useEffect(() => {
    if (readerRoute) return;
    let cancelled = false;
    fetchMe().then((u) => { if (!cancelled) setUser(u); });
    return () => { cancelled = true; };
  }, [pathname, readerRoute]);

  useEffect(() => {
    let ticking = false;
    let rafId = 0;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      rafId = requestAnimationFrame(() => {
        const el = document.getElementById('navbar');
        if (!el) { ticking = false; return; }
        if (window.scrollY > 1) el.classList.add('navbar-scrolled');
        else el.classList.remove('navbar-scrolled');
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  const segments = pathname.split('/').filter(Boolean);
  // Admin adalah app shell sendiri (sidebar fixed) — main navbar island
  // tidak boleh overlap. Reader pages juga null (Navbar tidak tampil).
  if (segments[0] === 'admin') return null;
  if (segments.length === 4 && segments[1] === 's') return null;

  const isAdmin = user?.role === 'admin';

  return (
    <header id="navbar" className="fixed inset-x-0 top-0 z-50">
      <div className="nav-island relative mx-auto flex items-center justify-between px-5 py-3">
        <Link href="/" className="flex items-center gap-2 text-xl tracking-tight font-medium text-primary hover:text-accent">
          <span className="inline-block h-7 w-7 rounded-full bg-gradient-to-br from-accent to-muted" />
          Oktz.
        </Link>
        <button
          className="hamburger"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen(o => !o)}
        >
          <span className="bars">
            <span />
            <span />
          </span>
        </button>
        <nav id="nav-menu" className={open ? 'open' : ''} aria-hidden={!open}>
          {LINKS.map(l => (
            <Link key={l.href} href={l.href} className="px-3 py-3 text-base text-secondary hover:text-primary hover:bg-bg-secondary transition-colors">
              {l.label}
            </Link>
          ))}
          {user ? (
            <>
              {isAdmin && (
                <Link href="/admin/settings" className="px-3 py-3 text-base text-secondary hover:text-primary hover:bg-bg-secondary transition-colors">
                  Admin setting
                </Link>
              )}
              <Link href="/profile" className="px-3 py-3 text-base text-secondary hover:text-primary hover:bg-bg-secondary transition-colors">
                Profile
              </Link>
              <div className="mt-1 px-3 py-1.5 text-xs text-muted truncate" title={user.email}>
                {user.email}
                {user.role === 'admin' && <span className="ml-2 text-accent">admin</span>}
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="mt-1 px-3 py-2.5 text-base text-primary border border-border-default hover:bg-bg-secondary transition-colors text-center"
              >
                Keluar
              </button>
            </>
          ) : (
            <Link href="/login" className="mt-1 px-3 py-2.5 text-base text-primary border border-border-default hover:bg-bg-secondary transition-colors text-center">
              Masuk
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

export default Navbar;
