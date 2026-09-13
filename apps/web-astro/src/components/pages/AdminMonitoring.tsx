'use client';
import { useEffect, useState, useCallback } from 'react';
import { fetchMe, apiGet, type AuthUser } from '@/lib/api';

type Provider = {
  id: string;
  provider: string;
  label: string;
  status: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  requests_24h: number;
  failures_24h: number;
  quota_used_bytes: number | null;
  quota_limit_bytes: number | null;
  updated_at: number;
};

type DbUsageCurrent = { db_name: string; rows_or_objects: number | null; size_bytes: number | null };
type DbUsagePoint = { ts: number; size_bytes: number | null; rows_or_objects: number | null };
type DbUsageTrend = { db_name: string; points: DbUsagePoint[] };
type DbUsage = { current: DbUsageCurrent[]; trend: DbUsageTrend[] };

type ScrapeLog = {
  id: string;
  source: string;
  provider_account_id: string | null;
  status: string;
  items_scraped: number;
  duration_ms: number | null;
  error_message: string | null;
  started_at: number;
  finished_at: number | null;
};

function formatRelative(ts: number | null): string {
  if (!ts) return 'belum pernah';
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diffSec < 60) return `${diffSec} detik lalu`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} menit lalu`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} jam lalu`;
  return `${Math.floor(diffSec / 86400)} hari lalu`;
}

function formatBytes(b: number | null): string {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function AdminMonitoringPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [dbUsage, setDbUsage] = useState<DbUsage | null>(null);
  const [scrapeLogs, setScrapeLogs] = useState<ScrapeLog[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  
  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setUser(u);
      setLoading(false);
      if (!u || u.role !== 'admin') window.location.replace('/');
    });
    return () => { alive = false; };
  }, []);

  const loadAll = useCallback(async () => {
    if (document.hidden) return; // tab background — jangan boros API/KV
    setRefreshing(true);
    try {
      const [pRes, dRes, sRes] = await Promise.all([
        apiGet<{ data: Provider[] }>('/api/admin/providers'),
        apiGet<{ data: DbUsage }>('/api/admin/db-usage?days=7'),
        apiGet<{ data: ScrapeLog[] }>('/api/admin/scrape-jobs?limit=30'),
      ]);
      setProviders(pRes.data || []);
      setDbUsage(dRes.data);
      setScrapeLogs(sRes.data || []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') {
      loadAll();
      // 30s refresh — less aggressive than 12s, reduces API/KV load.
      const interval = setInterval(loadAll, 30000);
      return () => clearInterval(interval);
    }
  }, [user, loadAll]);

  if (loading) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 w-full rounded-lg bg-card" />
          ))}
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') return null;

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 sm:py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <a href="/admin" className="text-sm text-secondary hover:text-primary transition-colors mb-2 inline-block">
            ← Overview
          </a>
          <h1 className="text-2xl font-semibold text-primary">Monitoring</h1>
          <p className="text-sm text-muted mt-1">Load balancer health · DB usage · scrape log</p>
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className={`status-dot ${refreshing ? 'live' : 'unknown'}`} />
          {refreshing ? 'refreshing' : 'live'}
        </span>
      </div>

      {error && (
        <div className="mb-6 text-sm text-error border border-error/40 rounded-lg p-3 bg-error/5">
          {error}
        </div>
      )}

      {/* Provider grid */}
      <section className="mb-10">
        <h2 className="text-sm font-medium text-secondary mb-3">Provider Accounts</h2>
        <div className="border border-subtle rounded-lg overflow-hidden bg-card">
          <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs text-muted border-b border-subtle">
            <div className="col-span-4">Account</div>
            <div className="col-span-2 text-right">Requests · 24h</div>
            <div className="col-span-2 text-right">Fail rate</div>
            <div className="col-span-2 text-right">Last success</div>
            <div className="col-span-2 text-right">Quota</div>
          </div>
          {providers.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted text-center">
              No provider data yet. Run scraper with hooks to populate.
            </div>
          ) : (
            providers.map((p) => {
              const failRate = p.requests_24h > 0 ? ((p.failures_24h / p.requests_24h) * 100).toFixed(1) : '0.0';
              const quotaPct = p.quota_limit_bytes && p.quota_used_bytes != null
                ? Math.min(100, (p.quota_used_bytes / p.quota_limit_bytes) * 100)
                : null;
              return (
                <div key={p.id} className="border-b border-subtle last:border-0">
                  <div className="grid grid-cols-12 gap-2 px-4 py-3 items-center text-sm">
                    <div className="col-span-4 flex items-center gap-2">
                      <span className={`status-dot ${p.status} ${p.status === 'healthy' ? 'live' : ''}`} />
                      <div className="min-w-0">
                        <div className="text-primary truncate">{p.label}</div>
                        <div className="text-xs text-muted">{p.provider}</div>
                      </div>
                    </div>
                    <div className="col-span-2 text-right font-mono tabular text-primary">{p.requests_24h}</div>
                    <div className="col-span-2 text-right font-mono tabular text-primary">{failRate}%</div>
                    <div className="col-span-2 text-right text-xs text-muted">{formatRelative(p.last_success_at)}</div>
                    <div className="col-span-2 text-right">
                      {quotaPct != null ? (
                        <div className="quota-bar ml-auto" style={{ width: '80px' }}>
                          <span style={{ transform: `scaleX(${quotaPct / 100})` }} />
                        </div>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </div>
                  </div>
                  {p.last_error && (
                    <div className="px-4 pb-2">
                      <button
                        onClick={() => setExpandedError(expandedError === p.id ? null : p.id)}
                        className="text-xs text-muted hover:text-secondary transition-colors"
                      >
                        {expandedError === p.id ? '▼' : '▶'} last error
                      </button>
                      {expandedError === p.id && (
                        <div className="mt-1 text-xs text-error/80 font-mono bg-bg-base/40 rounded p-2">
                          {p.last_error}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* DB usage */}
      <section className="mb-10">
        <h2 className="text-sm font-medium text-secondary mb-3">DB / Storage Usage</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {dbUsage?.current.length ? (
            dbUsage.current.map((d) => {
              const trend = dbUsage.trend.find((t) => t.db_name === d.db_name);
              const prev = trend && trend.points.length > 1 ? trend.points[trend.points.length - 2] : null;
              const curr = trend && trend.points.length > 0 ? trend.points[trend.points.length - 1] : null;
              const sizeDelta = prev && curr && prev.size_bytes != null && curr.size_bytes != null
                ? curr.size_bytes - prev.size_bytes
                : null;
              return (
                <div key={d.db_name} className="admin-card p-4">
                  <div className="text-xs text-muted mb-1">{d.db_name}</div>
                  <div className="font-mono tabular text-lg text-primary">{formatBytes(d.size_bytes)}</div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted">
                    <span className="font-mono tabular">{d.rows_or_objects ?? '—'} rows/objs</span>
                    {sizeDelta != null && (
                      <span className={sizeDelta > 0 ? 'text-success' : sizeDelta < 0 ? 'text-error' : 'text-muted'}>
                        {sizeDelta > 0 ? '↑' : sizeDelta < 0 ? '↓' : '→'} {formatBytes(Math.abs(sizeDelta))}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="admin-card p-4 text-sm text-muted col-span-full text-center">
              No DB usage snapshots. Insert via helper to populate.
            </div>
          )}
        </div>
      </section>

      {/* Scrape log */}
      <section>
        <h2 className="text-sm font-medium text-secondary mb-3">Scrape Log · latest 30</h2>
        <div className="border border-subtle rounded-lg bg-card max-h-[60vh] overflow-y-auto">
          {scrapeLogs.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted text-center">
              No scrape jobs logged. Run scraper with hooks to populate.
            </div>
          ) : (
            scrapeLogs.map((log) => {
              const isFailed = log.status === 'failed' || log.status === 'partial';
              return (
                <div key={log.id} className="border-b border-subtle last:border-0">
                  <div className="grid grid-cols-12 gap-2 px-4 py-2.5 items-center text-sm hover:bg-bg-secondary/30 transition-colors">
                    <div className="col-span-3 flex items-center gap-2">
                      <span className={`status-dot ${isFailed ? 'down' : 'healthy'}`} />
                      <span className="text-primary font-medium">{log.source}</span>
                    </div>
                    <div className="col-span-2 text-xs text-muted">{log.status}</div>
                    <div className="col-span-2 text-right font-mono tabular text-xs text-secondary">
                      {log.duration_ms != null ? `${log.duration_ms}ms` : '—'}
                    </div>
                    <div className="col-span-2 text-right font-mono tabular text-xs text-secondary">
                      {log.items_scraped} items
                    </div>
                    <div className="col-span-3 text-right text-xs text-muted">{formatRelative(log.started_at)}</div>
                  </div>
                  {isFailed && log.error_message && (
                    <div className="px-4 pb-2">
                      <button
                        onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                        className="text-xs text-muted hover:text-secondary transition-colors"
                      >
                        {expandedLog === log.id ? '▼' : '▶'} error
                      </button>
                      {expandedLog === log.id && (
                        <div className="mt-1 text-xs text-error/80 font-mono bg-bg-base/40 rounded p-2">
                          {log.error_message}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </main>
  );
}
