'use client';
import { useState, useEffect } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmText?: string; // user must type this value exactly to enable confirm
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  loading?: boolean;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Hapus',
  confirmText = title,
  onClose,
  onConfirm,
  loading = false,
}: ConfirmModalProps) {
  const [input, setInput] = useState('');

  useEffect(() => {
    if (!open) setInput('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ready = input === confirmText;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border-default p-6 text-center">
        <h2 className="text-lg font-semibold text-primary">{title}</h2>
        <p className="text-sm text-secondary mt-2">{description}</p>
        <p className="mt-4 text-left text-xs text-muted">
          Ketik <span className="text-primary font-medium">{confirmText}</span> untuk mengonfirmasi.
        </p>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="mt-2 w-full rounded-lg bg-base border border-border-default px-3 py-2 text-primary placeholder:text-muted focus:outline-none focus:border-error focus:ring-1 focus:ring-error/30"
          placeholder={confirmText}
          autoFocus
        />
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!ready || loading) return;
              await onConfirm();
              onClose();
            }}
            disabled={!ready || loading}
            className="flex-1 px-4 py-2 text-sm font-medium text-error border border-error/30 rounded-lg hover:bg-error/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Memproses...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

