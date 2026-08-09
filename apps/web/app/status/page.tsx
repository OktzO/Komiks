import { getSourceStatus } from '@/lib/api';
import { SourceBadge, sourceLabel, SOURCE_LABELS } from '@/components/SourceBadge';

export const revalidate = 30;

type SourceHealth = {
  source: string;
  healthy: boolean;
  latency_ms: number | null;
  last_checked_at: number | null;
  error: string | null;
};

function formatRelative(ts: number | null): string {
  if (!ts) return 'belum pernah';
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diffSec < 60) return `${diffSec} detik lalu`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} menit lalu`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} jam lalu`;
  return `${Math.floor(diffSec / 86400)} hari lalu`;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function latencyGrade(ms: number | null): { label: string; tone: 'good' | 'mid' | 'bad' } {
  if (ms == null) return { label: '—', tone: 'bad' };
  if (ms < 1500) return { label: 'Cepat', tone: 'good' };
  if (ms < 3500) return { label: 'Sedang', tone: 'mid' };
  return { label: 'Lambat', tone: 'bad' };
}

const SOURCE_ORDER: string[] = ['komiku', 'bacakomik', 'thrive', 'manhwaindo'];

export default async function StatusPage() {
  let sources: SourceHealth[] = [];
  let error: string | null = null;
  let fetchedAt: number | null = null;

  try {
    const res = await getSourceStatus();
    sources = (res.data || []) as SourceHealth[];
    fetchedAt = Math.floor(Date.now() / 1000);
  } catch (e: any) {
    error = String(e.message || e);
  }

  const ordered = SOURCE_ORDER
    .map((s) => sources.find((x) => x.source === s))
    .filter(Boolean) as SourceHealth[];
  const remaining = sources.filter((s) => !SOURCE_ORDER.includes(s.source));

  const healthyCount = sources.filter((s) => s.healthy).length;
  const totalCount = sources.length;
  const allOperational = totalCount > 0 && healthyCount === totalCount;
  const uptimePct = totalCount === 0 ? 0 : Math.round((healthyCount / totalCount) * 1000) / 10;

  return (
    <main className="max-w-3xl mx-auto px-4 pt-4 pb-16 anim-slide-up">
      <a
        href="/"
        className="inline-flex items-center gap-2 text-sm text-secondary hover:text-primary transition-colors mb-8"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
        </svg>
        Beranda
      </a>

      <div className="inline-flex items-center gap-2 rounded-full border border-default bg-card/60 px-3 py-1 text-xs text-secondary backdrop-blur">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
        </svg>
        Passive monitoring
      </div>

      <h1 className="mt-6 font-display text-4xl md:text-6xl tracking-tight text-primary">
        {allOperational ? 'Semua sumber sehat' : healthyCount === 0 ? 'Semua sumber terganggu' : 'Sebagian sumber terganggu'}
      </h1>
      <p className="mt-4 text-lg text-secondary">
        <span className="text-primary font-medium">{healthyCount}/{totalCount}</span>
        {' · '}
        {totalCount === 0 ? 'tidak ada data' : `${uptimePct.toFixed(1)}% online`}
        {' · '}berdasarkan aktivitas terakhir
      </p>

      {error && (
        <div className="mt-6 text-error text-sm border border-error/40 rounded-xl p-3 bg-error/5">
          Gagal memuat status: {error}
        </div>
      )}

      <div className="mt-12 space-y-3">
        {ordered.map((s, idx) => (
          <SourceRow key={s.source} s={s} index={idx} />
        ))}
        {remaining.map((s) => (
          <SourceRow key={s.source} s={s} index={-1} />
        ))}
        {sources.length === 0 && !error && (
          <div className="text-muted text-sm border border-subtle rounded-xl p-6 bg-card/40 text-center">
            Tidak ada data status sumber.
          </div>
        )}
      </div>

      <div className="mt-10 flex items-center gap-2 text-xs text-muted">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </svg>
        Last updated {fetchedAt ? formatTimestamp(fetchedAt) : '—'}
        <span className="mx-2">·</span>
        Diperbarui saat ada aktivitas baca atau pencarian
      </div>
    </main>
  );
}

function SourceRow({ s, index }: { s: SourceHealth; index: number }) {
  const tone = latencyGrade(s.latency_ms);
  const toneClass = {
    good: 'text-success',
    mid: 'text-secondary',
    bad: 'text-error',
  }[tone.tone];

  const relativeTime = formatRelative(s.last_checked_at);
  const isStale = s.last_checked_at && (Math.floor(Date.now() / 1000) - s.last_checked_at) > 3600;

  return (
    <a
      href="/status"
      className="group flex w-full items-center justify-between gap-4 rounded-2xl border border-default bg-card p-5 text-left transition-colors hover:bg-bg-secondary anim-slide-up"
      style={{ animationDelay: `${Math.max(0, index) * 60}ms` }}
    >
      <div className="min-w-0 flex-1 flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {s.healthy && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />
          )}
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
              s.healthy ? 'bg-success' : 'bg-error'
            }`}
          />
        </span>
        <div className="flex items-center gap-2.5 min-w-0">
          <SourceBadge sources={[s.source]} size="md" />
          <span className="truncate font-medium text-primary">
            {SOURCE_LABELS[s.source] ?? sourceLabel(s.source)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-5 shrink-0">
        <div className="hidden sm:flex flex-col items-end text-right">
          <span className="text-xs text-muted">Latency</span>
          <span className={`text-sm font-medium tabular-nums ${toneClass}`}>
            {s.latency_ms != null ? `${s.latency_ms}ms` : '—'}
          </span>
        </div>

        <div className="flex flex-col items-end text-right">
          <span className="text-sm font-medium">
            {s.healthy ? 'Sehat' : 'Tidak Sehat'}
          </span>
          <span className={`text-xs ${isStale ? 'text-error' : 'text-muted'}`}>
            {relativeTime}
          </span>
        </div>

        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted transition-transform group-hover:translate-x-0.5">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </div>
    </a>
  );
}
