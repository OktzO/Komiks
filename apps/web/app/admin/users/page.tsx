'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fetchMe, apiGet, roleLabel, type AuthUser } from '@/lib/api';

type UserSummary = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  created_at: number;
  last_login_at: number | null;
  bookmark_count: number;
};

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function AdminUsersPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const limit = 20;

  useEffect(() => {
    fetchMe().then((u) => {
      setUser(u);
      setLoading(false);
      if (!u || u.role !== 'admin') router.replace('/');
    });
  }, [router]);

  const loadUsers = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (q) params.set('q', q);
      const res = await apiGet<{ data: UserSummary[]; total: number; page: number }>(`/api/admin/users?${params}`);
      setUsers(res.data || []);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, [page, q]);

  useEffect(() => {
    if (user?.role === 'admin') {
      const t = setTimeout(loadUsers, q ? 300 : 0);
      return () => clearTimeout(t);
    }
  }, [user, loadUsers, q]);

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 w-full rounded-lg bg-card" />
          ))}
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') return null;

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/admin" className="text-sm text-secondary hover:text-primary transition-colors mb-2 inline-block">
            ← Overview
          </Link>
          <h1 className="text-2xl font-semibold text-primary">Users</h1>
          <p className="text-sm text-muted mt-1">{total} registered</p>
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className={`status-dot ${refreshing ? 'live' : 'unknown'}`} />
          {refreshing ? 'refreshing' : 'live'}
        </span>
      </div>

      {error && (
        <div className="mb-4 text-sm text-error border border-error/40 rounded-lg p-3 bg-error/5">
          {error}
        </div>
      )}

      <input
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value); setPage(1); }}
        placeholder="Search by email or name..."
        className="w-full bg-base border border-border-default rounded-lg px-3 py-2 mb-4 text-primary placeholder:text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
      />

      <div className="border border-subtle rounded-lg overflow-hidden bg-card">
        <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs text-muted border-b border-subtle">
          <div className="col-span-4">Email</div>
          <div className="col-span-2">Role</div>
          <div className="col-span-2 text-right">Bookmarks</div>
          <div className="col-span-2 text-right">Joined</div>
          <div className="col-span-2 text-right">Last login</div>
        </div>
        {users.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted text-center">
            No users found.
          </div>
        ) : (
          users.map((u) => (
            <Link
              key={u.id}
              href={`/admin/users/${u.id}`}
              className="grid grid-cols-12 gap-2 px-4 py-3 items-center text-sm border-b border-subtle last:border-0 hover:bg-bg-secondary/30 transition-colors"
            >
              <div className="col-span-4 min-w-0">
                <div className="text-primary truncate">{u.email}</div>
                {u.name && <div className="text-xs text-muted truncate">{u.name}</div>}
              </div>
              <div className="col-span-2">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${u.role === 'admin' ? 'border-accent/40 text-accent' : 'border-border-default text-secondary'}`}>
                  {roleLabel(u.role)}
                </span>
              </div>
              <div className="col-span-2 text-right font-mono tabular text-secondary">{u.bookmark_count}</div>
              <div className="col-span-2 text-right text-xs text-muted">{formatDate(u.created_at)}</div>
              <div className="col-span-2 text-right text-xs text-muted">{formatDate(u.last_login_at)}</div>
            </Link>
          ))
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-xs text-muted font-mono tabular">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </main>
  );
}
