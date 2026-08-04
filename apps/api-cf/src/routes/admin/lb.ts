import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Env, getDb, json } from '../../lib/context';
import { createAccount, listAccountsSafe, testAccount } from '@manga-platform/lb/accounts';

export const router = new Hono<{ Bindings: Env }>();

// Step-up re-auth: every LB admin mutation requires the admin password hash
// echoed back via x-admin-stepup. Compares against env.ADMIN_PASSWORD_HASH.
const requireAdminStepUp: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const supplied = c.req.header('x-admin-stepup');
  const expected = c.env.ADMIN_PASSWORD_HASH;
  if (!expected || supplied !== expected) {
    return json(c, { error: 'step-up auth required' }, 401);
  }
  await next();
};

router.use('*', requireAdminStepUp);

// ---- settings -------------------------------------------------------------
router.get('/settings', async (c) => {
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
