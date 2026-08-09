'use client';
import { useState } from 'react';
import type { AuthUser } from '@/lib/api';
import { patchMe } from '@/lib/api';
import { Avatar } from '@/components/Avatar';

interface Props {
  user: AuthUser;
  onUpdate: (u: AuthUser) => void;
}

export function ProfileSection({ user, onUpdate }: Props) {
  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [bio, setBio] = useState(user.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await patchMe({
        display_name: displayName || null,
        bio: bio || null,
      });
      onUpdate(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="profile" className="mb-8 scroll-mt-20">
      <h2 className="text-lg font-semibold text-primary mb-1">Profil Publik</h2>
      <p className="text-sm text-muted mb-4">Foto dan nama yang tampil di situs ini.</p>
      <div className="flex items-start gap-5">
        <Avatar user={user} size="lg" />
        <div className="space-y-4 flex-1">
          <div>
            <label className="block text-sm text-secondary mb-1">Nama Tampil</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 50))}
              placeholder="Nama tampilan (kosongkan = pakai nama Google)"
              maxLength={50}
              className="w-full bg-base border border-border-default rounded-lg px-3 py-2 text-primary placeholder:text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
            />
            <p className="text-xs text-muted mt-1">{displayName.length}/50 karakter</p>
          </div>
          <div>
            <label className="block text-sm text-secondary mb-1">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value.slice(0, 280))}
              placeholder="Cerita singkat tentangmu..."
              maxLength={280}
              rows={3}
              className="w-full bg-base border border-border-default rounded-lg px-3 py-2 text-primary placeholder:text-muted resize-y focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
            />
            <p className="text-xs text-muted mt-1">{bio.length}/280 karakter</p>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-error mt-2">{error}</p>}
      <button
        onClick={save}
        disabled={saving}
        className="mt-4 px-4 py-2 text-sm font-medium text-primary bg-accent/10 border border-accent/30 rounded-lg hover:bg-accent/20 transition-colors disabled:opacity-50"
      >
        {saving ? 'Menyimpan...' : 'Simpan Profil'}
      </button>
    </section>
  );
}
