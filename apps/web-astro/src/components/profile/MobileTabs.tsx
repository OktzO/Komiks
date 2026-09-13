'use client';
import { useEffect, useState } from 'react';

const sections = [
  { id: 'profile', label: 'Profil' },
  { id: 'account', label: 'Akun' },
  { id: 'preferences', label: 'Preferensi' },
  { id: 'privacy', label: 'Privasi' },
];

export function MobileTabs() {
  const [active, setActive] = useState(sections[0].id);

  useEffect(() => {
    let ticking = false;
    let rafId = 0;
    const update = () => {
      ticking = false;
      let current = sections[0].id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= 120) current = s.id;
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
  }, []);

  return (
    <nav className="sticky top-14 z-40 -mx-4 mb-4 overflow-x-auto bg-card/60 backdrop-blur border-b border-border-default md:hidden">
      <ul className="flex items-center gap-x-1 text-sm font-medium">
        {sections.map((s) => {
          const isActive = active === s.id;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                onClick={() => setActive(s.id)}
                className={`block whitespace-nowrap border-b-2 px-4 py-2.5 transition-colors ${
                  isActive
                    ? 'border-accent text-accent'
                    : 'border-transparent text-secondary hover:text-primary'
                }`}
              >
                {s.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
