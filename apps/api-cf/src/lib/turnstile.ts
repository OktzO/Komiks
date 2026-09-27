import type { Context } from './context';

// Verify Turnstile token server-side (siteverify). Without the secret key
// (local dev / belum diset) verification is bypassed — set
// TURNSTILE_SECRET_KEY in production. Returns true only when the token passes
// siteverify (or the secret is unset). Used by both the login gate
// (/api/auth/google) and the serviceGate SENSITIVE tier.
export async function verifyTurnstile(c: Context, token: string | undefined, ip?: string): Promise<boolean> {
  const secret = c.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}