'use client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const googleUrl = `${API_URL}/api/auth/google`;
  return (
    <div className="max-w-sm mx-auto mt-12 space-y-4 text-center">
      <h1 className="text-xl font-semibold">
        {mode === 'login' ? 'Masuk' : 'Daftar'}
      </h1>
      <p className="text-sm text-secondary">
        {mode === 'login' ? 'Masuk dengan akun Google.' : 'Buat akun dengan Google.'}
      </p>
      <a
        href={googleUrl}
        className="flex items-center justify-center gap-2 w-full px-4 py-2.5 border border-border-default rounded text-sm text-primary hover:bg-elevated transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M22 12.1c0-.7-.1-1.3-.2-2H12v3.8h5.7c-.2 1.3-1 2.4-2.1 3.1v2.6h3.4c2-1.8 3-4.5 3-7.5z" fill="#4285F4"/>
          <path d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7C4.5 19.6 8 22 12 22z" fill="#34A853"/>
          <path d="M6.2 13.6c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V6.9H2.7C2 8.4 1.6 10.1 1.6 11.9s.4 3.5 1.1 5l3.5-2.7z" fill="#FBBC05"/>
          <path d="M12 5.4c1.5 0 2.9.5 4 1.5l3-3C16.9 2.3 14.7 1.3 12 1.3 8 1.3 4.5 3.7 2.7 7l3.5 2.7C7 7.2 9.3 5.4 12 5.4z" fill="#EA4335"/>
        </svg>
        {mode === 'login' ? 'Masuk dengan Google' : 'Daftar dengan Google'}
      </a>
    </div>
  );
}
