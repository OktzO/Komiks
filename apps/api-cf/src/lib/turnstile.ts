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
    if (!res.ok) {
      console.warn('[turnstile] siteverify HTTP', res.status);
      return false;
    }
    const j = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    // DIAGNOSTIK SEMENTARA: simpan kode error terakhir supaya routes/auth.ts bisa
    // membalikannya ke klien (hanya lewat /auth/google, bukan endpoint publik).
    try {
      const mod = await import('../routes/auth');
      mod.__turnstileDiag?.set('last', { codes: j['error-codes'] ?? [], ip: ip ?? '' });
    } catch {}
    if (j.success !== true) {
      // Tanpa ini, "captcha verification failed" tidak bisa dibedakan dari token
      // kedaluwarsa, token yang sudah dipakai, secret yang salah pairing, atau
      // domain yang tidak terdaftar. Semuanya menolak dengan pesan yang sama.
      // Kode error dari Turnstile sendiri yang memberitahu mana.
      console.warn('[turnstile] rejected:', (j['error-codes'] ?? []).join(',') || 'tanpa kode');
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[turnstile] siteverify gagal:', e instanceof Error ? e.message : String(e));
    return false;
  }
}