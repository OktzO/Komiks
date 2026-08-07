'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/search', label: 'Cari' },
  { href: '/bookmark', label: 'Bookmark' },
  { href: '/history', label: 'Riwayat' },
  { href: '/status', label: 'Status' },
] as const;

export function Navbar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const el = document.getElementById('navbar');
        if (!el) { ticking = false; return; }
        if (window.scrollY > 1) el.classList.add('navbar-scrolled');
        else el.classList.remove('navbar-scrolled');
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header id="navbar" className="px-4 py-3">
      <div className="mx-auto flex items-center" style={{ maxWidth: 'min(1024px, 100%)' }}>
        <Link href="/" className="flex items-center gap-2 text-xl tracking-tight font-medium text-primary hover:text-accent">
          <span className="inline-block h-7 w-7 rounded-full bg-gradient-to-br from-accent to-muted" />
          Manga
        </Link>
        <button
          className="hamburger ml-auto"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen(o => !o)}
        >
          <span />
          <span />
        </button>
      </div>
      <nav id="nav-menu" className={open ? 'open' : ''} aria-hidden={!open}>
        <div className="mx-auto mt-2 flex flex-col" style={{ maxWidth: 'min(1024px, 100%)' }}>
          {LINKS.map(l => (
            <Link key={l.href} href={l.href} className="px-3 py-3 text-base text-secondary hover:text-primary rounded-lg hover:bg-bg-secondary transition-colors">
              {l.label}
            </Link>
          ))}
          <Link href="/login" className="mx-3 my-2 px-3 py-2.5 text-base text-primary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors text-center">
            Masuk
          </Link>
        </div>
      </nav>
    </header>
  );
}

export default Navbar;
