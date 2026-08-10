'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { fetchMe, apiGet, roleLabel, type AuthUser } from '@/lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export default function AdminSettingsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [settings, setSettings] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [origins, setOrigins] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'settings' | 'accounts' | 'origins' | 'status'>('settings');
  const [provisionStatus, setProvisionStatus] = useState<any>(null);
  const [provisioning, setProvisioning] = useState(false);
  const provisionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const router = useRouter();

  const headers = () => ({ 'Content-Type': 'application/json' });

  const loadAll = useCallback(async () => {
    try {
      const [s, a, o, st] = await Promise.all([
        apiGet<{ data: any }>(`${API_URL}/api/admin/lb/settings`),
        apiGet<{ data: any[] }>(`${API_URL}/api/admin/lb/accounts`),
        apiGet<{ data: any[] }>(`${API_URL}/api/admin/lb/origins`),
        apiGet<{ data: any }>(`${API_URL}/api/admin/lb/status`),
      ]);
      setSettings(s.data);
      setAccounts(a.data || []);
      setOrigins(o.data || []);
      setStatus(st.data);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    fetchMe().then((u) => {
      setUser(u);
      setAuthLoading(false);
      if (!u || u.role !== 'admin') router.replace('/');
    });
  }, [router]);

  useEffect(() => {
    if (user?.role === 'admin') loadAll();
  }, [user, loadAll]);

  const updateSettings = async (updates: any) => {
    await fetch(`${API_URL}/api/admin/lb/settings`, { method: 'PUT', headers: headers(), credentials: 'include', body: JSON.stringify(updates) });
    loadAll();
  };

  const addAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await fetch(`${API_URL}/api/admin/lb/accounts`, {
      method: 'POST', headers: headers(), credentials: 'include',
      body: JSON.stringify({ label: f.get('label'), provider: f.get('provider'), account_ref: f.get('account_ref'), rawToken: f.get('rawToken'), token_last4: (f.get('rawToken') as string).slice(-4) })
    });
    loadAll();
  };

  const provisionAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const label = f.get('provision_label') as string;
    const token = f.get('provision_token') as string;
    const workerName = (f.get('provision_worker_name') as string) || `manga-api-${crypto.randomUUID().slice(0, 8)}`;
    setProvisioning(true);
    setProvisionStatus(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/lb/accounts/provision`, {
        method: 'POST', headers: headers(), credentials: 'include',
        body: JSON.stringify({ label, cfApiToken: token, workerName }),
      });
      const j = await res.json() as any;
      const jobId = j.job_id;
      if (!jobId) throw new Error('no job_id returned');
      const poll = setInterval(async () => {
        try {
          const st = await apiGet<{ data: any }>(`${API_URL}/api/admin/lb/accounts/${jobId}/provision-status`);
          setProvisionStatus(st.data);
          if (st.data?.status === 'completed' || st.data?.status === 'failed') {
            clearInterval(poll);
            provisionPollRef.current = null;
            setProvisioning(false);
            loadAll();
          }
        } catch {}
      }, 3000);
      provisionPollRef.current = poll;
    } catch (e) { setProvisioning(false); setError(String(e)); }
  };

  useEffect(() => {
    return () => {
      if (provisionPollRef.current) clearInterval(provisionPollRef.current);
    };
  }, []);

  const addOrigin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await fetch(`${API_URL}/api/admin/lb/origins`, {
      method: 'POST', headers: headers(), credentials: 'include',
      body: JSON.stringify({ account_id: f.get('account_id') || null, origin_url: f.get('origin_url'), priority: Number(f.get('priority') || 0), weight: Number(f.get('weight') || 1), enabled: 1 })
    });
    loadAll();
  };

  if (authLoading) {
    return (
      <main className="max-w-md mx-auto px-4 py-12">
        <div className="animate-pulse space-y-3">
          <div className="h-8 w-48 rounded bg-card" />
          <div className="h-32 w-full rounded bg-card" />
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') return null;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-primary">Admin setting</h1>
          <p className="text-sm text-muted mt-1">Load balancer · akun · origin · status. {user.email} · {roleLabel(user.role)}.</p>
        </div>
      </div>
      {error && <div className="text-error text-sm mb-4">{error}</div>}
      <div className="flex gap-2 mb-6 border-b border-subtle">
        {(['settings', 'accounts', 'origins', 'status'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm border-b-2 ${tab === t ? 'border-accent text-primary' : 'border-transparent text-secondary'}`}>
            {t === 'settings' ? 'Mode' : t === 'accounts' ? 'Akun' : t === 'origins' ? 'Origin Pool' : 'Status'}
          </button>
        ))}
      </div>

      {tab === 'settings' && settings && (
        <div className="space-y-4 bg-card border border-subtle rounded p-5">
          <div>
            <label className="text-sm text-secondary">Mode</label>
            <select value={settings.mode} onChange={(e) => updateSettings({ mode: e.target.value })} className="block bg-base border border-border-default rounded px-3 py-2 mt-1 text-primary">
              <option value="off">Nonaktif</option>
              <option value="on">Aktif</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-secondary">Implementasi</label>
            <select value={settings.implementation} onChange={(e) => updateSettings({ implementation: e.target.value })} className="block bg-base border border-border-default rounded px-3 py-2 mt-1 text-primary">
              <option value="custom">Custom (gratis)</option>
              <option value="native_cf">Native CF LB</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-secondary">Steering Policy</label>
            <input defaultValue={settings.steering_policy} onBlur={(e) => updateSettings({ steering_policy: e.target.value })} className="block bg-base border border-border-default rounded px-3 py-2 mt-1 text-primary" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-muted">Interval (s)</label><input type="number" defaultValue={settings.health_check_interval_sec} onBlur={(e) => updateSettings({ health_check_interval_sec: Number(e.target.value) })} className="block w-full bg-base border border-border-default rounded px-2 py-1 mt-1 text-primary" /></div>
            <div><label className="text-xs text-muted">Timeout (ms)</label><input type="number" defaultValue={settings.health_check_timeout_ms} onBlur={(e) => updateSettings({ health_check_timeout_ms: Number(e.target.value) })} className="block w-full bg-base border border-border-default rounded px-2 py-1 mt-1 text-primary" /></div>
            <div><label className="text-xs text-muted">Fail Threshold</label><input type="number" defaultValue={settings.failure_threshold} onBlur={(e) => updateSettings({ failure_threshold: Number(e.target.value) })} className="block w-full bg-base border border-border-default rounded px-2 py-1 mt-1 text-primary" /></div>
          </div>
        </div>
      )}

      {tab === 'accounts' && (
        <div className="space-y-4">
          <div className="bg-card border border-subtle rounded p-4 space-y-2">
            <h2 className="text-sm font-medium">⚡ Auto-Provision Akun CF Baru</h2>
            <p className="text-xs text-muted">Bikin D1 + Worker baru otomatis di akun Cloudflare lain. Token butuh permission: Workers Scripts:Edit, D1:Edit, KV:Edit, R2:Edit.</p>
            <form onSubmit={provisionAccount} className="space-y-2">
              <input name="provision_label" placeholder="Label akun" required className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
              <input name="provision_worker_name" placeholder="Worker name (auto)" className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
              <input name="provision_token" type="password" placeholder="CF API Token" required className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
              <button type="submit" disabled={provisioning} className="px-4 py-1.5 border border-border-default rounded text-sm hover:bg-elevated disabled:opacity-50">
                {provisioning ? 'Provisioning...' : 'Provision'}
              </button>
            </form>
            {provisionStatus && (
              <div className="text-xs space-y-1">
                <div className={provisionStatus.status === 'completed' ? 'text-success' : provisionStatus.status === 'failed' ? 'text-error' : 'text-secondary'}>
                  Status: {provisionStatus.status} — {provisionStatus.step}
                </div>
                {provisionStatus.workerUrl && <div className="text-success">Worker URL: {provisionStatus.workerUrl}</div>}
                {provisionStatus.error && <div className="text-error">Error: {provisionStatus.error}</div>}
              </div>
            )}
          </div>
          <form onSubmit={addAccount} className="bg-card border border-subtle rounded p-4 space-y-2">
            <h2 className="text-sm font-medium">+ Tambah Akun</h2>
            <input name="label" placeholder="Label" required className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
            <select name="provider" className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm">
              <option value="cloudflare">Cloudflare</option>
              <option value="vercel">Vercel</option>
            </select>
            <input name="account_ref" placeholder="Account/Team ID" className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
            <input name="rawToken" placeholder="API Token" required className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
            <button type="submit" className="px-4 py-1.5 border border-border-default rounded text-sm hover:bg-elevated">Tambah</button>
          </form>
          <div className="divide-y divide-border-subtle border border-subtle rounded bg-card">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <span className="text-primary">{a.label}</span>
                  <span className="ml-2 text-xs px-2 py-0.5 border border-border-default rounded">{a.provider}</span>
                  <span className="ml-2 text-muted text-xs">cf_****{a.token_last4}</span>
                </div>
                <span className={a.status === 'verified' ? 'text-success text-xs' : 'text-error text-xs'}>{a.status === 'verified' ? '✅' : '⚠️'} {a.status}</span>
              </div>
            ))}
            {accounts.length === 0 && <div className="px-4 py-3 text-muted text-sm">Belum ada akun.</div>}
          </div>
        </div>
      )}

      {tab === 'origins' && (
        <div className="space-y-4">
          <form onSubmit={addOrigin} className="bg-card border border-subtle rounded p-4 space-y-2">
            <h2 className="text-sm font-medium">+ Tambah Origin</h2>
            <input name="origin_url" placeholder="https://..." required className="w-full bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
            <div className="flex gap-2">
              <input name="priority" type="number" placeholder="Priority" defaultValue={0} className="flex-1 bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
              <input name="weight" type="number" placeholder="Weight" defaultValue={1} className="flex-1 bg-base border border-border-default rounded px-3 py-2 text-primary text-sm" />
            </div>
            <button type="submit" className="px-4 py-1.5 border border-border-default rounded text-sm hover:bg-elevated">Tambah</button>
          </form>
          <div className="divide-y divide-border-subtle border border-subtle rounded bg-card">
            {origins.map((o) => (
              <div key={o.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div><span className="text-primary">{o.origin_url}</span><span className="ml-2 text-muted text-xs">P{o.priority} W{o.weight}</span></div>
                <span className={o.enabled === 1 ? 'text-success text-xs' : 'text-muted text-xs'}>{o.enabled === 1 ? 'ON' : 'OFF'}</span>
              </div>
            ))}
            {origins.length === 0 && <div className="px-4 py-3 text-muted text-sm">Belum ada origin.</div>}
          </div>
        </div>
      )}

      {tab === 'status' && status && (
        <div className="bg-card border border-subtle rounded p-5">
          <div className="mb-4"><span className="text-secondary text-sm">Mode: </span><span className="text-primary">{status.mode}</span></div>
          <div className="divide-y divide-border-subtle">
            {status.origins?.map((o: any) => (
              <div key={o.id} className="flex justify-between py-2 text-sm">
                <span className="text-primary">{o.origin_url}</span>
                <span className={o.last_health_status === 'healthy' ? 'text-success' : o.last_health_status === 'unhealthy' ? 'text-error' : 'text-muted'}>
                  {o.last_health_status ?? '—'} {o.last_checked_at ? new Date(o.last_checked_at * 1000).toLocaleTimeString() : ''}
                </span>
              </div>
            ))}
            {(!status.origins || status.origins.length === 0) && <div className="py-3 text-muted text-sm">Belum ada origin.</div>}
          </div>
        </div>
      )}
    </main>
  );
}
