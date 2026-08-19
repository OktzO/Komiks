'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

const sections = [
  { id: 'profile', label: 'Profil Publik' },
  { id: 'account', label: 'Akun' },
  { id: 'preferences', label: 'Preferensi' },
  { id: 'privacy', label: 'Privasi & Data' },
];

interface SidebarProps {
  isAdmin: boolean;
}

export function Sidebar({ isAdmin }: SidebarProps) {
  const [active, setActive] = useState(sections[0].id);

  useEffect(() => {
    const ids = [...sections.map((s) => s.id)];
    if (isAdmin) ids.push('admin');

    let ticking = false;
    let rafId = 0;
    const update = () => {
      ticking = false;
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
    const onScroll = () => {
      // rAF-throttle: getBoundingClientRect hanya 1x per frame,
      // bukan per scroll event (hindari forced reflow).
      if (ticking) return;
      ticking = true;
      rafId = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafId);
    };
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
              href="/admin/settings"
              className="block rounded-lg px-3 py-2 text-secondary hover:text-primary hover:bg-bg-secondary/60 transition-colors"
            >
                Admin setting (admin)
            </Link>
          </li>
        )}
      </ul>
    </nav>
  );
}
