'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

const sections = [
  { id: 'profile', label: 'Profil Publik' },
  { id: 'account', label: 'Akun' },
  { id: 'preferences', label: 'Preferensi' },
  { id: 'privacy', label: 'Privasi & Data' },
  { id: 'sessions', label: 'Sesi Aktif' },
];

interface SidebarProps {
  isAdmin: boolean;
}

export function Sidebar({ isAdmin }: SidebarProps) {
  const [active, setActive] = useState(sections[0].id);

  useEffect(() => {
    const ids = [...sections.map((s) => s.id)];
    if (isAdmin) ids.push('admin');

    const onScroll = () => {
      let current = sections[0].id;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= 120) current = id;
        else break;
      }
      setActive(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [isAdmin]);

  return (
    <nav className="hidden md:block">
      <ul className="sticky top-24 space-y-1.5 text-sm">
          {sections.map((s) => {
          const isActive = active === s.id;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                onClick={() => setActive(s.id)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'text-accent'
                    : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
                }`}
              >
                <span
                  className={`block h-1.5 w-1.5 shrink-0 rounded-full ${
                    isActive ? 'bg-accent' : 'bg-transparent'
                  }`}
                />
                {s.label}
              </a>
            </li>
          );
        })}
        {isAdmin && (
          <li>
            <Link
              href="/admin/load-balancing"
              className="block rounded-lg px-3 py-2 text-secondary hover:text-primary hover:bg-bg-secondary/60 transition-colors"
            >
              Load Balancing (admin)
            </Link>
          </li>
        )}
      </ul>
    </nav>
  );
}
