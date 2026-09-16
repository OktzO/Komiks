import { useEffect, useState } from 'react';
import { fetchMe, logout, type AuthUser } from '@/lib/api';

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/monitoring', label: 'Monitoring' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/merge', label: 'Merge Queue' },
  { href: '/admin/settings', label: 'Settings' },
] as const;

export default function AdminTopbar() {
  const [open, setOpen] = useState(false);
  const [pathname, setPathname] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const syncPath = () => {
      setPathname(window.location.pathname);
      setOpen(false);
    };
    syncPath();
    document.addEventListener('astro:after-swap', syncPath);
    document.addEventListener('astro:page-load', syncPath);
    return () => {
      document.removeEventListener('astro:after-swap', syncPath);
      document.removeEventListener('astro:page-load', syncPath);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((u) => { if (!cancelled) setUser(u); }).catch(() => { if (!cancelled) setUser(null); });
    return () => { cancelled = true; };
  }, []);

  const isActive = (href: string) =>
    href === '/admin' ? pathname === href : pathname === href || pathname.startsWith(href + '/');

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      setUser(null);
      setOpen(false);
    }
  };

  return (
    <header id="admin-navbar" className="fixed inset-x-0 top-0 z-50">
      <div className="nav-island relative mx-auto flex items-center justify-between px-5 py-3">
        <a href="/admin" className="flex items-center gap-2 text-xl tracking-tight font-medium text-primary hover:text-accent">
          <span className="inline-block h-7 w-7 rounded-full bg-gradient-to-br from-accent to-muted" />
          Oktz. Admin
        </a>
        <nav className="hidden md:flex items-center gap-1" aria-label="Navigasi admin">
          {NAV.map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? 'page' : undefined}
              className={`px-3 py-2 text-sm rounded-full transition-colors ${isActive(l.href) ? 'text-sm bg-accent text-primary' : 'text-secondary hover:text-primary hover:bg-bg-secondary'}`}
            >
              {l.label}
            </a>
          ))}
          <a href="/" className="px-3 py-2 text-sm text-secondary hover:text-primary hover:bg-bg-secondary rounded-full transition-colors">
            Ke situs
          </a>
        </nav>
        <div className="hidden md:flex items-center gap-2">
          {user && (
            <span className="px-3 py-1.5 text-xs text-muted truncate max-w-44" title={user.email}>
              {user.email}
              {user.role === 'admin' && <span className="ml-2 text-accent">admin</span>}
            </span>
          )}
          {user && (
            <button
              type="button"
              onClick={handleLogout}
              className="px-3 py-2 text-sm text-primary border border-border-default hover:bg-bg-secondary transition-colors rounded-full"
            >
              Keluar
            </button>
          )}
        </div>
        <button
          className="hamburger md:hidden"
          aria-label="Menu admin"
          aria-expanded={open}
          aria-controls="admin-menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="bars">
            <span />
            <span />
          </span>
        </button>
        <nav id="admin-menu" className={open ? 'open' : ''} hidden={!open} aria-hidden={!open} aria-label="Menu admin">
          {NAV.map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? 'page' : undefined}
              className="px-3 py-3 text-base text-secondary hover:text-primary hover:bg-bg-secondary transition-colors"
            >
              {l.label}
            </a>
          ))}
          <a href="/" className="px-3 py-3 text-base text-secondary hover:text-primary hover:bg-bg-secondary transition-colors">
            Ke situs
          </a>
          {user ? (
            <>
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
            <a href="/login" className="mt-1 px-3 py-2.5 text-base text-primary border border-border-default hover:bg-bg-secondary transition-colors text-center">
              Masuk
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}
