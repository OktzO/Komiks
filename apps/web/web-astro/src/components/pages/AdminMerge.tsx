'use client';
import { useEffect, useState, useCallback } from 'react';
import { fetchMe, apiGet, apiPost, roleLabel, type AuthUser } from '@/lib/api';

type QueueItem = {
  id: number;
  source: string;
  source_slug: string;
  title: string;
  candidate_ids: string;
  confidence: number;
  status: string;
  created_at: number;
};

type SeriesRow = { id: number; slug: string; title: string; source: string };

export default function AdminMergePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [resolving, setResolving] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [candidateMap, setCandidateMap] = useState<Record<number, SeriesRow | null>>({});
  
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

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await apiGet<{ data: QueueItem[]; candidates: Record<number, SeriesRow | null> }>('/api/admin/merge/queue?status=pending');
      const pending = res.data ?? [];
      setItems(pending);
      setCandidateMap(res.candidates ?? {});
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') load();
  }, [user, load]);

  const resolve = async (item: QueueItem, action: 'merge' | 'reject', targetMangaId?: number) => {
    setResolving(item.id);
    setMsg(null);
    setErr(null);
    try {
      await apiPost(`/api/admin/merge/queue/${item.id}`, { action, targetMangaId });
      setMsg(`#${item.id} ${action}${targetMangaId ? ' → ' + targetMangaId : ''}`);
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setResolving(null);
    }
  };

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-4">
          {[...Array(3)].map((_, i) => (<div key={i} className="h-16 w-full rounded-lg bg-card" />))}
        </div>
      </main>
    );
  }
  if (!user || user.role !== 'admin') return null;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-primary">Merge Queue</h1>
          <p className="text-sm text-muted mt-1">{user.email} · {roleLabel(user.role)}</p>
        </div>
        <button
          onClick={load}
          className="px-4 py-2 text-sm text-primary border border-border-default rounded-full hover:bg-bg-secondary transition-colors"
        >Reload</button>
      </div>

      {err && (
        <div className="mb-6 text-sm text-error border border-error/40 rounded-lg p-3 bg-error/5">{err}</div>
      )}
      {msg && (
        <div className="mb-6 text-sm text-accent border border-accent/40 rounded-lg p-3 bg-accent/5">{msg}</div>
      )}

      {items.length === 0 ? (
        <div className="admin-card p-8 text-center">
          <p className="text-sm text-muted">No pending merges. Duplicates detected on the index path land here for review.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => {
            const ids = (() => { try { return JSON.parse(it.candidate_ids) as number[]; } catch { return []; } })();
            return (
              <li key={it.id} className="admin-card p-4">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-sm text-primary font-medium">{it.title}</span>
                  <span className="text-xs text-muted">#{it.id}</span>
                  <span className="text-xs text-muted">{it.source} · {it.source_slug}</span>
                  <span className="text-xs text-muted">score {(it.confidence * 100).toFixed(0)}%</span>
                  <span className="text-xs text-muted">queued {new Date(it.created_at * 1000).toLocaleString('id-ID')}</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {ids.map((id) => {
                    const s = candidateMap[id];
                    return (
                      <button
                        key={id}
                        disabled={resolving === it.id}
                        onClick={() => resolve(it, 'merge', id)}
                        className="text-left text-xs p-2 rounded-md border border-border-default hover:border-accent hover:bg-accent/5 transition-colors disabled:opacity-50"
                      >
                        <div className="text-primary">{s ? s.title : 'unknown'}</div>
                        <div className="text-muted">id {id} · source {s ? s.source : '—'} · slug {s ? s.slug : '—'}</div>
                        <div className="text-accent mt-1">merge into this →</div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    disabled={resolving === it.id}
                    onClick={() => resolve(it, 'reject')}
                    className="px-3 py-1.5 text-xs text-error border border-error/40 rounded-md hover:bg-error/5 transition-colors disabled:opacity-50"
                  >Reject</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
