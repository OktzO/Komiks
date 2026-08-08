// LB account lifecycle: verify provider token, encrypt+store, re-test.
// Tokens are AES-GCM encrypted at rest; only token_last4 is returned to clients.
import type { D1Database } from '@cloudflare/workers-types';
import type { LbProvider, LbAccountSafe } from '@manga-platform/shared/types';
import { drainResponse } from '@manga-platform/shared/http';
import type { Db } from '@manga-platform/db';
import { encryptToken, decryptToken } from './crypto.ts';

export interface LbEnv {
  LB_ENCRYPTION_KEY: string;
  DB: D1Database;
}

export interface VerifyResult {
  ok: boolean;
  err?: string;
}

// CF: GET /user/tokens/verify with Authorization: Bearer <token>.
const verifyCloudflare = async (token: string): Promise<VerifyResult> => {
  const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) { await drainResponse(res); return { ok: false, err: `cloudflare verify HTTP ${res.status}` }; }
  const body = (await res.json()) as { success?: boolean; result?: { status?: string } };
  if (body.success && body.result?.status === 'active') return { ok: true };
  return { ok: false, err: `cloudflare token not active: ${JSON.stringify(body)}` };
};

// Vercel: GET /v2/user with Authorization: Bearer <token>.
const verifyVercel = async (token: string): Promise<VerifyResult> => {
  const res = await fetch('https://api.vercel.com/v2/user', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) { await drainResponse(res); return { ok: false, err: `vercel verify HTTP ${res.status}` }; }
  const body = (await res.json()) as { user?: unknown };
  if (body.user) return { ok: true };
  return { ok: false, err: 'vercel user lookup empty' };
};

export const verifyAccountToken = async (
  provider: LbProvider,
  token: string
): Promise<VerifyResult> =>
  provider === 'cloudflare' ? verifyCloudflare(token) : verifyVercel(token);

export interface CreateAccountInput {
  label: string;
  provider: LbProvider;
  account_ref?: string | null;
  rawToken: string;
  token_last4: string;
  created_by?: number | null;
}

export interface CreateAccountResult {
  id: string;
  status: 'verified' | 'failed';
  err?: string;
}

export const createAccount = async (
  env: LbEnv,
  db: Db,
  input: CreateAccountInput
): Promise<CreateAccountResult> => {
  const verify = await verifyAccountToken(input.provider, input.rawToken);
  const status = verify.ok ? 'verified' : 'failed';
  const encrypted = await encryptToken(env.LB_ENCRYPTION_KEY, input.rawToken);
  // D1 BLOB binding accepts ArrayBuffer-backed view; store a copy of the buffer.
  const blob = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) as ArrayBuffer;
  const stored = await db.addAccount({
    label: input.label,
    provider: input.provider,
    account_ref: input.account_ref ?? null,
    encrypted_token: blob,
    token_last4: input.token_last4,
    status,
    created_by: input.created_by ?? null
  });
  if (!stored) throw new Error('lb/accounts: addAccount returned no id');
  await db.addAuditLog({
    accountId: stored.id,
    action: `account.create.${status}`,
    userId: input.created_by ?? null
  });
  return { id: stored.id, status, err: verify.err };
};

// listAccounts already omits encrypted_token (Task 2 report §63); pass-through.
export const listAccountsSafe = async (db: Db): Promise<LbAccountSafe[]> =>
  db.listAccounts();

// Re-verify a stored account by decrypting its token and hitting the provider.
// Reads the BLOB via a direct D1 query (Db.listAccounts intentionally omits it).
export const testAccount = async (
  env: LbEnv,
  accountId: string
): Promise<VerifyResult & { status?: string }> => {
  const row = await env.DB.prepare('SELECT encrypted_token, provider FROM lb_accounts WHERE id = ?1 LIMIT 1')
    .bind(accountId)
    .first<{ encrypted_token: ArrayBuffer; provider: LbProvider }>();
  if (!row) return { ok: false, err: 'account not found' };
  const bytes = new Uint8Array(row.encrypted_token);
  let token: string;
  try {
    token = await decryptToken(env.LB_ENCRYPTION_KEY, bytes);
  } catch (e) {
    return { ok: false, err: `decrypt failed: ${(e as Error).message}` };
  }
  const verify = await verifyAccountToken(row.provider, token);
  return { ...verify, status: verify.ok ? 'verified' : 'failed' };
};
