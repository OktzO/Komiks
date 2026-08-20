'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState, use } from 'react';
import { getSourceStatus, type SourceStatus } from '@/lib/api';
import { SourceBadge, sourceLabel, SOURCE_LABELS } from '@/components/SourceBadge';


const VALID = ['komiku', 'bacakomik', 'thrive', 'manhwaindo'] as const;
const HISTORY_MAX = 40;

type Check = { healthy: boolean; latency_ms: number | null; error: string | null; checked_at: number };

function fmtDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
function fmtClock(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type Incident = { start: number; end: number | null; error: string | null; durationMin: number | null };

// Incident = periode fail berurutan dalam riwayat cek. Resolved jika ada cek
// sehat setelahnya, berlangsung (ongoing) jika cek terakhir masih gagal.
function buildIncidents(checks: Check[]): Incident[] {
  const list: Incident[] = [];
  let cur: { start: number; error: string | null } | null = null;
  for (const c of checks) {
    if (!c.healthy) {
      if (!cur) cur = { start: c.checked_at, error: c.error };
    } else if (cur) {
      list.push({ start: cur.start, end: c.checked_at, error: cur.error, durationMin: Math.round((c.checked_at - cur.start) / 60) });
      cur = null;
    }
  }
  if (cur) list.push({ start: cur.start, end: null, error: cur.error, durationMin: null });
  return list.reverse(); // terbaru dulu
}

export default function SourceMonitorPage({ params }: { params: Promise<{ source: string }> }) {
  const { source } = use(params);
  const [[data, checks], setState] = useState<[SourceStatus | null, Check[]]>([null, []]);
  const [error, setError] = useState<string | null>(null);

  // Load sekali saat halaman dibuka — tanpa polling & tanpa ping.
  useEffect(() => {
    let alive = true;
    getSourceStatus()
      .then((res) => {
        if (!alive) return;
        const found = res.data.find((s) => s.source === source);
        if (found) setState([found, (found.history ?? []).slice(0, HISTORY_MAX)]);
        else setError('Tidak ada data monitoring untuk sumber ini.');
      })
      .catch((e) => { if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, [source]);

  if (!(VALID as readonly string[]).includes(source)) {
    return (
      <main className="max-w-3xl mx-auto px-4 pt-4 pb-16">
        <Link href="/status" className="text-sm text-secondary hover:text-primary">← Kembali ke status</Link>
        <h1 className="mt-6 text-2xl font-medium text-primary">Sumber tidak dikenal</h1>
      </main>
    );
  }

  const online = data?.healthy ?? checks.some((c) => c.healthy) ?? false;
  const last = checks[0];

  const okCount = checks.filter((c) => c.healthy).length;
  const failCount = checks.length - okCount;
  const uptime = checks.length > 0 ? Math.round((okCount / checks.length) * 10000) / 100 : (data?.uptime_pct ?? null);
  const incidents = useMemo(() => buildIncidents([...checks].reverse()), [checks]);

  const stats = useMemo(() => {
    const xs = checks.filter((c) => c.healthy && c.latency_ms != null).map((c) => c.latency_ms as number);
    const avg = xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    const min = xs.length > 0 ? Math.min(...xs) : null;
    const max = xs.length > 0 ? Math.max(...xs) : null;
    return { avg, min, max };
  }, [checks]);

  const chart = useMemo(() => {
    const pts = [...checks].reverse();
    const W = 560, H = 130, PAD = 4;
    if (pts.length === 0) return null;
    const max = Math.max(1500, ...pts.map((p) => (p.healthy && p.latency_ms != null ? (p.latency_ms as number) : 0)));
    const step = pts.length === 1 ? W : (W - PAD * 2) / (pts.length - 1);
    const line = pts.map((p, i) => {
      const x = i === pts.length - 1 ? W - PAD : PAD + i * step;
      const y = p.healthy && p.latency_ms != null ? H - PAD - (Math.min(p.latency_ms, max) / max) * (H - PAD * 2) : H - PAD;
      return { x, y, ok: p.healthy };
    });
    const d = line.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${d} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`;
    return { d, area, line, W, H };
  }, [checks]);

  return (
    <main className="max-w-3xl mx-auto px-4 pt-4 pb-16 anim-slide-up">
      <Link href="/status" className="inline-flex items-center gap-2 text-sm text-secondary hover:text-primary transition-colors mb-6">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
        </svg>
        Kembali ke status
      </Link>

      <div className="rounded-3xl border border-default bg-card p-6 md:p-8">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-4">
          <SourceBadge sources={[source]} size="md" />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl md:text-3xl font-display tracking-tight text-primary truncate">
              {SOURCE_LABELS[source] ?? sourceLabel(source)}
            </h1>
            <p className="text-sm text-muted mt-0.5">Sumber baca · {online ? 'online' : 'offline'}</p>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${online ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
            <span className={`h-2 w-2 rounded-full ${online ? 'bg-success' : 'bg-error'}`} />
            {online ? 'UP' : 'DOWN'}
          </span>
        </div>

        {error && !data && (
          <div className="mt-5 text-error text-sm border border-error/40 rounded-xl p-3 bg-error/5">Gagal memuat data: {error}</div>
        )}

        {/* Stat grid */}
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Respons terakhir" value={last?.latency_ms != null ? `${last.latency_ms} ms` : '—'} sub="sampel terbaru" tone={last ? (last.latency_ms != null && last.latency_ms < 1500 ? 'good' : last.healthy ? 'mid' : 'bad') : 'mid'} />
          <Stat label="Uptime · riwayat" value={uptime != null ? `${uptime.toFixed(2)}%` : '—'} sub={`${okCount}/${checks.length} cek sehat`} tone={uptime != null && uptime < 70 ? 'bad' : 'good'} />
          <Stat label="Downtime · riwayat" value={failCount > 0 ? `${failCount} cek gagal` : 'Tidak ada'} sub={`${incidents.length} incident`} tone={failCount > 0 ? 'bad' : 'good'} />
          <Stat label="Status" value={online ? 'UP' : 'DOWN'} sub={`Cek terakhir ${fmtClock(last?.checked_at ?? data?.last_checked_at ?? 0)}`} tone={online ? 'good' : 'bad'} />
        </div>

        {/* Avg response */}
        <div className="mt-3 rounded-2xl border border-subtle bg-bg-secondary/40 p-4 flex items-baseline justify-between gap-4">
          <p className="text-[10px] uppercase tracking-wider text-muted">Avg response time</p>
          <p className="text-right">
            <span className="text-xl font-semibold tabular-nums text-primary">{stats.avg != null ? `${stats.avg} ms` : '—'}</span>
            <span className="text-[11px] text-muted ml-2">{stats.min != null && stats.max != null ? `min ${stats.min}ms · max ${stats.max}ms` : 'dari cek sehat'}</span>
          </p>
        </div>

        {/* Uptime heartbeat: 40 cek terakhir */}
        <div className="mt-6">
          <p className="text-xs uppercase tracking-wider text-muted mb-2">Uptime · {checks.length} cek terakhir</p>
          {checks.length > 0 ? (
            <div className="flex gap-[3px] items-end h-8">
              {[...checks].reverse().map((c, i) => (
                <span key={i} title={`${fmtDate(c.checked_at)} · ${c.healthy ? 'sehat' : c.error ?? 'gagal'}`}
                  className={`flex-1 min-w-0 rounded-sm ${c.healthy ? 'bg-success/70' : 'bg-error/80'}`} style={{ height: '100%' }} />
              ))}
            </div>
          ) : (
            <div className="h-8 rounded-xl bg-bg-secondary/60 flex items-center justify-center text-sm text-muted">Belum ada data</div>
          )}
        </div>

        {/* Response time chart */}
        <div className="mt-6">
          <p className="text-xs uppercase tracking-wider text-muted mb-2">Response time</p>
          {chart ? (
            <svg viewBox={`0 0 ${chart.W} ${chart.H}`} className="w-full h-32" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="resp-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" className="text-accent" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <rect x="0" y="0" width={chart.W} height={chart.H} rx="12" className="fill-bg-secondary/60" />
              <path d={chart.area} fill="url(#resp-grad)" />
              <polyline points={chart.line.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" className="stroke-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <div className="h-32 rounded-xl bg-bg-secondary/60 flex items-center justify-center text-sm text-muted">Belum ada data</div>
          )}
        </div>

        {/* Incident log */}
        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-primary">Incident log</h3>
            <span className="text-xs text-muted">{Math.min(incidents.length, HISTORY_MAX)} recent</span>
          </div>
          <ul className="mt-3 space-y-2 max-h-80 overflow-y-auto pr-1">
            {incidents.length === 0 && !error && (
              <li className="text-sm text-muted py-4 text-center border border-subtle rounded-xl">Tidak ada insiden tercatat — semua cek sehat.</li>
            )}
            {incidents.map((inc, i) => (
              <li key={`${inc.start}-${i}`} className="flex items-start justify-between gap-4 rounded-xl border border-subtle bg-bg-secondary/40 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary truncate">{SOURCE_LABELS[source] ?? sourceLabel(source)}</p>
                  <p className="text-xs text-secondary truncate mt-0.5">{inc.error ?? 'Gagal menjangkau sumber'}</p>
                  <p className="text-[11px] text-muted mt-1.5 tabular-nums">
                    Mulai {fmtDate(inc.start)}
                    {inc.end != null ? <> · Selesai {fmtDate(inc.end)}</> : ''}
                    {inc.durationMin != null && <span className="ml-1.5">(≈{inc.durationMin} mnt)</span>}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide mt-1 ${inc.end != null ? 'bg-success/15 text-success' : 'bg-accent/15 text-accent'}`}>
                  {inc.end != null ? 'Resolved' : 'Ongoing'}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-5 text-[11px] text-muted">
          Tanpa polling &amp; tanpa ping manual — riwayat tercatat otomatis saat ada aktivitas baca dari sumber (maks {HISTORY_MAX} cek tersimpan).
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value, sub, tone = 'good' }: { label: string; value: string; sub: string; tone?: 'good' | 'mid' | 'bad' }) {
  const toneClass = { good: 'text-primary', mid: 'text-secondary', bad: 'text-error' }[tone];
  return (
    <div className="rounded-2xl border border-subtle bg-bg-secondary/40 p-4">
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      <p className="text-[11px] text-muted truncate">{sub}</p>
    </div>
  );
}