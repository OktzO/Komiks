'use client';
import { useState } from 'react';
import { clearBookmarks, clearHistory } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';

export function PrivacySection() {
  const [clearing, setClearing] = useState<'bookmarks' | 'history' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<{
    type: 'bookmarks' | 'history';
    text: string;
  } | null>(null);

  const handleClear = async (target: 'bookmarks' | 'history') => {
    setClearing(target);
    try {
      if (target === 'bookmarks') await clearBookmarks();
      else await clearHistory();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setClearing(null);
      setConfirmOpen(null);
    }
  };

  return (
    <>
      <section id="privacy" className="mb-8 scroll-mt-20">
        <h2 className="text-lg font-semibold text-primary mb-1">Privasi & Data</h2>
        <p className="text-sm text-muted mb-4">Kontrol data pribadi dan aktivitas membaca.</p>

        <div className="space-y-4 max-w-md">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-secondary">Bookmark visibility</label>
              <p className="text-xs text-muted">Fitur akan datang — bookmark saat ini selalu pribadi.</p>
            </div>
            <span className="text-xs text-muted">(private)</span>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-secondary">History visibility</label>
              <p className="text-xs text-muted">Fitur akan datang — history saat ini selalu pribati.</p>
            </div>
            <span className="text-xs text-muted">(private)</span>
          </div>

          <div className="border-t border-border-default pt-4 space-y-2">
            <p className="text-sm text-secondary">Hapus semua data</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmOpen({ type: 'bookmarks', text: 'CLEAR' })}
                className="px-4 py-2 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary/60 transition-colors"
              >
                Hapus Semua Bookmark
              </button>
              <button
                onClick={() => setConfirmOpen({ type: 'history', text: 'CLEAR' })}
                className="px-4 py-2 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary/60 transition-colors"
              >
                Hapus Semua History
              </button>
            </div>
          </div>
        </div>
      </section>

      {confirmOpen && (
        <ConfirmModal
          open={!!confirmOpen}
          title={`Hapus ${confirmOpen.type === 'bookmarks' ? 'Bookmark' : 'History'}`}
          description={`Ketik ${confirmOpen.text} untuk mengonfirmasi penghapusan permanen semua ${confirmOpen.type === 'bookmarks' ? 'bookmark' : 'riwayat baca'}.`}
          confirmLabel={clearing ? 'Memproses...' : 'Hapus'}
          confirmText={confirmOpen.text}
          onClose={() => setConfirmOpen(null)}
          onConfirm={() => handleClear(confirmOpen.type)}
          loading={clearing === confirmOpen.type}
        />
      )}
    </>
  );
}
