'use client';

import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app-error]', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
      <h1 className="text-2xl font-bold">Terjadi kesalahan</h1>
      <p className="text-secondary">{error.message || 'Silakan coba lagi.'}</p>
      <button onClick={reset} className="px-4 py-2 rounded bg-white/10 hover:bg-white/20">
        Coba lagi
      </button>
    </div>
  );
}
