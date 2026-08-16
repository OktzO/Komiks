'use client';
export const runtime = 'edge';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fetchMe, apiGet, roleLabel, type AuthUser } from '@/lib/api';

type Overview = {
  usersTotal: number;
  bookmarksTotal: number;
  scrape24h: { success: number; failed: number };
  providers: { healthy: number; degraded: number; down: number };
};

// Lightweight SVG sparkline — no external chart library needed (keeps bundle
// small, avoids CSP issues). Renders up to 30 data points as a bar chart.
function Sparkline({ data, label }: { data: number[]; label: string }) {
  if (data.length === 0) {
    return (
      <div className="admin-card p-6">
        <p className="text-xs text-muted mb-3">{label}</p>
        <div className="h-12 flex items-center text-xs text-muted">No data yet</div>
      </div>
    );
  }
  const max = Math.max(...data, 1);
  return (
    <div className="admin-card p-6">
      <p className="text-xs text-muted mb-3">{label}</p>
      <div className="h-16 flex items-end gap-1">
        {data.map((v, i) => (
          <div
            key={i}
            className="flex-1 bg-accent/60 rounded-sm min-w-[2px] transition-all hover:bg-accent"
            style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
            title={`${v}`}
          />
        ))}
      </div>
      <p className="text-xs text-muted mt-2">
        {data.reduce((a, b) => a + b, 0)} total · last {data.length}h
      </p>
    </div>
  );
}

function StatCard({ label, value, sublabel, refreshing }: { label: string; value: string; sublabel?: string; refreshing: boolean }) {
  return (
    <div className="admin-card p-4">
      <div className={`font-mono tabular text-2xl text-primary num-refresh ${refreshing ? 'refreshing' : ''}`}>
        {value}
      </div>
      <p className="text-xs text-muted mt-1">
        {label}
        {sublabel ? ` · ${sublabel}` : ''}
      </p>
    </div>
  );
}

export default function AdminOverviewPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [scrapeTrend, setScrapeTrend] = useState<number[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchMe().then((u) => {
      setUser(u);
      setLoading(false);
      if (!u || u.role !== 'admin') router.replace('/');
    });
  }, [router]);

  const loadOverview = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiGet<{ data: Overview }>('/api/admin/overview');
      setOverview(res.data);
      setError(null);

      // Fetch scrape jobs for the trend chart (last 24h, bucketed by hour).
      try {
        const jobsRes = await apiGet<{ data: Array<{ started_at: number; status: string }> }>('/api/admin/scrape-jobs?limit=200');
        const jobs = jobsRes.data || [];
        const now = Math.floor(Date.now() / 1000);
        const buckets = new Array(24).fill(0);
        for (const j of jobs) {
          const hourAgo = Math.floor((now - j.started_at) / 3600);
          if (hourAgo >= 0 && hourAgo < 24) buckets[23 - hourAgo]++;
        }
        setScrapeTrend(buckets);
      } catch {
        // Scrape trend is best-effort — overview still works without it.
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') {
      loadOverview();
      // 30s refresh — less aggressive than 12s, reduces KV/API load while
      // still feeling live. The status dot still pulses to show activity.
      const interval = setInterval(loadOverview, 30000);
      return () => clearInterval(interval);
    }
  }, [user, loadOverview]);

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 w-full rounded-lg bg-card" />
          ))}
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') return null;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-primary">Admin Overview</h1>
          <p className="text-sm text-muted mt-1">
            {user.email} · {roleLabel(user.role)}
          </p>
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard label="Users" value={overview ? String(overview.usersTotal) : '—'} refreshing={refreshing} />
        <StatCard label="Bookmarks" value={overview ? String(overview.bookmarksTotal) : '—'} refreshing={refreshing} />
        <StatCard
          label="Scrape · 24h"
          value={overview ? `${overview.scrape24h.success}/${overview.scrape24h.failed}` : '—'}
          sublabel="success/failed"
          refreshing={refreshing}
        />
        <div className="admin-card p-4">
          <div className="flex items-center gap-3 mb-1">
            <span className="status-dot healthy" />
            <span className={`font-mono tabular text-2xl text-primary num-refresh ${refreshing ? 'refreshing' : ''}`}>
              {overview ? overview.providers.healthy : '—'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="status-dot degraded" />
            <span className="font-mono tabular">{overview ? overview.providers.degraded : '—'}</span>
            <span className="status-dot down" />
            <span className="font-mono tabular">{overview ? overview.providers.down : '—'}</span>
          </div>
          <p className="text-xs text-muted mt-2">Providers · healthy/degraded/down</p>
        </div>
      </div>

      <nav className="flex gap-2 mb-8">
        <Link href="/admin/monitoring" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">
          Monitoring →
        </Link>
        <Link href="/admin/users" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">
          Users →
        </Link>
        <Link href="/admin/merge" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">
          Merge Queue →
        </Link>
        <Link href="/admin/settings" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">
          Settings →
        </Link>
      </nav>

      <Sparkline data={scrapeTrend} label="Scrape runs · 24h trend" />
    </main>
  );
}
