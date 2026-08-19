'use client';
import { useState } from 'react';
import type { AuthUser, UserPreferences } from '@/lib/api';
import { patchMe } from '@/lib/api';
import { SOURCE_ORDER, type SourceKey } from '@/components/SourceBadge';

interface Props {
  user: AuthUser;
  onUpdate: (u: AuthUser) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  komiku: 'Komiku (default)',
  bacakomik: 'BacaKomik',
  thrive: 'Thrive',
  manhwaindo: 'ManhwaIndo',
};

export function PreferencesSection({ user, onUpdate }: Props) {
  const prefs = user.preferences ?? {};
  const [theme, setTheme] = useState<UserPreferences['theme']>(prefs.theme ?? 'dark');
  const [language, setLanguage] = useState<UserPreferences['language']>(prefs.language ?? 'id');
  const [readerMode, setReaderMode] = useState<UserPreferences['reader_mode']>(prefs.reader_mode ?? 'scroll');
  const [defaultSource, setDefaultSource] = useState<UserPreferences['default_source']>(prefs.default_source ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await patchMe({
        preferences: { theme, language, reader_mode: readerMode, default_source: defaultSource },
      });
      onUpdate(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const Segmented = ({
    options,
    value,
    onChange,
  }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <div className="inline-flex items-center rounded-lg bg-base border border-border-default p-0.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              active
                ? 'bg-accent text-base'
                : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <section id="preferences" className="mb-8 scroll-mt-20">
      <h2 className="text-lg font-semibold text-primary mb-1">Preferensi</h2>
      <p className="text-sm text-muted mb-4">Atur tampilan, bahasa, dan mode baca default.</p>

      <div className="space-y-5 max-w-md">
        <div>
          <label className="block text-sm text-secondary mb-2">Tema</label>
          <Segmented
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'Sistem' },
            ]}
            value={theme}
            onChange={(v) => setTheme(v as UserPreferences['theme'])}
          />
        </div>

        <div>
          <label className="block text-sm text-secondary mb-2">Bahasa UI</label>
          <Segmented
            options={[
              { value: 'id', label: 'Bahasa Indonesia' },
              { value: 'en', label: 'English' },
            ]}
            value={language}
            onChange={(v) => setLanguage(v as UserPreferences['language'])}
          />
        </div>

        <div>
          <label className="block text-sm text-secondary mb-2">Mode Baca Default</label>
          <Segmented
            options={[
              { value: 'scroll', label: 'Scroll' },
              { value: 'page', label: 'Page' },
            ]}
            value={readerMode}
            onChange={(v) => setReaderMode(v as UserPreferences['reader_mode'])}
          />
        </div>

        <div>
          <label className="block text-sm text-secondary mb-2">Sumber Default</label>
          <select
            value={defaultSource ?? 'auto'}
            onChange={(e) => setDefaultSource(e.target.value === 'auto' ? null : (e.target.value as SourceKey))}
            className="w-full bg-base border border-border-default rounded-lg px-3 py-2 text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
          >
            <option value="auto">Auto (pilih saat buka)</option>
            {SOURCE_ORDER.map((s) => (
              <option key={s} value={s}>{SOURCE_LABELS[s] ?? s}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-xs text-error mt-2">{error}</p>}
      <button
        onClick={save}
        disabled={saving}
        className="mt-4 px-4 py-2 text-sm font-medium text-primary bg-accent/10 border border-accent/30 rounded-lg hover:bg-accent/20 transition-colors disabled:opacity-50"
      >
        {saving ? 'Menyimpan...' : 'Simpan Preferensi'}
      </button>
    </section>
  );
}
