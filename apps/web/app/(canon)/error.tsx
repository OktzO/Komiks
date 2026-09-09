'use client';

import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[canon-error]', error);
  }, [error]);

  return (
    <main className="max-w-2xl mx-auto px-4 py-16 text-center">
      <div className="border border-border-default rounded-xl p-8 bg-card">
        <h1 className="text-xl font-semibold text-primary">Gagal memuat halaman</h1>
        <p className="text-secondary text-sm mt-2">{error.message || 'Silakan coba lagi.'}</p>
        <button
          onClick={() => reset()}
          className="mt-4 inline-flex h-10 items-center rounded-lg border border-white bg-white px-5 text-sm font-semibold text-black hover:opacity-90 transition-opacity"
        >
          Coba lagi
        </button>
      </div>
    </main>
  );
}
