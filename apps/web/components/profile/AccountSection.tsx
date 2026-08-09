'use client';
import { useState } from 'react';
import type { AuthUser } from '@/lib/api';
import { deleteMe } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';
import { useRouter } from 'next/navigation';

interface Props {
  user: AuthUser;
}

export function AccountSection({ user }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteMe('DELETE');
      router.push('/login');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <section id="account" className="mb-8 scroll-mt-20">
        <h2 className="text-lg font-semibold text-primary mb-1">Akun</h2>
        <p className="text-sm text-muted mb-4">Informasi login dan akun terkait.</p>
        <div className="space-y-3 max-w-md">
          <div>
            <label className="block text-xs text-secondary mb-1">Email (Google)</label>
            <input
              type="email"
              value={user.email}
              readOnly
              className="w-full bg-base border border-border-default rounded-lg px-3 py-2 text-primary read-only:opacity-70"
            />
          </div>
          <div>
            <label className="block text-xs text-secondary mb-1">Nama Google</label>
            <input
              type="text"
              value={user.name ?? ''}
              readOnly
              placeholder="(tidak diset)"
              className="w-full bg-base border border-border-default rounded-lg px-3 py-2 text-primary read-only:opacity-70 placeholder:text-muted"
            />
          </div>
        </div>

        <div className="mt-6 border-t border-border-default pt-5">
          <h3 className="text-sm font-medium text-error mb-1">Hapus Akun</h3>
          <p className="text-sm text-secondary mb-3">
            Hapus akun secara permanen. Tindakan ini tidak bisa dibatalkan — semua bookmark dan riwayat akan dihapus.
          </p>
          {error && <p className="text-xs text-error mb-2">{error}</p>}
          <button
            onClick={() => setConfirmOpen(true)}
            className="px-4 py-2 text-sm font-medium text-error border border-error/30 rounded-lg hover:bg-error/10 transition-colors"
          >
            Hapus Akun
          </button>
        </div>
      </section>

      <ConfirmModal
        open={confirmOpen}
        title="Hapus Akun"
        description="Ketik DELETE untuk mengonfirmasi penghapusan permanen akun ini."
        confirmLabel={deleting ? 'Menghapus...' : 'Hapus Akun'}
        confirmText="DELETE"
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
        loading={deleting}
      />
    </>
  );
}
