'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiGet, fetchMe, type AuthUser } from '@/lib/api';
import { Card, CardHead, StatCard, AreaChart, StorageDonut, fmtNum, fmtBytes } from '@/components/admin/charts';

type SavedSummary = {
  series_total: number;
  chapters_total: number;
  pages_stored: number;
  per_source: Array<{ source: string; series: number; chapters: number; last_scraped_at: number | null }>;
};
type SavedSeries = { slug: string; title: string; source: string; chapter_count: number; last_scraped_at: number | null };
type SavedChapter = { series_slug: string; series_title: string; chapter_id: string; chapter_number: number; pages_count: number; created_at: number };
type SavedResp = {
  summary: SavedSummary;
  series: SavedSeries[];
  chapters: SavedChapter[];
  total: number;
  page: number;
  limit: number;
};
type StorageResp = {
  data: {
    accounts: Array<{ idx: number; name: string; bucket: string; bytes: number | null; quota: number }>;
    total_bytes: number | null;
    d1_bytes: number | null;
    quota: number;
    /* trend: Array<{ db_name: string; points: Array<{ ts: number; size_bytes: number | null; rows_or_objects: number | null }> }> */
    trend: Array<{ db_name: string; points: Array<{ ts: number; size_bytes: number | null; rows_or_objects: number | null }> }>;
  };
};

function IconBook({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function IconLayers({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 2 10 6-10 6L2 8l10-6z" />
      <path d="m2 14 10 6 10-6" />
    </svg>
  );
}
function IconHash({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
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

const fmtRel = (ts: number | null): string => {
  if (!ts) return 'belum pernah';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 60) return `${d} detik lalu`;
  if (d < 3600) return `${Math.floor(d / 60)} mnt lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)} jam lalu`;
  return `${Math.floor(d / 86400)} hari lalu`;
};
const fmtRelIso = (ts: number | null): string => {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('id-ID', { dateStyle: 'medium' });
};

const PAGE_SIZE = 20;

export default function AdminSavedPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedResp | null>(null);
  const [storage, setStorage] = useState<StorageResp['data'] | null>(null);
  const [page, setPage] = useState(1);

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

  const load = useCallback(async (p: number) => {
    setErr(null);
    try {
      const [s, st] = await Promise.all([
        apiGet<{ data: SavedResp }>(`/api/admin/saved?page=${p}&limit=${PAGE_SIZE}`),
        apiGet<StorageResp>('/api/admin/dashboard/storage'),
      ]);
      setSaved(s.data);
      setStorage(st.data);
      setPage(p);
    } catch (e) {
      setErr('Gagal memuat data konten tersimpan. Coba lagi.');
    }
  }, []);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    setLoading(true);
    load(1).finally(() => setLoading(false));
  }, [load, user]);

  if (loading) {
    return (
      <div className="admin-page space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 rounded-2xl bg-elevated" />)}
        </div>
        <div className="h-64 rounded-2xl bg-elevated" />
      </div>
    );
  }

  if (err) {
    return (
      <div className="admin-page py-8">
        <div className="text-sm text-error border border-error/30 rounded-xl p-3 bg-error/5">{err}</div>
      </div>
    );
  }

  const s = saved?.summary;
  const pagesTotal = Math.max(1, Math.ceil((saved?.total ?? 0) / PAGE_SIZE));
  const sourceBarMax = Math.max(1, ...(s?.per_source.map((x) => x.chapters) ?? [1]));
  const trendPoints = (storage?.trend ?? []).map((t) => t.points).flat().map((p) => p.size_bytes ?? 0);
  const trendLabels = (storage?.trend ?? []).map((t) => t.points).flat().map((p) => p.ts ? new Date(p.ts * 1000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : '');

  return (
    <div className="admin-page space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Konten Tersimpan</h1>
        <p className="text-[13px] text-muted mt-1">Judul, chapter, dan panel hasil scrape di storage B2.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<IconBook className="w-4 h-4" />} label="Judul tersimpan" value={fmtNum(s?.series_total ?? 0)} sub="dengan chapter" />
        <StatCard icon={<IconLayers className="w-4 h-4" />} label="Chapter tersimpan" value={fmtNum(s?.chapters_total ?? 0)} sub="total chapter" />
        <StatCard icon={<IconHash className="w-4 h-4" />} label="Panel tersimpan" value={fmtNum(s?.pages_stored ?? 0)} sub="objek di B2" />
        <StatCard icon={<IconChart className="w-4 h-4" />} label="Storage dipakai" value={fmtBytes(storage?.total_bytes ?? null)} sub={`${fmtBytes(storage?.d1_bytes ?? null)} estimasi D1`} />
      </div>

      <Card delay={60}>
        <CardHead icon={<IconChart className="w-4 h-4" />} title="Distribusi per source" hint="judul & chapter tersimpan per source aggregasi" />
        <div className="space-y-3">
          {(s?.per_source ?? []).map((row) => (
            <div key={row.source} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-[12px] text-secondary truncate uppercase tracking-wide">{row.source}</span>
              <div className="flex-1 h-6 flex items-center gap-2">
                <div className="flex-1 h-2.5 rounded-full bg-bg-secondary overflow-hidden">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(row.chapters / sourceBarMax) * 100}%` }} />
                </div>
                <span className="text-[11px] text-muted tabular w-20 text-right">{row.series} judul · {row.chapters} chapter</span>
              </div>
            </div>
          ))}
          {(s?.per_source ?? []).length === 0 && (
            <p className="text-[13px] text-muted leading-relaxed">Belum ada konten tersimpan dari source mana pun. Jalankan scrape dulu.</p>
          )}
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        {storage && (
          <StorageDonut
            accounts={storage.accounts}
            totalBytes={storage.total_bytes}
            quota={storage.quota}
            d1Bytes={storage.d1_bytes}
            tracked
            icon={<IconChart className="w-4 h-4" />}
          />
        )}
        <Card delay={120}>
          <CardHead icon={<IconChart className="w-4 h-4" />} title="Tren penyimpanan" hint="db_usage_snapshot · 30 hari" />
          {(trendPoints.length >= 2 ? (
            <AreaChart points={trendPoints} labels={trendLabels} />
          ) : (
            <p className="text-[13px] text-muted leading-relaxed py-8 text-center">Belum cukup data tren penyimpanan.</p>
          ))}
        </Card>
      </div>

      <Card delay={160}>
        <CardHead icon={<IconBook className="w-4 h-4" />} title="Judul tersimpan" hint="urut chapter terbanyak" />
        {(saved?.series ?? []).length === 0 ? (
          <p className="text-[13px] text-muted leading-relaxed py-8 text-center">Belum ada judul tersimpan.</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {(saved?.series ?? []).map((row) => (
              <div key={row.slug} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[13px] text-primary truncate">{row.title}</p>
                  <p className="text-[11px] text-muted mt-0.5 uppercase tracking-wide">{row.source}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[13px] text-primary tabular">{row.chapter_count} chapter</p>
                  <p className="text-[11px] text-muted mt-0.5">{fmtRel(row.last_scraped_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card delay={200}>
        <CardHead icon={<IconLayers className="w-4 h-4" />} title="Chapter terbaru" hint={`${fmtNum(saved?.total ?? 0)} chapter · halaman ${page}`} />
        {(saved?.chapters ?? []).length === 0 ? (
          <p className="text-[13px] text-muted leading-relaxed py-8 text-center">Belum ada chapter tersimpan.</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {(saved?.chapters ?? []).map((row) => (
              <div key={row.chapter_id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[13px] text-primary truncate">{row.series_title}</p>
                  <p className="text-[11px] text-muted mt-0.5 truncate">Chapter {row.chapter_number}{row.series_slug ? ` · ${row.series_slug}` : ''}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[13px] text-primary tabular">{row.pages_count} panel</p>
                  <p className="text-[11px] text-muted mt-0.5">{fmtRelIso(row.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {pagesTotal > 1 && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-border-subtle">
            <button
              disabled={page <= 1}
              onClick={() => load(page - 1)}
              className="px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors disabled:opacity-50"
            >Sebelumnya</button>
            <span className="text-[12px] text-muted tabular">{page} / {pagesTotal}</span>
            <button
              disabled={page >= pagesTotal}
              onClick={() => load(page + 1)}
              className="px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors disabled:opacity-50"
            >Berikutnya</button>
          </div>
        )}
      </Card>
    </div>
  );
}