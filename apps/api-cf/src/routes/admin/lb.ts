import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminSession, requireAuth } from '../../lib/auth';
import {
  createAccount,
  listAccountsSafe,
  testAccount,
  resolveCloudflareAccount,
} from '@manga-platform/lb/accounts';
import type { TestAccountResult } from '@manga-platform/lb/accounts';
import { provisionAccount, checkProvisionStatus } from '@manga-platform/lb/provision';

export const router = new Hono<{ Bindings: Env }>();

const LABEL_MAX = 100;
const PROVIDER_REF_MAX = 100;
const WORKER_NAME_MAX = 63;
const TOKEN_MAX = 512;
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): Validated<never> => ({ ok: false, error });

export interface AccountBody {
  label: string;
  provider: 'cloudflare' | 'vercel';
  accountId: string | null;
  rawToken: string;
}

export interface ProvisionBody {
  label: string;
  cfApiToken: string;
  workerName: string;
  accountId: string | null;
}

const asRecord = (body: unknown): Record<string, unknown> | null =>
  body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;

const readLabel = (raw: unknown): Validated<string> => {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return fail('invalid label');
  const label = raw.trim();
  return label.length > LABEL_MAX ? fail('label too long') : { ok: true, value: label };
};

const readToken = (raw: unknown): Validated<string> => {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('token required');
  const token = raw.trim();
  return token.length > TOKEN_MAX ? fail('token too long') : { ok: true, value: token };
};

const readAccountId = (raw: unknown, provider: string): Validated<string | null> => {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || raw.trim() === '') return fail('invalid accountId');
  const accountId = raw.trim();
  if (provider === 'cloudflare') {
    return CLOUDFLARE_ACCOUNT_ID.test(accountId) ? { ok: true, value: accountId } : fail('invalid accountId');
  }
  return accountId.length > PROVIDER_REF_MAX ? fail('invalid accountId') : { ok: true, value: accountId };
};

export const validateAccountBody = (body: unknown): Validated<AccountBody> => {
  const rec = asRecord(body);
  if (!rec) return fail('invalid body');
  const provider = rec.provider;
  if (provider !== 'cloudflare' && provider !== 'vercel') return fail('invalid provider');
  const label = readLabel(rec.label);
  if (!label.ok) return label;
  const rawToken = readToken(rec.rawToken);
  if (!rawToken.ok) return rawToken;
  const accountId = readAccountId(rec.accountId, provider);
  if (!accountId.ok) return accountId;
  return { ok: true, value: { label: label.value, provider, accountId: accountId.value, rawToken: rawToken.value } };
};

export const validateProvisionBody = (body: unknown): Validated<ProvisionBody> => {
  const rec = asRecord(body);
  if (!rec) return fail('invalid body');
  const label = readLabel(rec.label);
  if (!label.ok) return label;
  const cfApiToken = readToken(rec.cfApiToken);
  if (!cfApiToken.ok) return cfApiToken;
  if (typeof rec.workerName !== 'string' || rec.workerName.trim() === '') return fail('worker name required');
  const workerName = rec.workerName.trim();
  if (workerName.length > WORKER_NAME_MAX || !WORKER_NAME.test(workerName)) return fail('invalid worker name');
  const accountId = readAccountId(rec.accountId, 'cloudflare');
  if (!accountId.ok) return accountId;
  return { ok: true, value: { label: label.value, cfApiToken: cfApiToken.value, workerName, accountId: accountId.value } };
};

export interface ErrorResponse {
  status: number;
  body: { error: string; accounts?: { id: string; name: string; type: string | null }[] };
}

export interface AccountTestBody {
  ok: boolean;
  status: 'verified' | 'failed' | 'unavailable';
  err: string | null;
}

const errorCode = (e: unknown): string =>
  e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : '';

const safeAccounts = (e: unknown): { id: string; name: string; type: string | null }[] => {
  const list = (e as { accounts?: unknown }).accounts;
  if (!Array.isArray(list)) return [];
  return list.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const { id, name, type } = row as { id?: unknown; name?: unknown; type?: unknown };
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    return [{ id, name, type: typeof type === 'string' ? type : null }];
  });
};

export const accountMutationErrorResponse = (e: unknown): ErrorResponse => {
  switch (errorCode(e)) {
    case 'account_selection_required':
      return { status: 409, body: { error: 'account selection required', accounts: safeAccounts(e) } };
    case 'account_not_accessible':
      return { status: 409, body: { error: 'account not accessible' } };
    case 'no_cloudflare_accounts':
      return { status: 422, body: { error: 'no accessible cloudflare accounts' } };
    case 'cloudflare_token_rejected':
    case 'cloudflare_account_read_forbidden':
      return { status: 422, body: { error: errorCode(e) } };
    case 'cloudflare_unavailable':
    case 'cloudflare_invalid_response':
      return { status: 502, body: { error: errorCode(e) } };
    default:
      return { status: 500, body: { error: 'account create failed' } };
  }
};

export const provisionRequestErrorResponse = (e: unknown): ErrorResponse => {
  const mapped = accountMutationErrorResponse(e);
  if (mapped.status === 500) return { status: 500, body: { error: 'provision request rejected' } };
  return mapped;
};

export const accountTestResponse = (res: TestAccountResult): { status: number; body: AccountTestBody } => ({
  status: 200,
  body: { ok: res.ok, status: res.status, err: res.err ?? null },
});

export const accountTestErrorResponse = (): { status: number; body: { error: string } } => ({
  status: 500,
  body: { error: 'account test failed' },
});

router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

// LB admin mutations: require admin session role (same as monitoring endpoints).
// Step-up password removed — OAuth admin session is the sole auth path.
router.use('*', requireAdminSession);

// ---- settings -------------------------------------------------------------
router.get('/settings', async (c: Context) => {
  const settings = await getDb(c).getLbSettings();
  return json(c, settings ?? { mode: 'off' });
});

router.put('/settings', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    mode?: 'off' | 'on';
    implementation?: 'native_cf' | 'custom';
    steering_policy?: string;
    health_check_interval_sec?: number;
    health_check_timeout_ms?: number;
    failure_threshold?: number;
  } | null;
  if (!body) return json(c, { error: 'invalid body' }, 400);
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (
      k === 'mode' || k === 'implementation' || k === 'steering_policy' ||
      k === 'health_check_interval_sec' || k === 'health_check_timeout_ms' ||
      k === 'failure_threshold'
    ) {
      updates[k] = v;
    }
  }
  if (Object.keys(updates).length === 0) return json(c, { error: 'no updatable fields' }, 400);
  await getDb(c).setLbSettings(updates);
  await getDb(c).addAuditLog({ action: 'settings.update' });
  return json(c, { ok: true });
});

// ---- accounts -------------------------------------------------------------
router.get('/accounts', async (c) => json(c, await listAccountsSafe(getDb(c))));

router.post('/accounts', async (c) => {
  const parsed = validateAccountBody(await c.req.json().catch(() => null));
  if (!parsed.ok) return json(c, { error: parsed.error }, 400);
  const input = parsed.value;
  try {
    const res = await createAccount(c.env, getDb(c), {
      label: input.label,
      provider: input.provider,
      accountId: input.accountId,
      rawToken: input.rawToken,
      created_by: requireAuth(c)?.id ?? null,
    });
    return json(c, res, res.status === 'verified' ? 200 : 422);
  } catch (e) {
    console.error('[admin/lb] createAccount', String(e).slice(0, 200));
    const mapped = accountMutationErrorResponse(e);
    return json(c, mapped.body, mapped.status);
  }
});

router.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  await getDb(c).deleteAccount(id);
  await getDb(c).addAuditLog({ accountId: id, action: 'account.delete' });
  return json(c, { ok: true });
});

router.post('/accounts/:id/test', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await testAccount(c.env, getDb(c), id);
    await getDb(c).addAuditLog({ accountId: id, action: `account.test.${res.status}` });
    const mapped = accountTestResponse(res);
    return json(c, mapped.body, mapped.status);
  } catch (e) {
    console.error('[admin/lb] testAccount', String(e).slice(0, 200));
    const mapped = accountTestErrorResponse();
    return json(c, mapped.body, mapped.status);
  }
});

// ---- origins --------------------------------------------------------------
router.get('/origins', async (c) => json(c, await getDb(c).listOrigins()));

router.post('/origins', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    account_id?: string | null; origin_url: string;
    priority?: number; weight?: number; enabled?: number;
  } | null;
  if (!body || !body.origin_url) return json(c, { error: 'origin_url required' }, 400);
  const res = await getDb(c).createOrigin({
    account_id: body.account_id ?? null,
    origin_url: body.origin_url,
    priority: body.priority ?? 0,
    weight: body.weight ?? 1,
    enabled: body.enabled ?? 1
  });
  await getDb(c).addAuditLog({ originId: res?.id, action: 'origin.create' });
  return json(c, res, 201);
});

router.put('/origins/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json(c, { error: 'invalid body' }, 400);
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === 'priority' || k === 'weight' || k === 'enabled' || k === 'account_id' || k === 'origin_url') {
      updates[k] = v;
    }
  }
  if (Object.keys(updates).length === 0) return json(c, { error: 'no updatable fields' }, 400);
  await getDb(c).updateOrigin(id, updates);
  await getDb(c).addAuditLog({ originId: id, action: 'origin.update' });
  return json(c, { ok: true });
});

router.get('/status', async (c) => {
  const origins = await getDb(c).listOrigins();
  const settings = await getDb(c).getLbSettings();
  return json(c, {
    data: {
      mode: settings?.mode ?? 'off',
      implementation: settings?.implementation ?? 'custom',
      origins: origins.map((o) => ({
        id: o.id,
        origin_url: o.origin_url,
        enabled: o.enabled === 1,
        priority: o.priority,
        last_health_status: o.last_health_status ?? null,
        last_checked_at: o.last_checked_at ?? null
      }))
    }
  });
});

// Quota tracking: request count per origin per hari (approximation dari
// pengambilan daftar origin — lihat routes/origins.ts).
router.get('/usage', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await getDb(c).listLbUsage(today);
  return json(c, { data: rows, date_key: today });
});

router.post('/accounts/provision', async (c) => {
  const parsed = validateProvisionBody(await c.req.json().catch(() => null));
  if (!parsed.ok) return json(c, { error: parsed.error }, 400);
  const input = parsed.value;
  let account;
  try {
    account = await resolveCloudflareAccount(input.cfApiToken, input.accountId);
  } catch (e) {
    console.error('[admin/lb] provision account discovery', String(e).slice(0, 200));
    const mapped = provisionRequestErrorResponse(e);
    return json(c, mapped.body, mapped.status);
  }
  const jobId = crypto.randomUUID();
  c.executionCtx.waitUntil(
    provisionAccount(c.env, {
      label: input.label,
      cfApiToken: input.cfApiToken,
      workerName: input.workerName,
      jobId,
      accountId: account.id,
      resolvedAccount: account,
      createdBy: requireAuth(c)?.id ?? null,
    })
      .catch((e) => console.error('[provision]', e))
  );
  return json(c, { job_id: jobId, worker_name: input.workerName, provisioning: true });
});

router.get('/accounts/:id/provision-status', async (c) => {
  const id = c.req.param('id');
  const status = await checkProvisionStatus(c.env, id);
  if (!status) return json(c, { error: 'job not found' }, 404);
  const { status: jobStatus, step, error, workerUrl, accountId, databaseId, kvId } = status;
  return json(c, {
    data: {
      job_id: id,
      status: jobStatus,
      step,
      error: error ?? null,
      workerUrl: workerUrl ?? null,
      accountId: accountId ?? null,
      databaseId: databaseId ?? null,
      kvId: kvId ?? null
    }
  });
});
