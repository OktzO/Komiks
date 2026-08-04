'use client';
import { useState, useEffect } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export default function LbAdminPage() {
  const [stepup, setStepup] = useState('');
  const [authed, setAuthed] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [origins, setOrigins] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'settings' | 'accounts' | 'origins' | 'status'>('settings');

  const headers = () => ({ 'Content-Type': 'application/json', 'x-admin-stepup': stepup });

  const loadAll = async () => {
    try {
      const [s, a, o, st] = await Promise.all([
        fetch(`${API_URL}/api/admin/lb/settings`, { headers: headers() }),
        fetch(`${API_URL}/api/admin/lb/accounts`, { headers: headers() }),
        fetch(`${API_URL}/api/admin/lb/origins`, { headers: headers() }),
        fetch(`${API_URL}/api/admin/lb/status`, { headers: headers() }),
      ]);
      if (s.ok) setSettings((await s.json()).data);
      if (a.ok) setAccounts((await a.json()).data || []);
      if (o.ok) setOrigins((await o.json()).data || []);
      if (st.ok) setStatus((await st.json()).data);
      if (!s.ok && s.status === 401) { setAuthed(false); setError('Step-up password salah'); }
      else { setAuthed(true); setError(null); }
    } catch (e) { setError(String(e)); }
  };

  useEffect(() => { if (authed) loadAll(); }, [authed, tab]);

  const login = () => { setAuthed(true); loadAll(); };

  const updateSettings = async (updates: any) => {
    await fetch(`${API_URL}/api/admin/lb/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify(updates) });
    loadAll();
  };

  const addAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await fetch(`${API_URL}/api/admin/lb/accounts`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ label: f.get('label'), provider: f.get('provider'), account_ref: f.get('account_ref'), rawToken: f.get('rawToken'), token_last4: (f.get('rawToken') as string).slice(-4) })
    });
    loadAll();
  };

  const addOrigin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await fetch(`${API_URL}/api/admin/lb/origins`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ account_id: f.get('account_id') || null, origin_url: f.get('origin_url'), priority: Number(f.get('priority') || 0), weight: Number(f.get('weight') || 1), enabled: 1 })
    });
    loadAll();
  };

  if (!authed) {
    return (
      <main className="max-w-md mx-auto px-4 py-12">
        <h1 className="text-xl font-semibold mb-4">Admin Load Balancing</h1>
        <p className="text-secondary text-sm mb-4">Masukkan password admin untuk akses.</p>
        <input type="password" placeholder="Admin password" value={stepup} onChange={(e) => setStepup(e.target.value)} className="w-full bg-card border border-border-default rounded px-3 py-2 mb-3 text-primary" />
        <button onClick={login} className="w-full px-4 py-2 border border-border-default rounded text-sm hover:bg-elevated">Masuk</button>
        {error && <div className="text-error text-sm mt-3">{error}</div>}
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-4">Load Balancing</h1>
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
