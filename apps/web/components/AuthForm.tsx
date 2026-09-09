'use client';

import { useEffect, useRef, useState } from 'react';
import { getAuthApiUrl, setAuthOrigin } from '@/lib/api';

// Cloudflare Turnstile widget — explicit render, biar kita kontrol reset.
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
    onTurnstileLoad?: () => void;
  }
}

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let alive = true;

    const render = () => {
      if (!alive || !holder.current || widgetId.current !== null) return;
      widgetId.current = window.turnstile!.render(holder.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'dark',
        language: 'id',
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      }) as string;
    };

    if (window.turnstile) {
      render();
    } else {
      const prev = window.onTurnstileLoad;
      window.onTurnstileLoad = () => { prev?.(); render(); };
      if (!document.querySelector(`script[src^="${TURNSTILE_SCRIPT}"]`)) {
        const s = document.createElement('script');
        s.src = TURNSTILE_SCRIPT;
        s.async = true;
        s.defer = true;
        document.head.appendChild(s);
      }
    }

    return () => {
      alive = false;
      if (widgetId.current !== null) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [onToken]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={holder} className="flex justify-center" aria-label="Verifikasi keamanan" />;
}

export function AuthForm() {
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getAuthApiUrl().then((url) => {
      if (!alive) return;
      setApiUrl(url);
      setAuthOrigin(url);
    });
    return () => { alive = false; };
  }, []);

  // Build Google OAuth URL dynamically — pass origin + redirect for state cookie.
  // Turnstile token di-verify server-side sebelum redirect ke Google.
  const googleUrl = apiUrl
    ? `${apiUrl}/api/auth/google?origin=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}&redirect=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}${token ? `&turnstile_token=${encodeURIComponent(token)}` : ''}`
    : '#';

  const gateLocked = TURNSTILE_SITE_KEY !== '' && !token;

  return (
    <main className="relative min-h-[calc(100vh-6rem)] flex items-center justify-center px-4 py-10">
      <div className="page-decoration" aria-hidden="true" />

      <div className="relative z-10 w-full max-w-sm anim-slide-up">
        <div className="panel p-7 sm:p-8 shadow-[0_24px_64px_-32px_oklch(0%_0_0/0.7)]">
          {/* Mark */}
          <div className="flex justify-center mb-6">
            <div className="h-12 w-12 rounded-2xl bg-accent flex items-center justify-center shadow-[0_8px_24px_-8px_var(--accent)]">
              <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6" aria-hidden="true">
                <path d="M4 19V6a1 1 0 0 1 1.4-.92l6.6 2.64 6.6-2.64A1 1 0 0 1 20 6v13a1 1 0 0 1-1.36.93L12 17.28l-6.64 2.65A1 1 0 0 1 4 19Z" fill="var(--accent-ink)" />
              </svg>
            </div>
          </div>

          <header className="text-center mb-7">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-primary">Masuk ke Oktz.</h1>
            <p className="mt-2 text-sm text-secondary leading-relaxed">
              Sinkron bookmark &amp; riwayat baca di semua perangkat.
            </p>
          </header>

          {/* Turnstile */}
          {TURNSTILE_SITE_KEY ? (
            <div className="mb-4">
              <Turnstile onToken={setToken} />
              {!token && (
                <p className="mt-2 text-center text-xs text-muted">
                  Selesaikan verifikasi untuk lanjut.
                </p>
              )}
            </div>
          ) : (
            // ponytail: tanpa NEXT_PUBLIC_TURNSTILE_SITE_KEY → widget disembunyikan;
            // set secret + sitekey env untuk aktifkan (server skip verify bila secret kosong).
            <noscript />
          )}

          <a
            href={googleUrl}
            onClick={(e) => { if (!apiUrl || gateLocked) e.preventDefault(); }}
            aria-disabled={!apiUrl || gateLocked}
            className={`btn w-full !min-h-[48px] border border-border-default bg-primary/[0.04] text-primary text-[15px] font-semibold hover:bg-elevated hover:border-border-strong ${
              !apiUrl || gateLocked ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M22 12.1c0-.7-.1-1.3-.2-2H12v3.8h5.7c-.2 1.3-1 2.4-2.1 3.1v2.6h3.4c2-1.8 3-4.5 3-7.5z" fill="#4285F4"/>
              <path d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7C4.5 19.6 8 22 12 22z" fill="#34A853"/>
              <path d="M6.2 13.6c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V6.9H2.7C2 8.4 1.6 10.1 1.6 11.9s.4 3.5 1.1 5l3.5-2.7z" fill="#FBBC05"/>
              <path d="M12 5.4c1.5 0 2.9.5 4 1.5l3-3C16.9 2.3 14.7 1.3 12 1.3 8 1.3 4.5 3.7 2.7 7l3.5 2.7C7 7.2 9.3 5.4 12 5.4z" fill="#EA4335"/>
            </svg>
            Lanjut dengan Google
          </a>

          <p className="mt-5 text-center text-xs text-muted leading-relaxed">
            Dengan masuk, kamu setuju dengan{' '}
            <a href="/tos" className="underline underline-offset-2 hover:text-secondary">ketentuan</a>{' '}
            penggunaan situs.
          </p>
        </div>

        <p className="mt-4 text-center text-xs text-muted">
          Gratis · tanpa iklan pop-up · tanpa password
        </p>
      </div>
    </main>
  );
}
