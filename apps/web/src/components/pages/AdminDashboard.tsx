'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchMe, apiGet, roleLabel, type AuthUser } from '@/lib/api';
import { Card, CardHead, StatCard, fmtNum, fmtBytes } from '@/components/admin/charts';

/* ─────────────────────────────────────────────────────────────────────
 * Types (mirror API response shapes)
 * ───────────────────────────────────────────────────────────────────── */

type Overview = {
  usersTotal: number;
  bookmarksTotal: number;
  scrape24h: { success: number; failed: number };
  providers: { healthy: number; degraded: number; down: number };
};

type StoragePoint = { ts: number; size_bytes: number | null; rows_or_objects: number | null };
type StorageTrend = { db_name: string; points: StoragePoint[] };
type StorageData = {
  accounts: Array<{ idx: number; name: string; bucket: string; bytes: number; quota: number }>;
  total_bytes: number;
  d1_bytes: number | null;
  quota: number;
  trend: StorageTrend[];
};

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

type ReqData = { dates: string[]; series: Array<{ origin: string; points: number[] }> };

type LbAccount = { id: string; provider: string; label: string; account_ref: string | null; token_last4: string; status: string; created_at: number };
type LbOrigin = { id: string; account_id: string | null; origin_url: string; priority: number; weight: number; enabled: number; last_health_status: string | null; last_checked_at: number | null };

type UserRow = { id: number; email: string; name: string | null; role: string; status: string; created_at: number; last_login_at: number | null; bookmark_count: number };

/* ─────────────────────────────────────────────────────────────────────
 * Format helpers — fmtBytes/fmtNum dari modul admin/charts
 * ───────────────────────────────────────────────────────────────────── */

const fmtRel = (ts: number | null): string => {
  if (!ts) return 'belum pernah';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 60) return `${d} detik lalu`;
  if (d < 3600) return `${Math.floor(d / 60)} mnt lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)} jam lalu`;
  return `${Math.floor(d / 86400)} hari lalu`;
};

const fmtDay = (ts: number): string =>
  new Date(ts * 1000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });

/* ─────────────────────────────────────────────────────────────────────
 * Ikon kecil stroke (pola IconBook di AdminSaved)
 * ───────────────────────────────────────────────────────────────────── */

function IconDb({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}
function IconBook({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 15v-4M12 15V7M17 15v-7" />
    </svg>
  );
}
function IconPulse({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h4l3-9 4 18 3-9h6" />
    </svg>
  );
}
function IconZap({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}
function IconUsers({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconServer({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Mini chart primitives (custom SVG — no chart lib, no CSP issues)
 * ───────────────────────────────────────────────────────────────────── */

// Area chart with hover tooltip. points: [{ts, value}].
function AreaChart({ points, height = 180 }: { points: Array<{ ts: number; value: number }>; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const { w, h } = { w: 640, h: height };
  const padX = 8;
  const padY = 24;
  if (points.length < 2) {
    return (
      <div className="h-[180px] flex items-center justify-center text-xs text-muted">
        Snapshot belum cukup — isi bertambah tiap jam (perlu ≥ 2 titik).
      </div>
    );
  }
  const max = Math.max(...points.map((p) => p.value), 1);
  const iw = w - padX * 2;
  const ih = h - padY * 2;
  const x = (i: number) => padX + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => padY + ih - (v / max) * ih;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)},${(padY + ih).toFixed(1)} L${x(0).toFixed(1)},${(padY + ih).toFixed(1)} Z`;
  const gid = `grad-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }} preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={padX} x2={w - padX} y1={padY + ih * f} y2={padY + ih * f}
            stroke="var(--border-subtle)" strokeWidth="1" strokeDasharray="3 4" />
        ))}
        <path d={area} fill={`url(#${gid})`} />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r="3" fill="var(--accent)"
            fillOpacity={hover === i ? 1 : 0}
            stroke="var(--bg-base)" strokeWidth="1.5" />
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padY} y2={padY + ih} stroke="var(--accent)" strokeOpacity="0.4" strokeDasharray="2 3" />
            <circle cx={x(hover)} cy={y(points[hover].value)} r="4" fill="var(--accent)" stroke="var(--bg-base)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {/* Tooltip + axis labels (HTML layer, avoids SVG text reflow) */}
      <div className="pointer-events-none absolute inset-0 flex items-end" style={{ paddingBottom: 4 }}>
        {hover !== null ? (
          <div className="absolute -translate-x-1/2 bg-elevated border border-border-default rounded-lg px-3 py-2 text-[11px] shadow-xl"
            style={{ left: `${(x(hover) / w) * 100}%`, bottom: '100%', marginBottom: 6 }}>
            <div className="text-muted font-mono tabular">{fmtDay(points[hover].ts)}</div>
            <div className="text-primary font-mono tabular">{fmtBytes(points[hover].value)}</div>
          </div>
        ) : null}
      </div>
      {/* hit area for hover */}
      <div className="absolute inset-0 flex">
        {points.map((p, i) => (
          <div key={i} className="flex-1 h-full" onMouseEnter={() => setHover(i)} />
        ))}
      </div>
    </div>
  );
}

// Stacked bars per day (request counts per origin).
function ReqBars({ data, height = 160 }: { data: ReqData; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const h = height;
  if (!data.dates.length || data.series.length === 0) {
    return <div className="h-[160px] flex items-center justify-center text-xs text-muted">Belum ada request tercatat.</div>;
  }
  const perDay = data.dates.map((_, i) => data.series.reduce((a, s) => a + (s.points[i] ?? 0), 0));
  const max = Math.max(...perDay, 1);
  const palette = ['var(--accent)', 'var(--success)', 'oklch(70% 0.12 75)', 'var(--text-secondary)'];
  return (
    <div className="relative">
      <div className="flex items-end gap-[3px]" style={{ height: h }}
        onMouseLeave={() => setHover(null)}>
        {perDay.map((total, i) => (
          <div key={i} className="flex-1 flex flex-col justify-end rounded-sm overflow-hidden min-w-[4px] group"
            onMouseEnter={() => setHover(i)} style={{ height: '100%' }}>
            <div style={{ height: `${Math.max(3, (total / max) * 100)}%` }} className="flex flex-col justify-end">
              {data.series.map((s, si) => {
                const v = s.points[i] ?? 0;
                if (v === 0) return null;
                const segH = (v / total) * 100;
                return (
                  <div key={si} style={{ height: `${segH}%`, background: palette[si % palette.length] }} />
                );
              })}
              {total === 0 && <div style={{ height: 3, background: 'var(--border-subtle)' }} />}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-1.5">
        {data.dates.map((d, i) => (
          <div key={i} className="text-[10px] text-muted font-mono tabular" style={{ display: i % Math.max(1, Math.ceil(data.dates.length / 7)) === 0 ? 'block' : 'none' }}>
            {d.slice(5)}
          </div>
        ))}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 -top-2 -translate-y-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-[11px] shadow-xl whitespace-nowrap">
          <div className="text-muted">{data.dates[hover]}</div>
          {data.series.map((s, si) => (
            <div key={si} className="flex items-center gap-1.5 font-mono tabular text-primary">
              <span style={{ background: palette[si % palette.length] }} className="w-1.5 h-1.5 rounded-full inline-block" />
              {s.origin.replace('https://', '')} · {fmtNum(s.points[hover] ?? 0)}
            </div>
          ))}
          <div className="border-t border-border-default mt-1 pt-1 font-mono tabular text-secondary">Total · {fmtNum(perDay[hover])}</div>
        </div>
      )}
    </div>
  );
}

// Semicircle gauge.
function Gauge({ value, label, sub }: { value: number; label: string; sub: string }) {
  const r = 62;
  const cx = 80;
  const cy = 78;
  const clamp = Math.max(0, Math.min(100, value));
  const angle = (clamp / 100) * Math.PI;
  const arc = (a0: number, a1: number) => {
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy - r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 160 88" className="w-40">
        <path d={arc(0, Math.PI)} fill="none" stroke="var(--border-subtle)" strokeWidth="9" strokeLinecap="round" />
        <path d={arc(0, angle)} fill="none" stroke="var(--accent)" strokeWidth="9" strokeLinecap="round" />
        <text x={cx} y={cy - 4} textAnchor="middle" className="fill-[var(--text-primary)]" style={{ fontSize: 22, fontWeight: 600 }}>
          {clamp.toFixed(1)}%
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--text-muted)" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.14em' }}>
          {label}
        </text>
      </svg>
      <div className="text-xs text-muted -mt-1">{sub}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Status badge
 * ───────────────────────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'text-success border-success/30 bg-success/10',
    suspended: 'text-[oklch(70%_0.12_75)] border-[oklch(70%_0.12_75)]/30 bg-[oklch(70%_0.12_75)]/10',
    banned: 'text-error border-error/30 bg-error/10',
    verified: 'text-success border-success/30 bg-success/10',
    unverified: 'text-secondary border-border-default',
    failed: 'text-error border-error/30 bg-error/10',
    healthy: 'text-success border-success/30 bg-success/10',
    degraded: 'text-[oklch(70%_0.12_75)] border-[oklch(70%_0.12_75)]/30 bg-[oklch(70%_0.12_75)]/10',
    down: 'text-error border-error/30 bg-error/10',
    unhealthy: 'text-error border-error/30 bg-error/10',
  };
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${map[status] ?? 'text-secondary border-border-default'}`}>
      {status}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Dashboard
 * ───────────────────────────────────────────────────────────────────── */

const SOURCES: Record<string, string> = {
  komiku: 'Komiku',
  bacakomik: 'BacaKomik',
  thrive: 'Thrive',
  manhwaindo: 'ManhwaIndo',
  shinigami: 'Shinigami',
};

export default function AdminDashboardPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [storage, setStorage] = useState<StorageData | null>(null);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [requests, setRequests] = useState<ReqData | null>(null);
  const [lbAccounts, setLbAccounts] = useState<LbAccount[]>([]);
  const [lbOrigins, setLbOrigins] = useState<LbOrigin[]>([]);
  const [lbUsage, setLbUsage] = useState<Array<{ origin_url: string; req_count: number }>>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [savedChapters, setSavedChapters] = useState(0);

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
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const [ov, st, sh, rq, a, o, us, sv] = await Promise.all([
        apiGet<{ data: Overview }>('/api/admin/overview'),
        apiGet<{ data: StorageData }>('/api/admin/dashboard/storage'),
        apiGet<{ data: SourceHealth[] }>('/api/admin/dashboard/source-health'),
        apiGet<{ data: ReqData }>('/api/admin/dashboard/requests?days=14'),
        apiGet<LbAccount[]>('/api/admin/lb/accounts'),
        apiGet<{ data: LbOrigin[] }>('/api/admin/lb/origins'),
        apiGet<{ data: UserRow[]; total: number }>('/api/admin/users?limit=2000'),
        apiGet<{ data: { summary: { chapters_total: number } } }>('/api/admin/saved?page=1&limit=1'),
      ]);
      setOverview(ov.data);
      setStorage(st.data);
      setSources(sh.data || []);
      setRequests(rq.data);
      setLbAccounts(a || []);
      setLbOrigins(o.data || []);
      setUsers(us.data || []);
      setUsersTotal(us.total);
      setSavedChapters(sv.data?.summary?.chapters_total ?? 0);
      setLbUsage((await apiGet<{ data: Array<{ origin_url: string; req_count: number }> }>('/api/admin/lb/usage')).data || []);
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
      const iv = setInterval(loadAll, 30000);
      return () => clearInterval(iv);
    }
  }, [user, loadAll]);

  // Derived numbers
  const storageTotal = storage?.total_bytes ?? 0;
  const storageQuota = storage?.accounts.reduce((a, x) => a + x.quota, 0) || 1;
  const storagePct = (storageTotal / storageQuota) * 100;

  const avgUptime = useMemo(() => {
    const vals = sources.filter((s) => s.uptime_pct != null).map((s) => s.uptime_pct as number);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
  }, [sources]);

  const scrapeTotal = (overview?.scrape24h.success ?? 0) + (overview?.scrape24h.failed ?? 0);
  const scrapeRate = scrapeTotal > 0 ? Math.round((overview!.scrape24h.success / scrapeTotal) * 100) : 0;

  const users7d = useMemo(() => {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    return users.filter((u) => u.created_at >= since).length;
  }, [users]);

  const reqTotal7d = useMemo(
    () => requests?.series.reduce((a, s) => a + s.points.reduce((b, p) => b + p, 0), 0) ?? 0,
    [requests]
  );

  // Storage trend: total per timestamp across all b2:* accounts
  const storageSeries = useMemo(() => {
    if (!storage) return [];
    const b2 = storage.trend.filter((t) => t.db_name.startsWith('b2:'));
    const byTs = new Map<number, number>();
    for (const t of b2) {
      for (const p of t.points) {
        if (p.size_bytes == null) continue;
        byTs.set(p.ts, (byTs.get(p.ts) ?? 0) + p.size_bytes);
      }
    }
    return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, value]) => ({ ts, value }));
  }, [storage]);

  if (loading) {
    return (
      <div className="admin-page space-y-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-56 rounded-2xl bg-elevated" />
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">{[...Array(6)].map((_, i) => <div key={i} className="h-28 rounded-2xl bg-elevated" />)}</div>
          <div className="h-64 rounded-2xl bg-elevated" />
        </div>
      </div>
    );
  }
  if (!user || user.role !== 'admin') return null;

  return (
    <div className="admin-page space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-primary">Dashboard</h1>
          <p className="text-[13px] text-muted mt-1">{user.email} · {roleLabel(user.role)}</p>
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className={`status-dot ${refreshing ? 'live' : 'unknown'}`} />
          {refreshing ? 'refreshing' : 'live'}
        </span>
      </div>

      {error && (
        <div className="text-sm text-error border border-error/40 rounded-lg p-3 bg-error/5">{error}</div>
      )}

      {/* ── A. Top KPI strip ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard icon={<IconDb className="w-4 h-4" />} label="Storage · B2" value={fmtBytes(storageTotal)}
          sub={`${storagePct.toFixed(1)}% dari ${fmtBytes(storageQuota)} quota`} />
        <StatCard icon={<IconBook className="w-4 h-4" />} label="Konten tersimpan" value={fmtNum(savedChapters)}
          sub="chapter tersimpan · lihat halaman Konten" />
        <StatCard icon={<IconChart className="w-4 h-4" />} label="Request · 14d" value={fmtNum(reqTotal7d)}
          sub={`${requests?.series.length ?? 0} origin terlayani`} />
        <StatCard icon={<IconPulse className="w-4 h-4" />} label="Source uptime" value={avgUptime > 0 ? `${avgUptime}%` : '—'}
          sub={`${sources.length} source dipantau`} />
        <StatCard icon={<IconZap className="w-4 h-4" />} label="Scrape · 24h" value={scrapeTotal > 0 ? `${scrapeRate}%` : '—'}
          sub={scrapeTotal > 0 ? `${overview!.scrape24h.success}/${scrapeTotal} sukses` : 'belum ada aktivitas'} />
        <StatCard icon={<IconUsers className="w-4 h-4" />} label="Users" value={fmtNum(usersTotal)}
          sub={`+${users7d} minggu ini`} />
      </div>

      {/* ── B + C row ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card delay={40} className="lg:col-span-2">
          <CardHead icon={<IconDb className="w-4 h-4" />} title="Storage trend · B2" hint="Snapshot tiap jam · 30 hari terakhir" />
          <AreaChart points={storageSeries} />
          <div className="flex items-center justify-between mt-3 text-[11px] text-muted">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[var(--accent)]" /> Total usage</span>
            <span>{storage?.accounts.map((a) => a.name).join(' + ') || '—'}</span>
          </div>
        </Card>

        <Card delay={80}>
          <CardHead icon={<IconPulse className="w-4 h-4" />} title="Source health" hint="Uptime dari riwayat pengecekan" />
          {sources.length === 0 ? (
            <div className="text-xs text-muted text-center py-8">Belum ada data health. Tercatat pasif saat aktivitas baca.</div>
          ) : (
            <div className="space-y-3">
              {sources.map((s) => {
                const pct = s.uptime_pct ?? 0;
                const tone = pct >= 95 ? 'var(--success)' : pct >= 70 ? 'oklch(70% 0.12 75)' : 'var(--error)';
                return (
                  <div key={s.source}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-primary font-medium">{SOURCES[s.source] ?? s.source}</span>
                      <span className="font-mono tabular text-secondary">{pct.toFixed(1)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[var(--border-subtle)] overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
                    </div>
                    <div className="flex justify-between mt-1 text-[10px] text-muted">
                      <span>↑ {s.last_healthy ? fmtRel(s.last_healthy) : '—'}</span>
                      <span>{fmtNum(s.chapters_7d)} chapter · 7d</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ── D + E + requests row ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <Card delay={120} className="flex flex-col items-center justify-center">
          <CardHead title="Sistem" hint="Uptime gabungan source" />
          <Gauge value={avgUptime} label="uptime" sub={`${fmtNum(reqTotal7d)} request · 14d`} />
        </Card>

        <Card delay={160} className="lg:col-span-3">
          <CardHead icon={<IconChart className="w-4 h-4" />} title="Request per origin" hint="Real request count (lb_usage) · bukan bandwidth bytes" />
          {requests ? <ReqBars data={requests} /> : <div className="h-[160px] flex items-center justify-center text-xs text-muted">—</div>}
        </Card>
      </div>

      {/* ── E. LB accounts ───────────────────────────────────────────────── */}
      <Card delay={200} className="overflow-hidden">
        <CardHead icon={<IconServer className="w-4 h-4" />} title="Load balancer accounts"
          hint="Round-robin worker · status akun + health origin + request hari ini"
          action={<a href="/admin/settings" className="text-xs text-secondary hover:text-accent transition-colors">Kelola →</a>} />
        {lbAccounts.length === 0 ? (
          <div className="admin-inner py-8 text-sm text-muted text-center">Belum ada akun.</div>
        ) : (
          <div className="admin-inner overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.12em] text-muted border-b border-border-subtle">
                    <th className="text-left font-medium px-4 py-2">Akun</th>
                    <th className="text-left font-medium px-3 py-2">Provider</th>
                    <th className="text-left font-medium px-3 py-2">Status</th>
                    <th className="text-left font-medium px-3 py-2">Origin</th>
                    <th className="text-right font-medium px-4 py-2">Req hari ini</th>
                  </tr>
                </thead>
                <tbody>
                  {lbAccounts.map((a) => {
                    const origins = lbOrigins.filter((o) => o.account_id === a.id);
                    const req = lbUsage.filter((u) => origins.some((o) => o.origin_url === u.origin_url)).reduce((x, u) => x + u.req_count, 0);
                    return (
                      <tr key={a.id} className="border-b border-border-subtle last:border-0 hover:bg-bg-secondary/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="text-primary">{a.label}</div>
                          <div className="text-[10px] text-muted font-mono">{a.id}</div>
                        </td>
                        <td className="px-3 py-3 text-secondary">{a.provider}</td>
                        <td className="px-3 py-3"><StatusBadge status={a.status} /></td>
                        <td className="px-3 py-3">
                          {origins.length === 0 ? <span className="text-xs text-muted">—</span> : (
                            <div className="flex flex-col gap-0.5">
                              {origins.map((o) => (
                                <div key={o.id} className="flex items-center gap-1.5 text-xs">
                                  <span className={`status-dot ${o.last_health_status === 'healthy' ? 'healthy' : o.last_health_status === 'unhealthy' ? 'down' : 'unknown'}`} />
                                  <span className="text-secondary truncate max-w-[220px]">{o.origin_url.replace('https://', '')}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular text-primary">{fmtNum(req)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* ── F + G row ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card delay={240} className="overflow-hidden">
          <CardHead icon={<IconUsers className="w-4 h-4" />} title="Users terbaru"
            hint={`${fmtNum(usersTotal)} total · +${users7d} minggu ini`}
            action={<a href="/admin/users" className="text-xs text-secondary hover:text-accent transition-colors">Kelola →</a>} />
          <div className="admin-inner overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {users.slice(0, 7).map((u) => (
                  <tr key={u.id} className="border-b border-border-subtle last:border-0 hover:bg-bg-secondary/20 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="text-primary truncate">{u.name || u.email}</div>
                      <div className="text-[10px] text-muted truncate">{u.email}</div>
                    </td>
                    <td className="px-2 py-2.5"><StatusBadge status={u.status} /></td>
                    <td className="px-2 py-2.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${u.role === 'admin' ? 'border-accent/40 text-accent' : 'border-border-default text-secondary'}`}>
                        {roleLabel(u.role)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-[11px] text-muted">{fmtRel(u.last_login_at)}</td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td className="px-4 py-6 text-sm text-muted text-center">Belum ada user.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* nav links */}
      <nav className="flex flex-wrap gap-2">
        <a href="/admin/monitoring" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">Monitoring →</a>
        <a href="/admin/users" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">Users →</a>
        <a href="/admin/saved" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">Konten →</a>
        <a href="/admin/log" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">Log →</a>
        <a href="/admin/settings" className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors">Settings →</a>
      </nav>
    </div>
  );
}