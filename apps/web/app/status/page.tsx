'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getSourceStatus, type SourceStatus } from '@/lib/api';
import { SourceBadge, sourceLabel, SOURCE_LABELS, SOURCE_ORDER } from '@/components/SourceBadge';

export const runtime = 'edge';

function formatTimestamp(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function StatusPage() {
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // Load sekali saat halaman dibuka — tidak ada polling. Data terbaru
  // tercatat otomatis oleh worker saat ada aktivitas baca dari sumber.
  useEffect(() => {
    let alive = true;
    getSourceStatus()
      .then((res) => { if (alive) { setSources(res.data); setLoadedAt(Math.floor(Date.now() / 1000)); setError(null); } })
      .catch((e) => { if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, []);

  const ordered = SOURCE_ORDER
    .map((s) => sources?.find((x) => x.source === s))
    .filter(Boolean) as SourceStatus[];
  const remaining = (sources ?? []).filter((s) => !SOURCE_ORDER.includes(s.source as (typeof SOURCE_ORDER)[number]));

  const totalCount = sources?.length ?? 0;
  const healthyCount = sources?.filter((s) => s.healthy).length ?? 0;
  const allOperational = totalCount > 0 && healthyCount === totalCount;
  const uptimes = (sources ?? []).map((s) => s.uptime_pct).filter((v): v is number => v != null);
  const avgUptime = uptimes.length === 0 ? null : Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 100) / 100;

  return (
    <main className="max-w-3xl mx-auto px-4 pt-4 pb-16 anim-slide-up">
      <Link href="/" className="inline-flex items-center gap-2 text-sm text-secondary hover:text-primary transition-colors mb-8">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
        </svg>
        Beranda
      </Link>

      <div className="inline-flex items-center gap-2 rounded-full border border-default bg-card/60 px-3 py-1 text-xs text-secondary backdrop-blur">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
        </svg>
        Monitoring sumber · pasif
      </div>

      <h1 className="mt-6 font-display text-4xl md:text-6xl tracking-tight text-primary">
        {!sources ? 'Memuat status…'
          : allOperational ? 'Semua sumber normal'
          : healthyCount === 0 ? 'Semua sumber terganggu'
          : 'Sebagian sumber terganggu'}
      </h1>
      <p className="mt-4 text-lg text-secondary">
        {avgUptime != null && sources ? (
          <>
            <span className="text-primary font-medium">{avgUptime.toFixed(2)}%</span>
            {' · '}uptime riwayat terakhir · {healthyCount}/{totalCount} sehat
          </>
        ) : 'mengambil data…'}
      </p>

      {error && (
        <div className="mt-6 text-error text-sm border border-error/40 rounded-xl p-3 bg-error/5">
          Gagal memuat status: {error}
        </div>
      )}

      <div className="mt-12 space-y-3">
        {ordered.map((s, idx) => <SourceRow key={s.source} s={s} index={idx} />)}
        {remaining.map((s) => <SourceRow key={s.source} s={s} index={-1} />)}
        {sources && sources.length === 0 && !error && (
          <div className="text-muted text-sm border border-subtle rounded-xl p-6 bg-card/40 text-center">
            Tidak ada data status sumber.
          </div>
        )}
      </div>

      <div className="mt-10 flex items-center justify-between gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
          Terakhir diperbarui {loadedAt ? formatTimestamp(loadedAt) : '—'}
        </span>
        <span className="text-right">Tanpa polling — data dicatat saat ada aktivitas baca</span>
      </div>
    </main>
  );
}

function SourceRow({ s, index }: { s: SourceStatus; index: number }) {
  const uptime = s.uptime_pct ?? null;

  return (
    <Link
      href={`/status/${s.source}`}
      className="group flex w-full items-center justify-between gap-4 rounded-2xl border border-default bg-card p-5 text-left transition-colors hover:bg-bg-secondary anim-slide-up"
      style={{ animationDelay: `${Math.max(0, index) * 60}ms` }}
    >
      <div className="min-w-0 flex-1 flex items-center gap-3">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.healthy ? 'bg-success' : 'bg-error'}`} />
        <div className="flex items-center gap-2.5 min-w-0">
          <SourceBadge sources={[s.source]} size="md" />
          <div className="min-w-0">
            <p className="truncate font-medium text-primary">
              {SOURCE_LABELS[s.source] ?? sourceLabel(s.source)}
            </p>
            <p className="text-xs capitalize text-muted">{s.last_checked_at ? (s.healthy ? 'online' : 'offline') : 'belum ada cek'}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right">
          <p className={`text-sm font-medium ${s.healthy ? 'text-primary' : 'text-error'}`}>
            {s.healthy ? 'Normal' : 'Gangguan'}
          </p>
          <p className="text-xs text-muted">{uptime != null ? `${uptime.toFixed(2)}% · 24 jam` : '—'}</p>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted transition-transform group-hover:translate-x-0.5">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </div>
    </Link>
  );
}