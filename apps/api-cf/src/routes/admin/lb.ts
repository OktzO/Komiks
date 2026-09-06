import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';
import { createAccount, listAccountsSafe, testAccount } from '@manga-platform/lb/accounts';
import { provisionAccount, checkProvisionStatus } from '@manga-platform/lb/provision';

export const router = new Hono<{ Bindings: Env }>();

// LB admin mutations: require admin session role (same as monitoring endpoints).
// Step-up password removed — OAuth admin session is the sole auth path.
router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

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
  const body = await c.req.json().catch(() => null) as {
    label: string; provider: 'cloudflare' | 'vercel';
    account_ref?: string | null; rawToken: string; token_last4: string;
  } | null;
  if (!body || !body.label || !body.provider || !body.rawToken || !body.token_last4) {
    return json(c, { error: 'missing fields' }, 400);
  }
  const res = await createAccount(c.env, getDb(c), body);
  return json(c, res, res.status === 'verified' ? 200 : 422);
});

router.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  await getDb(c).deleteAccount(id);
  await getDb(c).addAuditLog({ accountId: id, action: 'account.delete' });
  return json(c, { ok: true });
});

router.post('/accounts/:id/test', async (c) => {
  const id = c.req.param('id');
  const res = await testAccount(c.env, id);
  await getDb(c).addAuditLog({ accountId: id, action: `account.test.${res.status ?? 'failed'}` });
  return json(c, res);
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
  const body = await c.req.json().catch(() => null) as {
    label: string;
    cfApiToken: string;
    workerName?: string;
  } | null;
  if (!body || !body.label || !body.cfApiToken) {
    return json(c, { error: 'label and cfApiToken required' }, 400);
  }
  const workerName = body.workerName || `manga-api-${Date.now().toString(36)}`;
  const jobId = crypto.randomUUID();
  c.executionCtx.waitUntil(
    provisionAccount(c.env, { label: body.label, cfApiToken: body.cfApiToken, workerName, jobId })
      .catch((e) => console.error('[provision]', e))
  );
  return json(c, { job_id: jobId, worker_name: workerName, provisioning: true });
});

router.get('/accounts/:id/provision-status', async (c) => {
  const status = await checkProvisionStatus(c.env, c.req.param('id'));
  if (!status) return json(c, { error: 'job not found' }, 404);
  return json(c, { data: status });
});
