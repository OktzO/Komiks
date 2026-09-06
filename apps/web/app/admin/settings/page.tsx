'use client';
import { useState, useEffect, useRef, useCallback, useMemo, useId } from 'react';
import { useRouter } from 'next/navigation';
import { fetchMe, apiGet, apiPost, getAuthApiUrl, roleLabel, type AuthUser } from '@/lib/api';

/* ═══════════════════════════════════════════════════════════════════════
 * Types — mirror the exact API response shapes.
 *
 * NOTE ON ENVELOPES: several admin endpoints return a BARE payload
 * (no `{ data }` wrapper): lb/settings, lb/accounts, lb/origins,
 * scrape-jobs, security-events, users. Others ARE wrapped.
 * See apps/api-cf/src/routes/admin/*.ts. Do not "unify" these blindly.
 * ═══════════════════════════════════════════════════════════════════════ */

type Overview = {
  usersTotal: number;
  bookmarksTotal: number;
  scrape24h: { success: number; failed: number };
  providers: { healthy: number; degraded: number; down: number };
};

type StoragePoint = { ts: number; size_bytes: number | null; rows_or_objects: number | null };
type StorageData = {
  accounts: Array<{ idx: number; name: string; bucket: string; bytes: number; quota: number }>;
  total_bytes: number;
  d1_bytes: number | null;
  quota: number;
  trend: Array<{ db_name: string; points: StoragePoint[] }>;
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

type SecEvent = {
  id: number;
  type: string;
  severity: string;
  message: string | null;
  ip: string | null;
  path: string | null;
  resolved: number;
  created_at: number;
  resolved_at: number | null;
};

type LbSettings = {
  id?: number;
  mode?: 'off' | 'on';
  implementation?: 'native_cf' | 'custom';
  steering_policy?: string;
  health_check_interval_sec?: number;
  health_check_timeout_ms?: number;
  failure_threshold?: number;
};

type LbAccount = {
  id: string;
  provider: string;
  label: string;
  account_ref: string | null;
  token_last4: string;
  status: string;
  created_at: number;
};

/** `/lb/origins` returns `enabled` as 0|1 (raw row). `/lb/status` returns boolean. */
type LbOrigin = {
  id: string;
  account_id: string | null;
  origin_url: string;
  priority: number;
  weight: number;
  enabled: number;
  last_health_status: string | null;
  last_checked_at: number | null;
};

type LbStatus = {
  mode: string;
  implementation: string;
  origins: Array<{
    id: string;
    origin_url: string;
    enabled: boolean;
    priority: number;
    last_health_status: string | null;
    last_checked_at: number | null;
  }>;
};

type UsageRow = { origin_url: string; req_count: number };

/* ═══════════════════════════════════════════════════════════════════════
 * Format helpers
 * ═══════════════════════════════════════════════════════════════════════ */

const fmtNum = (n: number): string => n.toLocaleString('id-ID');

const fmtBytes = (b: number | null): string => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const fmtRel = (ts: number | null): string => {
  if (!ts) return 'belum pernah';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 60) return `${d} detik lalu`;
  if (d < 3600) return `${Math.floor(d / 60)} mnt lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)} jam lalu`;
  return `${Math.floor(d / 86400)} hari lalu`;
};

const fmtDayLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'UTC' });
};

/** Strip scheme + trailing slash for compact display. */
const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/* ═══════════════════════════════════════════════════════════════════════
 * Icons — inline SVG, consistent 1.6–1.8 stroke, no emoji.
 * ═══════════════════════════════════════════════════════════════════════ */

type IconProps = { className?: string };

const iconBase = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconUsers({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconBookmark({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconPulse({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function IconServer({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <rect x="2" y="3" width="20" height="8" rx="2" />
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M6 7h.01M6 17h.01" />
    </svg>
  );
}

function IconDatabase({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function IconSearch({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function IconBell({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconChevronDown({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function IconRefresh({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconShield({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Shared UI primitives
 * ═══════════════════════════════════════════════════════════════════════ */

function Card({
  children,
  className = '',
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section
      className={`relative rounded-2xl border border-border-subtle bg-elevated p-5 transition-colors duration-300 hover:border-border-default anim-slide-up ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </section>
  );
}

function CardHead({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <span className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-bg-secondary/70 text-secondary">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium text-primary truncate">{title}</h2>
          {hint && <p className="text-[11px] text-muted mt-0.5 truncate">{hint}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center text-[11px] text-muted text-center py-8 px-3 leading-relaxed">
      {children}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone = 'default',
  delay = 0,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: 'default' | 'success' | 'error';
  delay?: number;
}) {
  const toneCls =
    tone === 'success' ? 'text-success' : tone === 'error' ? 'text-error' : 'text-primary';
  return (
    <Card delay={delay} className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 flex items-center justify-center rounded-lg bg-bg-secondary/70 text-secondary">
          {icon}
        </span>
        <span className="text-[11px] text-muted truncate">{label}</span>
      </div>
      <div className={`text-2xl font-semibold tabular tracking-tight ${toneCls}`}>{value}</div>
      <div className="text-[11px] text-muted mt-1 truncate">{sub}</div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Area chart — total requests per day (real lb_usage rows).
 * Time axis uses array index because getDbUsageTrend-style aliases can
 * yield null ts; dates[] from the API is the authoritative label source.
 * ═══════════════════════════════════════════════════════════════════════ */

function AreaChart({
  points,
  labels,
  height = 190,
}: {
  points: number[];
  labels: string[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, '');
  const w = 640;
  const padX = 10;
  const padY = 18;
  const h = height;

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-[11px] text-muted text-center px-4 leading-relaxed"
        style={{ height }}
      >
        Belum cukup data. Grafik muncul setelah origin melayani permintaan minimal 2 hari.
      </div>
    );
  }

  const max = Math.max(...points, 1);
  const iw = w - padX * 2;
  const ih = h - padY * 2;
  const x = (i: number) => padX + (i / (points.length - 1)) * iw;
  const y = (v: number) => padY + ih - (v / max) * ih;

  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(padY + ih).toFixed(1)} L${x(0).toFixed(1)},${(padY + ih).toFixed(1)} Z`;

  const active = hover != null ? hover : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        role="img"
        aria-label="Grafik permintaan per hari"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line
            key={t}
            x1={padX}
            x2={w - padX}
            y1={padY + ih * t}
            y2={padY + ih * t}
            stroke="var(--border-subtle)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={area} fill={`url(#fill-${uid})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {active != null && (
          <>
            <line
              x1={x(active)}
              x2={x(active)}
              y1={padY}
              y2={padY + ih}
              stroke="var(--border-default)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={x(active)} cy={y(points[active])} r="3.5" fill="var(--accent)" />
          </>
        )}

        {/* Invisible hit areas for hover */}
        {points.map((_, i) => (
          <rect
            key={i}
            x={x(i) - iw / (points.length - 1) / 2}
            y={0}
            width={iw / (points.length - 1)}
            height={h}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      {active != null && (
        <div
          className="absolute -translate-x-1/2 pointer-events-none rounded-lg border border-border-default bg-base px-2 py-1 text-[10px] tabular whitespace-nowrap shadow-lg"
          style={{
            left: `${(x(active) / w) * 100}%`,
            top: 0,
          }}
        >
          <span className="text-muted">{labels[active] ?? ''}</span>
          <span className="text-primary ml-1.5 font-medium">{fmtNum(points[active])}</span>
        </div>
      )}

      <div className="flex justify-between mt-2 text-[10px] text-muted tabular">
        <span>{labels[0] ?? ''}</span>
        <span>{labels[labels.length - 1] ?? ''}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Storage donut — real B2 bytes vs configured quota.
 * Replaces the previous fabricated "Spending" donut.
 * ═══════════════════════════════════════════════════════════════════════ */

function StorageDonut({
  accounts,
  totalBytes,
  quota,
  d1Bytes,
}: {
  accounts: StorageData['accounts'];
  totalBytes: number;
  quota: number;
  d1Bytes: number | null;
}) {
  const [active, setActive] = useState(-1);
  const R = 40;
  const C = 2 * Math.PI * R;

  const segs = useMemo(() => {
    const palette = ['var(--accent)', 'var(--text-secondary)', 'var(--text-muted)', 'var(--success)'];
    const list = accounts
      .map((a, i) => ({
        label: a.name || a.bucket,
        value: a.bytes,
        color: palette[i % palette.length],
      }))
      .filter((s) => s.value > 0);
    return list;
  }, [accounts]);

  const used = segs.reduce((a, b) => a + b.value, 0) || totalBytes;
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;

  let acc = 0;

  return (
    <Card delay={80}>
      <CardHead
        icon={<IconDatabase className="w-4 h-4" />}
        title="Penyimpanan"
        hint="B2 object storage · kuota terkonfigurasi"
      />

      <div className="relative w-[136px] h-[136px] mx-auto">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--border-subtle)" strokeWidth="11" />
          {segs.map((s, i) => {
            const len = (s.value / Math.max(used, 1)) * C * (pct / 100);
            const off = acc;
            acc += len;
            const isActive = active === i;
            return (
              <circle
                key={i}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth={isActive ? 14 : 11}
                strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${C - Math.max(len - 1.5, 0.5)}`}
                strokeDashoffset={-off}
                strokeLinecap="round"
                className="transition-all duration-200 cursor-pointer"
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(-1)}
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-semibold tabular tracking-tight text-primary">
            {pct.toFixed(1)}%
          </span>
          <span className="text-[10px] text-muted">terpakai</span>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-muted">Terpakai</span>
          <span className="tabular text-primary font-medium">{fmtBytes(used)}</span>
        </div>
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-muted">Kuota</span>
          <span className="tabular text-secondary">{fmtBytes(quota)}</span>
        </div>
        {d1Bytes != null && (
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-muted">Estimasi D1</span>
            <span className="tabular text-secondary">{fmtBytes(d1Bytes)}</span>
          </div>
        )}
      </div>

      {segs.length > 0 ? (
        <div className="mt-3 pt-3 border-t border-border-subtle space-y-1.5">
          {segs.map((s, i) => (
            <div
              key={i}
              className="flex items-center justify-between text-[11px] cursor-default"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(-1)}
            >
              <span className="flex items-center gap-2 text-secondary min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                <span className="truncate">{s.label}</span>
              </span>
              <span className="tabular text-muted shrink-0 ml-2">{fmtBytes(s.value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-border-subtle">
          <p className="text-[11px] text-muted leading-relaxed">
            Belum ada objek tercatat di KV. Angka akan terisi setelah halaman gambar diunggah.
          </p>
        </div>
      )}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Source health — real uptime_pct from source_health table.
 * ═══════════════════════════════════════════════════════════════════════ */

function SourceHealthCard({ sources, delay = 160 }: { sources: SourceHealth[]; delay?: number }) {
  return (
    <Card delay={delay}>
      <CardHead
        icon={<IconPulse className="w-4 h-4" />}
        title="Kesehatan sumber"
        hint={`${sources.length} sumber terpantau`}
      />
      {sources.length === 0 ? (
        <EmptyState>Belum ada baris source_health. Jalankan pencarian atau baca satu chapter untuk mengisinya.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {sources.map((s) => {
            const pct = s.uptime_pct ?? 0;
            const barColor =
              pct >= 95 ? 'var(--success)' : pct >= 70 ? 'oklch(75% 0.14 75)' : 'var(--error)';
            return (
              <li key={s.source}>
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-[12px] text-primary truncate">{s.source}</span>
                  <span className="text-[11px] tabular text-secondary shrink-0">
                    {s.uptime_pct == null ? '—' : `${s.uptime_pct}%`}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-bg-secondary/70 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: barColor }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1 text-[10px] text-muted">
                  <span className="tabular">
                    {s.healthy}/{s.total} check sehat
                  </span>
                  <span>{fmtRel(s.last_checked_at)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Origins — real rows + today's real request counts.
 * Replaces the fabricated "Invoices" card (previously `$priority * 7`).
 * ═══════════════════════════════════════════════════════════════════════ */

function OriginsCard({
  origins,
  usage,
  query,
  onViewAll,
}: {
  origins: LbOrigin[];
  usage: UsageRow[];
  query: string;
  onViewAll: () => void;
}) {
  const usageByUrl = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of usage) m.set(u.origin_url, u.req_count);
    return m;
  }, [usage]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = q ? origins.filter((o) => o.origin_url.toLowerCase().includes(q)) : origins;
    return f.slice(0, 6);
  }, [origins, query]);

  const enabledCount = origins.filter((o) => o.enabled === 1).length;

  const statusMeta = (st: string | null) => {
    if (st === 'healthy') return { color: 'var(--success)', label: 'Sehat' };
    if (st === 'unhealthy' || st === 'down') return { color: 'var(--error)', label: 'Down' };
    return { color: 'var(--text-muted)', label: 'Belum dicek' };
  };

  return (
    <Card delay={240}>
      <CardHead
        icon={<IconServer className="w-4 h-4" />}
        title="Origin pool"
        hint={`${enabledCount} aktif dari ${origins.length} origin`}
      />

      {list.length === 0 ? (
        <EmptyState>{query ? `Tidak ada origin yang cocok dengan “${query}”.` : 'Belum ada origin terdaftar.'}</EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {list.map((o) => {
            const st = statusMeta(o.last_health_status);
            const reqs = usageByUrl.get(o.origin_url);
            return (
              <li key={o.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: st.color }}
                      aria-hidden="true"
                    />
                    <span className="text-[12px] text-primary truncate" title={o.origin_url}>
                      {hostOf(o.origin_url)}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted mt-0.5 tabular ml-3">
                    P{o.priority} · W{o.weight} · {o.enabled === 1 ? 'aktif' : 'nonaktif'}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[12px] tabular text-primary">
                    {reqs == null ? '—' : fmtNum(reqs)}
                  </div>
                  <div className="text-[10px] text-muted">req hari ini</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        onClick={onViewAll}
        className="mt-4 text-[11px] text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
      >
        Kelola origin →
      </button>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Security events — real feed from security_events table.
 * Replaces the static decorative notification badge.
 * ═══════════════════════════════════════════════════════════════════════ */

function SecurityCard({ events, total }: { events: SecEvent[]; total: number }) {
  const sevColor: Record<string, string> = {
    critical: 'var(--error)',
    high: 'oklch(70% 0.14 50)',
    medium: 'oklch(75% 0.14 75)',
    low: 'var(--text-muted)',
  };

  return (
    <Card delay={320}>
      <CardHead
        icon={<IconShield className="w-4 h-4" />}
        title="Keamanan"
        hint={`${fmtNum(total)} belum diselesaikan`}
      />
      {events.length === 0 ? (
        <EmptyState>Tidak ada event keamanan terbuka. Feed terisi otomatis dari rate limiter dan guard CSRF.</EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {events.slice(0, 5).map((e) => (
            <li key={e.id} className="flex items-start gap-2">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
                style={{ background: sevColor[e.severity] ?? 'var(--text-muted)' }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-primary truncate">{e.message ?? e.type}</div>
                <div className="text-[10px] text-muted mt-0.5">
                  {e.severity} · {e.path ?? '—'} · {fmtRel(e.created_at)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Main page
 * ═══════════════════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'settings', label: 'Mode' },
  { key: 'accounts', label: 'Akun' },
  { key: 'origins', label: 'Origin Pool' },
  { key: 'status', label: 'Status' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function AdminSettingsPage() {
  const router = useRouter();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoad, setLastLoad] = useState<number | null>(null);

  // Real metrics
  const [overview, setOverview] = useState<Overview | null>(null);
  const [storage, setStorage] = useState<StorageData | null>(null);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [requests, setRequests] = useState<ReqData | null>(null);
  const [secEvents, setSecEvents] = useState<SecEvent[]>([]);
  const [secTotal, setSecTotal] = useState(0);

  // LB config
  const [settings, setSettings] = useState<LbSettings | null>(null);
  const [accounts, setAccounts] = useState<LbAccount[]>([]);
  const [origins, setOrigins] = useState<LbOrigin[]>([]);
  const [status, setStatus] = useState<LbStatus | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);

  const [tab, setTab] = useState<TabKey>('settings');
  const [query, setQuery] = useState('');
  const [provisionStatus, setProvisionStatus] = useState<any>(null);
  const [provisioning, setProvisioning] = useState(false);
  const provisionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const headers = () => ({ 'Content-Type': 'application/json' });

  /* ── Data loading ────────────────────────────────────────────────────
   * Each call is individually tolerant: one failing/empty table must not
   * blank the whole page. Envelope shapes differ per endpoint — see the
   * type block at the top of this file.
   * ─────────────────────────────────────────────────────────────────── */
  const loadAll = useCallback(async () => {
    try {
      const [ov, st, sh, rq, se, s, a, o, lbStatus, us] = await Promise.all([
        apiGet<{ data: Overview }>('/api/admin/overview').catch(() => null),
        apiGet<{ data: StorageData }>('/api/admin/dashboard/storage').catch(() => null),
        apiGet<{ data: SourceHealth[] }>('/api/admin/dashboard/source-health').catch(() => null),
        apiGet<{ data: ReqData }>('/api/admin/dashboard/requests?days=14').catch(() => null),
        apiGet<{ data: SecEvent[]; total: number }>('/api/admin/security-events?limit=5&resolved=0').catch(() => null),
        apiGet<LbSettings>('/api/admin/lb/settings').catch(() => null),
        apiGet<LbAccount[]>('/api/admin/lb/accounts').catch(() => null),
        apiGet<LbOrigin[]>('/api/admin/lb/origins').catch(() => null),
        apiGet<{ data: LbStatus }>('/api/admin/lb/status').catch(() => null),
        apiGet<{ data: UsageRow[] }>('/api/admin/lb/usage').catch(() => null),
      ]);

      setOverview(ov?.data ?? null);
      setStorage(st?.data ?? null);
      setSources(sh?.data ?? []);
      setRequests(rq?.data ?? null);
      setSecEvents(se?.data ?? []);
      setSecTotal(se?.total ?? 0);
      setSettings(s ?? null);
      setAccounts(a ?? []);
      setOrigins(o ?? []);
      setStatus(lbStatus?.data ?? null);
      setUsage(us?.data ?? []);
      setLastLoad(Date.now());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setUser(u);
      setAuthLoading(false);
      if (!u || u.role !== 'admin') router.replace('/');
    });
    return () => {
      alive = false;
    };
  }, [router]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    loadAll();
    const iv = setInterval(() => {
      setRefreshing(true);
      loadAll();
    }, 30000);
    return () => clearInterval(iv);
  }, [user, loadAll]);

  useEffect(
    () => () => {
      if (provisionPollRef.current) clearInterval(provisionPollRef.current);
    },
    [],
  );

  /* ── Mutations ─────────────────────────────────────────────────────── */

  const updateSettings = async (updates: Partial<LbSettings>) => {
    try {
      const base = await getAuthApiUrl();
      const res = await fetch(`${base}/api/admin/lb/settings`, {
        method: 'PUT',
        headers: headers(),
        credentials: 'include',
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(`Gagal menyimpan (${res.status})`);
      setSettings((prev) => (prev ? { ...prev, ...updates } : prev));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const addAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const rawToken = String(f.get('rawToken') ?? '');
    try {
      const base = await getAuthApiUrl();
      const res = await fetch(`${base}/api/admin/lb/accounts`, {
        method: 'POST',
        headers: headers(),
        credentials: 'include',
        body: JSON.stringify({
          label: f.get('label'),
          provider: f.get('provider'),
          account_ref: f.get('account_ref') || null,
          rawToken,
          token_last4: rawToken.slice(-4),
        }),
      });
      if (!res.ok) throw new Error(`Gagal menambah akun (${res.status})`);
      e.currentTarget.reset();
      setError(null);
      await loadAll();
    } catch (err) {
      setError(String(err));
    }
  };

  const provisionAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const label = String(f.get('provision_label') ?? '');
    const token = String(f.get('provision_token') ?? '');
    const workerName = String(f.get('provision_worker_name') ?? '') || `manga-api-${crypto.randomUUID().slice(0, 8)}`;
    setProvisioning(true);
    setProvisionStatus(null);
    try {
      const base = await getAuthApiUrl();
      const res = await fetch(`${base}/api/admin/lb/accounts/provision`, {
        method: 'POST',
        headers: headers(),
        credentials: 'include',
        body: JSON.stringify({ label, cfApiToken: token, workerName }),
      });
      const j = (await res.json()) as { job_id?: string };
      const jobId = j.job_id;
      if (!jobId) throw new Error('Server tidak mengembalikan job_id');

      let ticks = 0;
      const poll = setInterval(async () => {
        if (document.hidden) return;
        if (++ticks > 100) {
          clearInterval(poll);
          provisionPollRef.current = null;
          setProvisioning(false);
          setError('Provision polling timeout — cek status akun secara manual.');
          return;
        }
        try {
          const st = await apiGet<{ data: any }>(`/api/admin/lb/accounts/${jobId}/provision-status`);
          const data = st?.data ?? null;
          setProvisionStatus(data);
          if (data?.status === 'completed' || data?.status === 'failed') {
            clearInterval(poll);
            provisionPollRef.current = null;
            setProvisioning(false);
            await loadAll();
          }
        } catch {
          /* keep polling */
        }
      }, 3000);
      provisionPollRef.current = poll;
    } catch (err) {
      setProvisioning(false);
      setError(String(err));
    }
  };

  const addOrigin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const base = await getAuthApiUrl();
      const res = await fetch(`${base}/api/admin/lb/origins`, {
        method: 'POST',
        headers: headers(),
        credentials: 'include',
        body: JSON.stringify({
          account_id: f.get('account_id') || null,
          origin_url: f.get('origin_url'),
          priority: Number(f.get('priority') || 0),
          weight: Number(f.get('weight') || 1),
          enabled: 1,
        }),
      });
      if (!res.ok) throw new Error(`Gagal menambah origin (${res.status})`);
      e.currentTarget.reset();
      setError(null);
      await loadAll();
    } catch (err) {
      setError(String(err));
    }
  };

  const testAccount = async (id: string) => {
    try {
      await apiPost(`/api/admin/lb/accounts/${id}/test`);
      await loadAll();
    } catch (e) {
      setError(String(e));
    }
  };

  /* ── Derived (all real) ────────────────────────────────────────────── */

  const scrapeTotal = (overview?.scrape24h.success ?? 0) + (overview?.scrape24h.failed ?? 0);
  const scrapeRate = scrapeTotal > 0 ? Math.round(((overview?.scrape24h.success ?? 0) / scrapeTotal) * 100) : 0;

  const healthyOrigins = status?.origins.filter((o) => o.last_health_status === 'healthy').length ?? 0;

  const trafficPoints = useMemo(() => {
    if (!requests?.series.length) return [];
    return requests.dates.map((_, i) =>
      requests.series.reduce((sum, s) => sum + (s.points[i] ?? 0), 0),
    );
  }, [requests]);

  const trafficTotal = trafficPoints.reduce((a, b) => a + b, 0);

  const quotaTotal = storage?.accounts.reduce((a, x) => a + x.quota, 0) ?? storage?.quota ?? 0;

  /* ── Guards ────────────────────────────────────────────────────────── */

  if (authLoading) {
    return (
      <main className="max-w-7xl mx-auto p-4 md:p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-56 rounded-lg bg-elevated" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 rounded-2xl bg-elevated" />
            ))}
          </div>
          <div className="h-64 rounded-2xl bg-elevated" />
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') return null;

  const inputCls =
    'w-full bg-base/60 border border-border-subtle rounded-xl px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors';
  const btnCls =
    'px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors disabled:opacity-50';

  return (
    <main className="max-w-7xl mx-auto">
      {/* Ambient glow — purely decorative, sits behind content */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-64 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 70% 100% at 50% 0%, color-mix(in oklab, var(--accent) 6%, transparent), transparent 70%)',
        }}
      />

      {error && (
        <div className="mb-5 text-sm text-error border border-error/30 rounded-xl p-3 bg-error/5">
          {error}
        </div>
      )}

      {/* ── Header ── */}
      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6 anim-slide-up">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Settings</h1>
          <p className="text-sm text-muted mt-1">
            Load balancer, origin pool, dan metrik platform
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {lastLoad && (
            <span className="hidden xl:flex items-center gap-1.5 text-[11px] text-muted tabular">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-75 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              {new Date(lastLoad).toLocaleTimeString('id-ID')}
            </span>
          )}

          <div className="hidden sm:flex items-center gap-2 bg-elevated border border-border-subtle rounded-full pl-3.5 pr-3 py-2 focus-within:border-border-default transition-colors">
            <IconSearch className="w-4 h-4 text-muted shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari origin..."
              aria-label="Cari origin"
              className="w-36 md:w-48 bg-transparent text-sm text-primary placeholder:text-muted focus:outline-none"
            />
          </div>

          <button
            onClick={() => {
              setRefreshing(true);
              loadAll();
            }}
            disabled={refreshing}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-elevated border border-border-subtle text-secondary hover:text-primary hover:border-border-default transition-colors disabled:opacity-50"
            aria-label="Muat ulang data"
            title="Muat ulang"
          >
            <IconRefresh className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>

          <div
            className="relative w-9 h-9 flex items-center justify-center rounded-full bg-elevated border border-border-subtle text-secondary"
            title={secTotal > 0 ? `${secTotal} event keamanan belum diselesaikan` : 'Tidak ada event terbuka'}
          >
            <IconBell className="w-4 h-4" />
            {secTotal > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-error text-[9px] font-semibold text-base tabular">
                {secTotal > 99 ? '99+' : secTotal}
              </span>
            )}
            <span className="sr-only">
              {secTotal > 0 ? `${secTotal} event keamanan belum diselesaikan` : 'Tidak ada event keamanan terbuka'}
            </span>
          </div>

          <div className="flex items-center gap-2.5 pl-1">
            <span className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-sm font-semibold text-base">
              {(user.email || '?').charAt(0).toUpperCase()}
            </span>
            <div className="hidden lg:block">
              <div className="text-xs font-medium text-primary truncate max-w-[170px]">{user.email}</div>
              <div className="text-[10px] text-muted">{roleLabel(user.role)}</div>
            </div>
            <IconChevronDown className="w-4 h-4 text-muted hidden lg:block" />
          </div>
        </div>
      </header>

      {/* ── KPI row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard
          icon={<IconUsers className="w-4 h-4" />}
          label="Pengguna terdaftar"
          value={overview ? fmtNum(overview.usersTotal) : '—'}
          sub="total akun di database"
          delay={0}
        />
        <StatCard
          icon={<IconBookmark className="w-4 h-4" />}
          label="Bookmark tersimpan"
          value={overview ? fmtNum(overview.bookmarksTotal) : '—'}
          sub="akumulasi seluruh pengguna"
          delay={40}
        />
        <StatCard
          icon={<IconPulse className="w-4 h-4" />}
          label="Scrape 24 jam"
          value={overview ? `${scrapeRate}%` : '—'}
          sub={overview ? `${overview.scrape24h.success} sukses · ${overview.scrape24h.failed} gagal` : 'memuat...'}
          tone={scrapeTotal === 0 ? 'default' : scrapeRate >= 80 ? 'success' : scrapeRate >= 50 ? 'default' : 'error'}
          delay={80}
        />
        <StatCard
          icon={<IconServer className="w-4 h-4" />}
          label="Origin sehat"
          value={status ? `${healthyOrigins}/${status.origins.length}` : '—'}
          sub={status ? `mode ${status.mode} · ${status.implementation}` : 'memuat...'}
          tone={status && status.origins.length > 0 && healthyOrigins === status.origins.length ? 'success' : 'default'}
          delay={120}
        />
      </div>

      {/* ── Bento grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Traffic — spans 2 */}
        <Card delay={160} className="lg:col-span-2">
          <CardHead
            icon={<IconPulse className="w-4 h-4" />}
            title="Permintaan origin"
            hint="Jumlah panggilan GET /api/origins per hari · 14 hari terakhir"
            action={
              <span className="text-[11px] text-muted tabular shrink-0">
                total {fmtNum(trafficTotal)}
              </span>
            }
          />
          {loading ? (
            <div className="h-[190px] rounded-lg bg-bg-secondary/40 animate-pulse" />
          ) : (
            <AreaChart
              points={trafficPoints}
              labels={(requests?.dates ?? []).map(fmtDayLabel)}
            />
          )}
          {requests && requests.series.length > 0 && (
            <div className="mt-4 pt-3 border-t border-border-subtle space-y-1.5">
              {requests.series.map((s) => {
                const sum = s.points.reduce((a, b) => a + b, 0);
                return (
                  <div key={s.origin} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-secondary truncate" title={s.origin}>
                      {hostOf(s.origin)}
                    </span>
                    <span className="tabular text-muted shrink-0">{fmtNum(sum)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <StorageDonut
          accounts={storage?.accounts ?? []}
          totalBytes={storage?.total_bytes ?? 0}
          quota={quotaTotal}
          d1Bytes={storage?.d1_bytes ?? null}
        />

        <SourceHealthCard sources={sources} delay={200} />
        <OriginsCard
          origins={origins}
          usage={usage}
          query={query}
          onViewAll={() => setTab('origins')}
        />
        <SecurityCard events={secEvents} total={secTotal} />
      </div>

      {/* ── Management tabs ── */}
      <div className="mt-6 bg-elevated border border-border-subtle rounded-2xl p-5 anim-slide-up">
        <div className="flex gap-1 mb-5 border-b border-border-subtle pb-4 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 text-sm rounded-full transition-all duration-200 ${
                tab === t.key
                  ? 'bg-accent text-base font-medium'
                  : 'text-secondary hover:text-primary hover:bg-bg-secondary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Mode ── */}
        {tab === 'settings' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="lb-mode" className="text-sm text-secondary">
                Mode
              </label>
              <select
                id="lb-mode"
                value={settings?.mode ?? 'off'}
                onChange={(e) => updateSettings({ mode: e.target.value as 'off' | 'on' })}
                className={`${inputCls} mt-1`}
              >
                <option value="off">Nonaktif</option>
                <option value="on">Aktif</option>
              </select>
            </div>
            <div>
              <label htmlFor="lb-impl" className="text-sm text-secondary">
                Implementasi
              </label>
              <select
                id="lb-impl"
                value={settings?.implementation ?? 'custom'}
                onChange={(e) => updateSettings({ implementation: e.target.value as 'native_cf' | 'custom' })}
                className={`${inputCls} mt-1`}
              >
                <option value="custom">Custom (gratis)</option>
                <option value="native_cf">Native CF LB</option>
              </select>
            </div>
            <div>
              <label htmlFor="lb-steering" className="text-sm text-secondary">
                Steering Policy
              </label>
              <input
                id="lb-steering"
                defaultValue={settings?.steering_policy ?? ''}
                onBlur={(e) => updateSettings({ steering_policy: e.target.value })}
                className={`${inputCls} mt-1`}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="lb-interval" className="text-xs text-muted">
                  Interval (s)
                </label>
                <input
                  id="lb-interval"
                  type="number"
                  defaultValue={settings?.health_check_interval_sec ?? 30}
                  onBlur={(e) => updateSettings({ health_check_interval_sec: Number(e.target.value) })}
                  className={`${inputCls} mt-1`}
                />
              </div>
              <div>
                <label htmlFor="lb-timeout" className="text-xs text-muted">
                  Timeout (ms)
                </label>
                <input
                  id="lb-timeout"
                  type="number"
                  defaultValue={settings?.health_check_timeout_ms ?? 3000}
                  onBlur={(e) => updateSettings({ health_check_timeout_ms: Number(e.target.value) })}
                  className={`${inputCls} mt-1`}
                />
              </div>
              <div>
                <label htmlFor="lb-threshold" className="text-xs text-muted">
                  Fail Threshold
                </label>
                <input
                  id="lb-threshold"
                  type="number"
                  defaultValue={settings?.failure_threshold ?? 2}
                  onBlur={(e) => updateSettings({ failure_threshold: Number(e.target.value) })}
                  className={`${inputCls} mt-1`}
                />
              </div>
            </div>
          </div>
        )}

        {/* ── Akun ── */}
        {tab === 'accounts' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-medium text-primary">Auto-Provision akun CF baru</h3>
                <p className="text-xs text-muted leading-relaxed">
                  Membuat D1 + Worker baru otomatis di akun Cloudflare lain. Token memerlukan permission:
                  Workers Scripts:Edit, D1:Edit, KV:Edit, R2:Edit.
                </p>
                <form onSubmit={provisionAccount} className="space-y-2">
                  <input name="provision_label" placeholder="Label akun" required className={inputCls} />
                  <input name="provision_worker_name" placeholder="Nama worker (opsional)" className={inputCls} />
                  <input
                    name="provision_token"
                    type="password"
                    placeholder="CF API Token"
                    required
                    className={inputCls}
                  />
                  <button type="submit" disabled={provisioning} className={btnCls}>
                    {provisioning ? 'Provisioning...' : 'Provision'}
                  </button>
                </form>
                {provisionStatus && (
                  <div className="text-xs space-y-1 pt-1">
                    <div
                      className={
                        provisionStatus.status === 'completed'
                          ? 'text-success'
                          : provisionStatus.status === 'failed'
                            ? 'text-error'
                            : 'text-secondary'
                      }
                    >
                      Status: {provisionStatus.status} — {provisionStatus.step}
                    </div>
                    {provisionStatus.workerUrl && (
                      <div className="text-success break-all">Worker URL: {provisionStatus.workerUrl}</div>
                    )}
                    {provisionStatus.error && <div className="text-error break-all">Error: {provisionStatus.error}</div>}
                  </div>
                )}
              </div>

              <form onSubmit={addAccount} className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-medium text-primary">Tambah akun</h3>
                <input name="label" placeholder="Label" required className={inputCls} />
                <select name="provider" className={inputCls} defaultValue="cloudflare">
                  <option value="cloudflare">Cloudflare</option>
                  <option value="vercel">Vercel</option>
                </select>
                <input name="account_ref" placeholder="Account / Team ID (opsional)" className={inputCls} />
                <input name="rawToken" placeholder="API Token" required className={inputCls} />
                <button type="submit" className={btnCls}>
                  Tambah
                </button>
              </form>
            </div>

            <div className="divide-y divide-border-subtle border border-border-subtle rounded-xl bg-base/50 max-h-[440px] overflow-y-auto">
              {accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-primary truncate">{a.label}</span>
                      <span className="text-[10px] px-2 py-0.5 border border-border-default rounded-full text-secondary">
                        {a.provider}
                      </span>
                    </div>
                    <span className="text-muted text-[11px] tabular">cf_****{a.token_last4}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-[11px] ${a.status === 'verified' ? 'text-success' : 'text-error'}`}
                    >
                      {a.status}
                    </span>
                    <button
                      onClick={() => testAccount(a.id)}
                      className="text-[11px] text-secondary hover:text-primary transition-colors"
                    >
                      Tes
                    </button>
                  </div>
                </div>
              ))}
              {accounts.length === 0 && (
                <div className="px-4 py-3 text-muted text-sm">Belum ada akun terdaftar.</div>
              )}
            </div>
          </div>
        )}

        {/* ── Origin pool ── */}
        {tab === 'origins' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <form onSubmit={addOrigin} className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2 h-fit">
              <h3 className="text-sm font-medium text-primary">Tambah origin</h3>
              <input name="origin_url" placeholder="https://..." required className={inputCls} />
              <input name="account_id" placeholder="Account ID (opsional)" className={inputCls} />
              <div className="flex gap-2">
                <input
                  name="priority"
                  type="number"
                  placeholder="Priority"
                  defaultValue={0}
                  className={`${inputCls} flex-1`}
                />
                <input
                  name="weight"
                  type="number"
                  placeholder="Weight"
                  defaultValue={1}
                  className={`${inputCls} flex-1`}
                />
              </div>
              <button type="submit" className={btnCls}>
                Tambah
              </button>
            </form>

            <div className="divide-y divide-border-subtle border border-border-subtle rounded-xl bg-base/50 max-h-[440px] overflow-y-auto">
              {origins.map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="text-primary break-all text-[13px]">{o.origin_url}</div>
                    <div className="text-muted text-[11px] tabular mt-0.5">
                      P{o.priority} · W{o.weight}
                      {o.last_checked_at ? ` · dicek ${fmtRel(o.last_checked_at)}` : ''}
                    </div>
                  </div>
                  <span
                    className={`text-[11px] shrink-0 ${
                      o.enabled === 1 ? 'text-success' : 'text-muted'
                    }`}
                  >
                    {o.enabled === 1 ? 'ON' : 'OFF'}
                  </span>
                </div>
              ))}
              {origins.length === 0 && (
                <div className="px-4 py-3 text-muted text-sm">Belum ada origin terdaftar.</div>
              )}
            </div>
          </div>
        )}

        {/* ── Status ── */}
        {tab === 'status' && (
          <div>
            <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="text-secondary">Mode: </span>
                <span className="text-primary">{status?.mode ?? '—'}</span>
              </span>
              <span>
                <span className="text-secondary">Implementasi: </span>
                <span className="text-primary">{status?.implementation ?? '—'}</span>
              </span>
            </div>
            <div className="divide-y divide-border-subtle">
              {(status?.origins ?? []).map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="text-primary break-all text-[13px]">{o.origin_url}</span>
                  <span
                    className={`text-[11px] shrink-0 ${
                      o.last_health_status === 'healthy'
                        ? 'text-success'
                        : o.last_health_status === 'unhealthy'
                          ? 'text-error'
                          : 'text-muted'
                    }`}
                  >
                    {o.last_health_status ?? 'belum dicek'}
                    {o.last_checked_at ? ` · ${fmtRel(o.last_checked_at)}` : ''}
                  </span>
                </div>
              ))}
              {(status?.origins?.length ?? 0) === 0 && (
                <div className="py-3 text-muted text-sm">Belum ada origin terdaftar.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
