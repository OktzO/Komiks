import { encryptToken } from './crypto.js';
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
}

export interface ProvisionInput {
  label: string;
  cfApiToken: string;
  workerName: string;
  jobId: string;
  createdBy?: number | null;
}

export interface ProvisionResult {
  jobId: string;
  workerUrl?: string;
}

export interface ProvisionJob {
  status: 'pending' | 'verifying' | 'creating_d1' | 'migrating' | 'creating_kv' | 'creating_r2' | 'deploying' | 'setting_secrets' | 'completed' | 'failed';
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
  const body = await res.json() as any;
  if (!res.ok || !body.success) {
    const errMsg = body.errors?.[0]?.message || JSON.stringify(body.errors || body);
    throw new Error(`CF API ${path} → ${res.status}: ${errMsg}`);
  }
  return body;
};

const getWorkerBundle = async (env: ProvisionEnv): Promise<string> => {
  const encoded = await env.CACHE_KV.get('worker-bundle:latest');
  if (!encoded) throw new Error('worker bundle not in KV — run build:bundle + seed KV');
  return atob(encoded);
};

// Schema is embedded at build time via scripts/build-worker-bundle.mjs which
// inlines these strings. Avoids runtime fetch from untrusted GitHub URLs
// (SSRF/integrity risk). If the bundle build did not inline them, fall back
// to the KV-stored copy seeded alongside the worker bundle.
const SCHEMA_SQL_KEY = 'provision:schema:latest';
const MIGRATION_SQL_KEY = 'provision:migration:latest';

const getSchema = async (env: ProvisionEnv): Promise<string> => {
  // Bundled constant takes priority; else read from KV (seeded by build step).
  const fromKv = await env.CACHE_KV.get(SCHEMA_SQL_KEY).catch(() => null);
  if (fromKv) return fromKv;
  throw new Error(`schema not found — seed KV key "${SCHEMA_SQL_KEY}" (run build:bundle + seed)`);
};

const getMigration = async (env: ProvisionEnv): Promise<string> => {
  const fromKv = await env.CACHE_KV.get(MIGRATION_SQL_KEY).catch(() => null);
  if (fromKv) return fromKv;
  throw new Error(`migration not found — seed KV key "${MIGRATION_SQL_KEY}" (run build:bundle + seed)`);
};

export const provisionAccount = async (env: ProvisionEnv, input: ProvisionInput): Promise<ProvisionResult> => {
  const jobId = input.jobId;
  await setJob(env, jobId, { status: 'pending', step: 'started' });

  try {
    // 1. Verify token
    await setJob(env, jobId, { status: 'verifying', step: 'verify token' });
    const verify = await cfFetch(input.cfApiToken, '/user/tokens/verify');
    if (verify.result?.status !== 'active') throw new Error('token not active');

    // 2. Get account ID
    const accounts = await cfFetch(input.cfApiToken, '/accounts');
    const accountId = accounts.result[0]?.id;
    if (!accountId) throw new Error('no account found for token');
    await setJob(env, jobId, { status: 'verifying', step: 'got account', accountId });

    // 3. Create D1 database
    await setJob(env, jobId, { status: 'creating_d1', step: 'create D1', accountId });
    const d1Res = await cfFetch(input.cfApiToken, `/accounts/${accountId}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: `manga-db-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const databaseId = d1Res.result.uuid;

    // 4. Run migration — schema.sql (embedded, not fetched from GitHub)
    await setJob(env, jobId, { status: 'migrating', step: 'schema.sql', accountId, databaseId });
    const schemaSql = await getSchema(env);
    await cfFetch(input.cfApiToken, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql: schemaSql }),
    });

    // 5. Run migration 0001 (embedded)
    await setJob(env, jobId, { status: 'migrating', step: '0001_manga_data.sql', accountId, databaseId });
    const migSql = await getMigration(env);
    await cfFetch(input.cfApiToken, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql: migSql }),
    });

    // 6. Create KV namespace
    await setJob(env, jobId, { status: 'creating_kv', step: 'create KV', accountId, databaseId });
    const kvRes = await cfFetch(input.cfApiToken, `/accounts/${accountId}/storage/kv/namespaces`, {
      method: 'POST',
      body: JSON.stringify({ title: `manga-cache-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const kvId = kvRes.result.id;

    // 7. Deploy Worker — upload bundle (ESM module + metadata).
    // Bindings include D1 + CACHE_KV + MY_BROWSER.
    await setJob(env, jobId, { status: 'deploying', step: 'upload worker', accountId, databaseId, kvId });
    const workerBundle = await getWorkerBundle(env);
    const bindings: Array<Record<string, unknown>> = [
      { type: 'd1', name: 'DB', id: databaseId },
      { type: 'kv_namespace', name: 'CACHE_KV', namespace_id: kvId },
      // Browser binding — provisioned child inherits MY_BROWSER (Fetcher) so
      // any code path that touches MY_BROWSER does not crash with undefined binding.
      { type: 'browser', name: 'MY_BROWSER' },
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
    const deployBody = await deployRes.json() as any;
    if (!deployRes.ok || !deployBody.success) {
      throw new Error(`CF API worker deploy → ${deployRes.status}: ${JSON.stringify(deployBody.errors || deployBody)}`);
    }

    // 9. Enable workers.dev subdomain + get worker URL
    await cfFetch(input.cfApiToken, `/accounts/${accountId}/workers/scripts/${input.workerName}/subdomain`, {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    });
    const subdomainRes = await cfFetch(input.cfApiToken, `/accounts/${accountId}/workers/subdomain`);
    const subdomain = subdomainRes.result?.subdomain;
    if (!subdomain) throw new Error('no workers.dev subdomain found');
    const workerUrl = `https://${input.workerName}.${subdomain}.workers.dev`;

    // 10. Set secrets — now includes ADMIN_PASSWORD_HASH + LB_ENCRYPTION_KEY so
    // auto-provisioned workers can serve LB admin endpoints and encrypt their
    // own stored tokens. Inherit from parent env when set; generate when unset.
    await setJob(env, jobId, { status: 'setting_secrets', step: 'set secrets', workerUrl, accountId, databaseId, kvId });
    const allowedOrigins = env.ALLOWED_ORIGINS || '';
    const adminPassword = env.ADMIN_PASSWORD_HASH || env.ADMIN_PASSWORD || '';
    const lbEncryptionKey = env.LB_ENCRYPTION_KEY || '';
    const secrets = [
      { name: 'ALLOWED_ORIGINS', text: allowedOrigins, type: 'secret_text' },
      { name: 'SCRAPE_API_KEY', text: crypto.randomUUID(), type: 'secret_text' },
      { name: 'ADMIN_PASSWORD_HASH', text: adminPassword, type: 'secret_text' },
      { name: 'LB_ENCRYPTION_KEY', text: lbEncryptionKey, type: 'secret_text' },
    ].filter((s) => s.text !== '');
    for (const s of secrets) {
      await cfFetch(input.cfApiToken, `/accounts/${accountId}/workers/scripts/${input.workerName}/secrets`, {
        method: 'PUT',
        body: JSON.stringify(s),
      });
    }

    // 11. Encrypt + store token, add origin to main DB
    const encrypted = await encryptToken(env.LB_ENCRYPTION_KEY, input.cfApiToken);
    const blob = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) as ArrayBuffer;

    // Store account in main DB via D1
    const accountId2 = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO lb_accounts (id, provider, label, encrypted_token, token_last4, status, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
    ).bind(accountId2, 'cloudflare', input.label, blob, input.cfApiToken.slice(-4), 'verified', input.createdBy ?? null).run();

    // Add origin
    const originId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO lb_origins (id, account_id, origin_url, priority, weight, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(originId, accountId2, workerUrl, 0, 1, 1).run();

    await setJob(env, jobId, { status: 'completed', step: 'done', workerUrl, accountId, databaseId, kvId });
    return { jobId, workerUrl };
  } catch (e) {
    await setJob(env, jobId, { status: 'failed', step: 'error', error: String(e).slice(0, 500) });
    return { jobId };
  }
};
