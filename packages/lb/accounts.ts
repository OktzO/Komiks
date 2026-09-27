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

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_ACCOUNT_PAGE_SIZE = 50;
const CF_ACCOUNT_MAX_PAGES = 10;
const UNVERIFIED_CLOUDFLARE_LABEL = 'Cloudflare (unverified)';

export interface CloudflareAccount {
  id: string;
  name: string;
  type: string | null;
}

export class AccountSelectionRequiredError extends Error {
  readonly code = 'account_selection_required';
  constructor(readonly accounts: CloudflareAccount[]) {
    super('account selection required');
    this.name = 'AccountSelectionRequiredError';
  }
}

export class AccountNotAccessibleError extends Error {
  readonly code = 'account_not_accessible';
  constructor(readonly requestedId: string) {
    super('account not accessible');
    this.name = 'AccountNotAccessibleError';
  }
}

export class NoCloudflareAccountsError extends Error {
  readonly code = 'no_cloudflare_accounts';
  constructor() {
    super('no accessible cloudflare accounts');
    this.name = 'NoCloudflareAccountsError';
  }
}

export type AccountDiscoveryCode =
  | 'cloudflare_token_rejected'
  | 'cloudflare_account_read_forbidden'
  | 'cloudflare_unavailable'
  | 'cloudflare_invalid_response';

export class AccountDiscoveryError extends Error {
  constructor(readonly code: AccountDiscoveryCode, detail: string) {
    super(`${code} (${detail})`);
    this.name = 'AccountDiscoveryError';
  }
}

export interface DiscoveryOptions {
  tokenVerified?: boolean;
}

// CF: GET /user/tokens/verify with Authorization: Bearer <token>.
const verifyCloudflare = async (token: string): Promise<VerifyResult> => {
  const res = await fetch(`${CF_API}/user/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) { await drainResponse(res); return { ok: false, err: `cloudflare verify HTTP ${res.status}` }; }
  const body = (await res.json()) as { success?: boolean; result?: { status?: string } };
  if (body.success && body.result?.status === 'active') return { ok: true };
  return { ok: false, err: 'cloudflare token not active' };
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

const collectAccounts = (result: unknown, out: CloudflareAccount[]): number => {
  if (!Array.isArray(result)) throw new AccountDiscoveryError('cloudflare_invalid_response', 'result is not an array');
  for (const row of result) {
    if (!row || typeof row !== 'object') continue;
    const { id, name, type } = row as { id?: unknown; name?: unknown; type?: unknown };
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) continue;
    out.push({ id, name, type: typeof type === 'string' ? type : null });
  }
  return result.length;
};

const listAccountsPage = async (
  token: string,
  page: number,
  opts: DiscoveryOptions
): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetch(`${CF_API}/accounts?per_page=${CF_ACCOUNT_PAGE_SIZE}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new AccountDiscoveryError('cloudflare_unavailable', 'transport failure');
  }
  if (!res.ok) {
    await drainResponse(res);
    if (res.status === 401) throw new AccountDiscoveryError('cloudflare_token_rejected', 'HTTP 401');
    if (res.status === 403) {
      throw new AccountDiscoveryError(
        opts.tokenVerified ? 'cloudflare_account_read_forbidden' : 'cloudflare_token_rejected',
        'HTTP 403'
      );
    }
    throw new AccountDiscoveryError('cloudflare_unavailable', `HTTP ${res.status}`);
  }
  let body: { success?: boolean; result?: unknown };
  try {
    body = (await res.json()) as { success?: boolean; result?: unknown };
  } catch {
    throw new AccountDiscoveryError('cloudflare_invalid_response', 'body is not json');
  }
  if (!body || body.success !== true) throw new AccountDiscoveryError('cloudflare_token_rejected', 'listing rejected');
  return body.result;
};

export const discoverCloudflareAccounts = async (
  token: string,
  opts: DiscoveryOptions = {}
): Promise<CloudflareAccount[]> => {
  const out: CloudflareAccount[] = [];
  for (let page = 1; page <= CF_ACCOUNT_MAX_PAGES; page++) {
    const result = await listAccountsPage(token, page, opts);
    if (collectAccounts(result, out) < CF_ACCOUNT_PAGE_SIZE) break;
  }
  return out;
};

export const resolveCloudflareAccount = async (
  token: string,
  requestedId?: string | null,
  opts: DiscoveryOptions = {}
): Promise<CloudflareAccount> => {
  const accounts = await discoverCloudflareAccounts(token, opts);
  if (accounts.length === 0) throw new NoCloudflareAccountsError();
  if (requestedId) {
    const match = accounts.find((a) => a.id === requestedId);
    if (!match) throw new AccountNotAccessibleError(requestedId);
    return match;
  }
  if (accounts.length === 1) return accounts[0];
  throw new AccountSelectionRequiredError(accounts);
};

export interface CreateAccountInput {
  label?: string;
  provider: LbProvider;
  accountId?: string | null;
  rawToken: string;
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
  const selected = input.provider === 'cloudflare' && verify.ok
    ? await resolveCloudflareAccount(input.rawToken, input.accountId, { tokenVerified: true })
    : null;
  const status = verify.ok ? 'verified' : 'failed';
  const accountRef = selected
    ? selected.id
    : input.provider === 'vercel'
      ? input.accountId ?? null
      : null;
  const encrypted = await encryptToken(env.LB_ENCRYPTION_KEY, input.rawToken);
  // D1 BLOB binding accepts ArrayBuffer-backed view; store a copy of the buffer.
  const blob = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) as ArrayBuffer;
  const stored = await db.addAccount({
    label: input.label?.trim() || selected?.name || (input.provider === 'cloudflare' ? UNVERIFIED_CLOUDFLARE_LABEL : input.provider),
    provider: input.provider,
    account_ref: accountRef,
    encrypted_token: blob,
    token_last4: input.rawToken.slice(-4),
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

export interface TestAccountResult {
  ok: boolean;
  status: 'verified' | 'failed' | 'unavailable';
  err?: string;
}

export const testAccount = async (
  env: LbEnv,
  db: Db,
  accountId: string
): Promise<TestAccountResult> => {
  const row = await env.DB.prepare('SELECT encrypted_token, provider FROM lb_accounts WHERE id = ?1 LIMIT 1')
    .bind(accountId)
    .first<{ encrypted_token: ArrayBuffer | null; provider: LbProvider }>();
  if (!row) return { ok: false, status: 'unavailable', err: 'account not found' };

  const now = Date.now();
  const persist = (status: 'verified' | 'unverified' | 'failed') =>
    db.updateAccountCredentialStatus(accountId, status, now);
  const unavailable = async (): Promise<TestAccountResult> => {
    await persist('unverified');
    return { ok: false, status: 'unavailable', err: 'credential unavailable' };
  };

  if (!row.encrypted_token || new Uint8Array(row.encrypted_token).byteLength === 0) return unavailable();

  let token: string;
  try {
    token = await decryptToken(env.LB_ENCRYPTION_KEY, new Uint8Array(row.encrypted_token));
  } catch {
    return unavailable();
  }

  let verify: VerifyResult;
  try {
    verify = await verifyAccountToken(row.provider, token);
  } catch {
    return unavailable();
  }

  if (verify.ok) {
    await persist('verified');
    return { ok: true, status: 'verified' };
  }
  await persist('failed');
  return { ok: false, status: 'failed', err: verify.err };
};
