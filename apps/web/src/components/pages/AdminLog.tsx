'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiGet, fetchMe, type AuthUser } from '@/lib/api';
import { Card, fmtNum } from '@/components/admin/charts';

type LogRow = {
  ts: number;
  type: 'admin' | 'scrape';
  actor: string | null;
  message: string;
  meta: Record<string, unknown>;
};
type LogResp = { data: { type: 'admin' | 'scrape' | 'all'; rows: LogRow[]; total: number; page: number; limit: number } };

type Tab = 'all' | 'admin' | 'scrape';

function IconActivity({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

const fmtWhen = (ts: number): string => new Date(ts * 1000).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
const fmtWhenFull = (ts: number): string => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

const PAGE_SIZE = 20;
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: 'Semua' },
  { key: 'admin', label: 'Admin' },
  { key: 'scrape', label: 'Scrape' },
];

export default function AdminLogPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [data, setData] = useState<LogResp['data'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setUser(u);
      if (!u || u.role !== 'admin') window.location.replace('/');
    });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (t: Tab, silent = false) => {
    if (!silent) setErr(null);
    try {
      const j = await apiGet<LogResp>(`/api/admin/log?type=${t}&page=1&limit=${PAGE_SIZE}`);
      setData(j.data);
    } catch {
      if (!silent) setErr('Gagal memuat log. Coba lagi.');
    }
  }, []);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    setLoading(true);
    load(tab).finally(() => setLoading(false));
  }, [load, tab, user]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    const id = setInterval(() => { load(tab, true); }, 30_000);
    return () => clearInterval(id);
  }, [load, tab, user]);

  if (loading) {
    return (
      <div className="admin-page space-y-4">
        <div className="h-10 rounded-full bg-elevated w-64" />
        <div className="h-96 rounded-2xl bg-elevated" />
      </div>
    );
  }

  const pagesTotal = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="admin-page space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Log</h1>
        <p className="text-[13px] text-muted mt-1">Aktivitas admin + jobs scrape live. Refresh otomatis tiap 30 detik.</p>
      </div>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5 rounded-full bg-bg-secondary p-1 w-fit">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={[
                  'px-4 py-1.5 rounded-full text-[13px] transition-colors',
                  tab === t.key ? 'bg-accent text-accent-ink font-medium' : 'text-secondary hover:text-primary',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="text-[12px] text-muted tabular">{data ? fmtNum(data.total) : 0} entri</div>
        </div>
      </Card>

      {err && (
        <div className="text-sm text-error border border-error/30 rounded-xl p-3 bg-error/5">{err}</div>
      )}

      <Card>
        {(data?.rows ?? []).length === 0 ? (
          <div className="py-10 text-center">
            <IconActivity className="w-6 h-6 mx-auto text-muted mb-2" />
            <p className="text-[13px] text-muted">Tidak ada entri log{' '}
              {tab === 'admin' ? 'admin' : tab === 'scrape' ? 'scrape' : ''}

              untuk filter ini. Admin update settings/account/origin akan tercatat di sini.</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border-subtle">
              {(data?.rows ?? []).map((row, i) => (
                <div key={`${row.type}-${row.ts}-${i}`} className="flex items-start gap-3 py-2.5">
                  <time className="text-[11px] font-mono tabular text-muted leading-5 shrink-0" title={fmtWhenFull(row.ts)}>
                    {fmtWhen(row.ts)}
                  </time>
                  <span
                    className={[
                      'shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded leading-4 mt-0.5',
                      row.type === 'admin' ? 'bg-accent/15 text-accent' : 'bg-bg-secondary text-secondary',
                    ].join(' ')}
                  >
                    {row.type}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-primary font-mono break-words">{row.message}</p>
                    <p className="text-[11px] text-muted mt-0.5 truncate">
                      {[row.actor, Object.entries(row.meta).filter(([, v]) => v != null).map(([k, v]) => `${k}=${String(v)}`).join(' ') || null]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {tab !== 'scrape' && data && data.page < pagesTotal && (
              <div className="flex items-center justify-center mt-4 pt-3 border-t border-border-subtle">
                <button
                  onClick={async () => {
                    setErr(null);
                    try {
                      const j = await apiGet<LogResp>(`/api/admin/log?type=${tab}&page=${data.page + 1}&limit=${PAGE_SIZE}`);
                      setData((prev) => prev ? { ...j.data, rows: [...prev.rows, ...j.data.rows] } : j.data);
                    } catch {
                      setErr('Gagal memuat halaman berikutnya.');
                    }
                  }}
                  className="px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors"
                >
                  Muat lebih banyak ({fmtNum(data.total - data.page * PAGE_SIZE)} tersisa)
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}