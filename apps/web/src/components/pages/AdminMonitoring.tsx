'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchMe, apiGet, type AuthUser } from '@/lib/api';
import type { AdminInventory } from '@manga-platform/shared/types';
import { Card, CardHead, EmptyState, fmtNum, fmtBytes } from '@/components/admin/charts';
import { D1Section, InventoryWarningBanner, KVSection } from '@/components/admin/InventorySections';
import { filterInventory, inventoryUrl, nonD1SnapshotRows } from '@/lib/adminInventory';
import { useAdminRefresh } from '@/lib/useAdminRefresh';

type DbUsageCurrent = { db_name: string; rows_or_objects: number | null; size_bytes: number | null };
type DbUsagePoint = { ts: number; size_bytes: number | null; rows_or_objects: number | null };
type DbUsageTrend = { db_name: string; points: DbUsagePoint[] };
type DbUsage = { current: DbUsageCurrent[]; trend: DbUsageTrend[] };

type SourceHealth = {
  source: string;
  total: number;
  healthy: number;
  uptime_pct: number | null;
  last_checked_at: number | null;
  last_healthy: number | null;
  last_down: number | null;
  chapters_7d: number;
  last_scrape_7d: number | null;
};

type ScrapeLogRow = {
  ts: number;
  type: 'scrape';
  actor: string | null;
  message: string;
  meta: { id: string; source: string; status: string; series_slug: string | null; error: string | null };
};

function formatRelative(ts: number | null): string {
  if (!ts) return 'belum pernah';
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diffSec < 60) return `${diffSec} detik lalu`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} menit lalu`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} jam lalu`;
  return `${Math.floor(diffSec / 86400)} hari lalu`;
}

const SOURCE_NAMES: Record<string, string> = {
  komiku: 'Komiku',
  bacakomik: 'BacaKomik',
  thrive: 'Thrive',
  manhwaindo: 'ManhwaIndo',
  shinigami: 'Shinigami',
};

function IconActivity({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function IconDatabase({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}

export default function AdminMonitoringPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [inventory, setInventory] = useState<AdminInventory | null>(null);
  const [dbUsage, setDbUsage] = useState<DbUsage | null>(null);
  const [logRows, setLogRows] = useState<ScrapeLogRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

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

  const loadAll = useCallback(async (forceRefresh = false) => {
    setRefreshing(true);
    const [hRes, invRes, dRes, lRes] = await Promise.allSettled([
      apiGet<{ data: SourceHealth[] }>('/api/admin/dashboard/source-health'),
      apiGet<{ data: AdminInventory }>(inventoryUrl(forceRefresh)),
      apiGet<{ data: DbUsage }>('/api/admin/db-usage?days=7'),
      apiGet<{ data: { rows: ScrapeLogRow[] } }>('/api/admin/log?type=scrape&limit=30'),
    ]);
    setSources(hRes.status === 'fulfilled' ? (hRes.value.data ?? []) : []);
    if (invRes.status === 'fulfilled' && invRes.value.data) {
      setInventory(invRes.value.data);
      setInventoryError(null);
    } else {
      setInventoryError('Inventaris gagal dimuat — panel lain tetap ditampilkan.');
    }
    setDbUsage(dRes.status === 'fulfilled' ? dRes.value.data : null);
    setLogRows(lRes.status === 'fulfilled' ? (lRes.value.data.rows ?? []) : []);
    setRefreshing(false);
  }, []);

  const refresh = useAdminRefresh(loadAll, user?.role === 'admin');

  const view = useMemo(() => filterInventory(inventory, ''), [inventory]);
  const snapshotRows = useMemo(() => nonD1SnapshotRows(dbUsage?.current), [dbUsage]);

  if (loading) {
    return (
      <div className="admin-page space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-16 w-full rounded-2xl bg-elevated animate-pulse" />
        ))}
      </div>
    );
  }

  if (!user || user.role !== 'admin') return null;

  return (
    <div className="admin-page space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-primary">Monitoring</h1>
          <p className="text-[13px] text-muted mt-1">Source health · storage · scrape jobs live</p>
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className={`status-dot ${refreshing ? 'live' : 'unknown'}`} />
          {refreshing ? 'refreshing' : 'live'}
        </span>
        <button
          type="button"
          onClick={() => refresh(true)}
          disabled={refreshing}
          className="px-3 py-1.5 text-xs text-secondary border border-border-default rounded-full hover:bg-bg-secondary transition-colors disabled:opacity-50"
        >
          {refreshing ? 'Memuat...' : 'Muat ulang'}
        </button>
      </div>

      {inventoryError && (
        <div role="alert" aria-live="assertive" className="text-sm text-error border border-error/40 rounded-lg p-3 bg-error/5">
          {inventoryError}
        </div>
      )}

      <InventoryWarningBanner warnings={view.warnings} stale={view.stale} observedAt={view.observedAt} />

      <Card>
        <CardHead icon={<IconActivity className="w-4 h-4" />} title="Source health" hint="Uptime dari riwayat pengecekan" />
        {sources.length === 0 ? (
          <EmptyState>Belum ada data health. Tercatat pasif saat aktivitas baca.</EmptyState>
        ) : (
          <div className="space-y-3">
            {sources.map((s) => {
              const pct = s.uptime_pct ?? 0;
              const tone = pct >= 95 ? 'var(--success)' : pct >= 70 ? 'oklch(70% 0.12 75)' : 'var(--error)';
              return (
                <div key={s.source}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-primary font-medium">{SOURCE_NAMES[s.source] ?? s.source}</span>
                    <span className="font-mono tabular text-secondary">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--border-subtle)] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
                  </div>
                  <div className="flex justify-between mt-1 text-[10px] text-muted">
                    <span>↑ {s.last_healthy ? formatRelative(s.last_healthy) : '—'}</span>
                    <span>{fmtNum(s.chapters_7d)} chapter · 7d</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <CardHead icon={<IconDatabase className="w-4 h-4" />} title="Snapshot lokal" hint="db_usage_snapshot tiap jam · hanya B2, ukuran D1 tampil di section D1" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {snapshotRows.length ? snapshotRows.map((d) => {
            const trend = dbUsage?.trend.find((t) => t.db_name === d.db_name);
            const prev = trend && trend.points.length > 1 ? trend.points[trend.points.length - 2] : null;
            const curr = trend && trend.points.length > 0 ? trend.points[trend.points.length - 1] : null;
            const sizeDelta = prev && curr && prev.size_bytes != null && curr.size_bytes != null
              ? curr.size_bytes - prev.size_bytes : null;
            return (
              <div key={d.db_name} className="admin-inner p-4">
                <div className="text-[11px] text-muted mb-1 truncate">{d.db_name}</div>
                <div className="font-mono tabular text-lg text-primary">{fmtBytes(d.size_bytes)}</div>
                <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted">
                  <span className="font-mono tabular">{d.rows_or_objects ?? '—'} rows/obj</span>
                  {sizeDelta != null && (
                    <span className={sizeDelta > 0 ? 'text-success' : sizeDelta < 0 ? 'text-error' : 'text-muted'}>
                      {sizeDelta > 0 ? '↑' : sizeDelta < 0 ? '↓' : '→'} {fmtBytes(Math.abs(sizeDelta))}
                    </span>
                  )}
                </div>
              </div>
            );
          }) : <EmptyState>Belum ada snapshot B2. Terisi tiap jam oleh cron.</EmptyState>}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <D1Section view={view} />
        <KVSection view={view} />
      </div>

      <Card>
        <CardHead icon={<IconActivity className="w-4 h-4" />} title="Scrape jobs live" hint="scrape_jobs · refresh 30 detik" />
        {logRows.length === 0 ? (
          <EmptyState>Belum ada job scrape aktif. Jalankan scraper dulu.</EmptyState>
        ) : (
          <div className="admin-inner divide-y divide-border-subtle overflow-hidden">
            {logRows.map((r) => {
              const failed = r.meta.status === 'failed' || r.meta.status === 'skipped_robots';
              return (
                <div key={r.meta.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={`status-dot shrink-0 ${failed ? 'down' : r.meta.status === 'running' ? 'live' : 'healthy'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-primary truncate">{r.message}</p>
                    {r.meta.series_slug && <p className="text-[11px] text-muted truncate">{r.meta.series_slug}</p>}
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize shrink-0 ${failed ? 'text-error border-error/30 bg-error/10' : r.meta.status === 'running' ? 'text-accent border-accent/30 bg-accent/10' : 'text-secondary border-border-default'}`}>
                    {r.meta.status}
                  </span>
                  <span className="text-[11px] text-muted font-mono tabular shrink-0">{formatRelative(r.ts)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}