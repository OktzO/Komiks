import { encryptToken } from './crypto.ts';
import { resolveCloudflareAccount } from './accounts.ts';
import type { CloudflareAccount } from './accounts.ts';
import { db as openDb } from '@manga-platform/db';
import { drainResponse } from '@manga-platform/shared/http';
import type { KVNamespace, D1Database } from '@cloudflare/workers-types';

export interface ProvisionEnv {
  LB_ENCRYPTION_KEY: string;
  CACHE_KV: KVNamespace;
  DB: D1Database;
  // Optional: provision inherits these from the parent worker so the
  // auto-provisioned child can run the same admin/LB code paths.
  ADMIN_PASSWORD?: string;
  ADMIN_PASSWORD_HASH?: string;
  ALLOWED_ORIGINS?: string;
  CF_INVENTORY_TOKEN?: string;
}

export interface ProvisionInput {
  label?: string;
  cfApiToken: string;
  workerName: string;
  jobId: string;
  accountId?: string;
  resolvedAccount?: CloudflareAccount;
  createdBy?: number | null;
}

export interface ProvisionResult {
  jobId: string;
  workerUrl?: string;
}

export interface ProvisionJob {
  status: 'pending' | 'verifying' | 'creating_d1' | 'migrating' | 'creating_kv' | 'deploying' | 'setting_secrets' | 'registering' | 'completed' | 'failed';
  step: string;
  error?: string;
  workerUrl?: string;
  accountId?: string;
  databaseId?: string;
  kvId?: string;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

export const setJob = async (env: ProvisionEnv, jobId: string, job: ProvisionJob): Promise<void> => {
  await env.CACHE_KV.put(`provision:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 });
};

export const checkProvisionStatus = async (env: ProvisionEnv, jobId: string): Promise<ProvisionJob | null> => {
  const raw = await env.CACHE_KV.get(`provision:${jobId}`);
  return raw ? JSON.parse(raw) as ProvisionJob : null;
};

const cfFetch = async (token: string, path: string, init?: RequestInit): Promise<any> => {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    await drainResponse(res);
    throw new Error(`cloudflare api ${path} → HTTP ${res.status}`);
  }
  const body = await res.json() as any;
  if (!body?.success) throw new Error(`cloudflare api ${path} → rejected`);
  return body;
};

const readProviderId = (value: unknown, resource: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`cloudflare ${resource} response has no id`);
  return value;
};

const getWorkerBundle = async (env: ProvisionEnv): Promise<string> => {
  const encoded = await env.CACHE_KV.get('worker-bundle:latest');
  if (!encoded) throw new Error('worker bundle not in KV — run build:bundle + seed KV');
  return atob(encoded);
};

const SCHEMA_SQL_KEY = 'provision:schema:latest';

const getSchema = async (env: ProvisionEnv): Promise<string> => {
  const fromKv = await env.CACHE_KV.get(SCHEMA_SQL_KEY).catch(() => null);
  if (fromKv) return fromKv;
  throw new Error(`schema not found — seed KV key "${SCHEMA_SQL_KEY}" (run build:bundle + seed)`);
};

export const provisionAccount = async (env: ProvisionEnv, input: ProvisionInput): Promise<ProvisionResult> => {
  const jobId = input.jobId;
  const handles: { accountId?: string; databaseId?: string; kvId?: string; workerUrl?: string } = {};
  let state: ProvisionJob = { status: 'pending', step: 'started' };
  const advance = async (status: ProvisionJob['status'], step: string): Promise<void> => {
    state = { status, step, ...handles };
    await setJob(env, jobId, state);
  };
  await advance('pending', 'started');

  try {
    // 1. Verify token
    await advance('verifying', 'verify token');
    const verify = await cfFetch(input.cfApiToken, '/user/tokens/verify');
    if (verify.result?.status !== 'active') throw new Error('token not active');

    // 2. Get account ID
    await advance('verifying', 'resolve account');
    const account = input.resolvedAccount
      ?? await resolveCloudflareAccount(input.cfApiToken, input.accountId);
    if (input.accountId && account.id !== input.accountId) {
      throw new Error('resolved account does not match the requested accountId');
    }
    const accountId = account.id;
    handles.accountId = accountId;
    await advance('verifying', 'got account');

    // 3. Create D1 database
    await advance('creating_d1', 'create D1');
    const d1Res = await cfFetch(input.cfApiToken, `/accounts/${accountId}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: `manga-db-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const databaseId = readProviderId(d1Res.result?.uuid, 'd1 database');
    handles.databaseId = databaseId;

    // 4. Apply schema.sql (embedded, not fetched from GitHub). It is the
    // complete current baseline — it already carries lb_accounts.last_tested_at
    // and the _migrations ledger table — so no numbered migration is replayed
    // here. Upgrading an older database is scripts/migrate-all-4.sh's job.
    await advance('migrating', 'schema.sql');
    const schemaSql = await getSchema(env);
    await cfFetch(input.cfApiToken, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql: schemaSql }),
    });

    // 5. Create KV namespace
    await advance('creating_kv', 'create KV');
    const kvRes = await cfFetch(input.cfApiToken, `/accounts/${accountId}/storage/kv/namespaces`, {
      method: 'POST',
      body: JSON.stringify({ title: `manga-cache-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const kvId = readProviderId(kvRes.result?.id, 'kv namespace');
    handles.kvId = kvId;

    // 6. Deploy Worker — upload bundle (ESM module + metadata).
    // Bindings include D1 + CACHE_KV + MY_BROWSER.
    await advance('deploying', 'upload worker');
    const workerBundle = await getWorkerBundle(env);
    const bindings: Array<Record<string, unknown>> = [
      { type: 'd1', name: 'DB', id: databaseId },
      { type: 'kv_namespace', name: 'CACHE_KV', namespace_id: kvId },
      // Browser binding — provisioned child inherits MY_BROWSER (Fetcher) so
      // any code path that touches MY_BROWSER does not crash with undefined binding.
      { type: 'browser', name: 'MY_BROWSER' },
      { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: accountId },
      { type: 'plain_text', name: 'CF_WORKER_NAME', text: input.workerName },
      { type: 'plain_text', name: 'CF_D1_ID', text: databaseId },
      { type: 'plain_text', name: 'CF_KV_ID', text: kvId },
    ];
    const metadata = {
      main_module: 'index.js',
      bindings,
      compatibility_date: '2024-08-01',
      compatibility_flags: ['nodejs_compat'],
    };
    // CF API requires multipart/form-data — FormData in Workers sets this automatically
    // Do NOT use cfFetch (which sets Content-Type: application/json)
    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    formData.append('index.js', new Blob([workerBundle], { type: 'application/javascript+module' }), 'index.js');
    const deployRes = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${input.workerName}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${input.cfApiToken}` },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });
    if (!deployRes.ok) {
      await drainResponse(deployRes);
      throw new Error(`cloudflare worker deploy → HTTP ${deployRes.status}`);
    }
    const deployBody = await deployRes.json() as any;
    if (!deployBody?.success) throw new Error('cloudflare worker deploy → rejected');

    // 7. Enable workers.dev subdomain + get worker URL
    await cfFetch(input.cfApiToken, `/accounts/${accountId}/workers/scripts/${input.workerName}/subdomain`, {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    });
    const subdomainRes = await cfFetch(input.cfApiToken, `/accounts/${accountId}/workers/subdomain`);
    const subdomain = subdomainRes.result?.subdomain;
    if (!subdomain) throw new Error('no workers.dev subdomain found');
    const workerUrl = `https://${input.workerName}.${subdomain}.workers.dev`;
    handles.workerUrl = workerUrl;

    // 8. Set secrets — now includes ADMIN_PASSWORD_HASH + LB_ENCRYPTION_KEY so
    // auto-provisioned workers can serve LB admin endpoints and encrypt their
    // own stored tokens. Inherit from parent env when set; generate when unset.
    await advance('setting_secrets', 'set secrets');
    const allowedOrigins = env.ALLOWED_ORIGINS || '';
    const adminPassword = env.ADMIN_PASSWORD_HASH || env.ADMIN_PASSWORD || '';
    const lbEncryptionKey = env.LB_ENCRYPTION_KEY || '';
    const secrets = [
      { name: 'ALLOWED_ORIGINS', text: allowedOrigins, type: 'secret_text' },
      { name: 'SCRAPE_API_KEY', text: crypto.randomUUID(), type: 'secret_text' },
      { name: 'ADMIN_PASSWORD_HASH', text: adminPassword, type: 'secret_text' },
      { name: 'LB_ENCRYPTION_KEY', text: lbEncryptionKey, type: 'secret_text' },
      { name: 'CF_INVENTORY_TOKEN', text: env.CF_INVENTORY_TOKEN || '', type: 'secret_text' },
    ].filter((s) => s.text !== '');
    for (const s of secrets) {
      await cfFetch(input.cfApiToken, `/accounts/${accountId}/workers/scripts/${input.workerName}/secrets`, {
        method: 'PUT',
        body: JSON.stringify(s),
      });
    }

    // 9. Encrypt + store token, add origin to main DB
    await advance('registering', 'register account');
    const encrypted = await encryptToken(env.LB_ENCRYPTION_KEY, input.cfApiToken);
    const blob = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) as ArrayBuffer;
    const seam = openDb(env.DB);
    const stored = await seam.addAccount({
      label: input.label?.trim() || account.name,
      provider: 'cloudflare',
      account_ref: accountId,
      encrypted_token: blob,
      token_last4: input.cfApiToken.slice(-4),
      status: 'verified',
      created_by: input.createdBy ?? null
    });
    if (!stored) throw new Error('lb/provision: addAccount returned no id');
    let origin: { id: string } | null = null;
    try {
      origin = await seam.createOrigin({
        account_id: stored.id,
        origin_url: workerUrl,
        priority: 0,
        weight: 1,
        enabled: 0
      });
    } catch (e) {
      await seam.deleteAccount(stored.id);
      throw e;
    }
    if (!origin) {
      await seam.deleteAccount(stored.id);
      throw new Error('lb/provision: createOrigin returned no id');
    }
    await seam.addAuditLog({
      accountId: stored.id,
      originId: origin.id,
      action: 'account.create.verified',
      userId: input.createdBy ?? null
    });

    await advance('completed', 'done');
    return { jobId, workerUrl };
  } catch (e) {
    console.error('[lb/provision]', String(e).slice(0, 500));
    await setJob(env, jobId, { ...state, ...handles, status: 'failed', error: 'provision_failed' });
    return { jobId };
  }
};
