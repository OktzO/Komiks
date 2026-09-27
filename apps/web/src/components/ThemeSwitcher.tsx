import { useEffect, useState } from 'react';

/** Pilih palet tampilan, bukan settingan: berlaku anonim + semua halaman. */
const THEMES = [
  { id: 'dark', label: 'Gelap', hint: 'Grafit + oranye molten' },
  { id: 'light', label: 'Terang', hint: 'Kertas hangat + baja' },
  { id: 'orange', label: 'Oren', hint: 'Baja terpanas + kuningan' },
] as const;

type ThemeId = (typeof THEMES)[number]['id'];

const read = (): ThemeId => {
  const t = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  return t === 'light' || t === 'orange' ? t : 'dark';
};

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>('dark');

  useEffect(() => setTheme(read()), []);

  const pick = (id: ThemeId) => {
    document.documentElement.dataset.theme = id;
    try {
      localStorage.setItem('oktz-theme', id);
    } catch (e) {
      /* private mode: tema tetap berlaku untuk sesi ini saja */
    }
    setTheme(id);
  };

  return (
    <div role="group" aria-label="Palet tema" className="mt-1 px-3 py-2">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
        Palet
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {THEMES.map(t => {
          const active = theme === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t.id)}
              aria-pressed={active}
              title={t.hint}
              className={[
                'group flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2 transition-colors',
                active
                  ? 'border-border-strong bg-bg-secondary'
                  : 'border-border-subtle hover:border-border-default hover:bg-bg-secondary',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="h-6 w-full rounded"
                style={{
                  background:
                    t.id === 'dark'
                      ? 'linear-gradient(135deg, #17191d 0%, #17191d 55%, #f26a1b 55%, #f26a1b 100%)'
                      : t.id === 'light'
                        ? 'linear-gradient(135deg, #f4f2ef 0%, #f4f2ef 55%, #c2410c 55%, #c2410c 100%)'
                        : 'linear-gradient(135deg, #2b1a10 0%, #2b1a10 55%, #ffd8a8 55%, #ffd8a8 100%)',
                }}
              />
              <span
                className={[
                  'text-[11px] leading-none',
                  active ? 'text-primary' : 'text-secondary group-hover:text-primary',
                ].join(' ')}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ThemeSwitcher;
