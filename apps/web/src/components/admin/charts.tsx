/* ══ Primitif admin bersama (Plan B) — Card/StatCard/chart. ═══════ */
import { useState, useId, useMemo } from 'react';

export type StorageAccount = { idx: number; name: string; bucket: string; bytes: number; quota: number };

export const fmtNum = (n: number): string => n.toLocaleString('id-ID');

export const fmtBytes = (b: number | null): string => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export function Card({
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
      className={`relative rounded-2xl border-[1.5px] border-strong bg-card p-5 anim-slide-up ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </section>
  );
}

export function CardHead({
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

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center text-[11px] text-muted text-center py-8 px-3 leading-relaxed">
      {children}
    </div>
  );
}

export function StatCard({
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

export function AreaChart({
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

export function StorageDonut({
  accounts,
  totalBytes,
  quota,
  d1Bytes,
  icon,
}: {
  accounts: StorageAccount[];
  totalBytes: number;
  quota: number;
  d1Bytes: number | null;
  icon?: React.ReactNode;
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
        icon={icon}
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