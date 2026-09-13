'use client';
import { useEffect, useState, useCallback } from 'react';
import { fetchMe, apiGet, apiPatch, roleLabel, type AuthUser } from '@/lib/api';

type UserSummary = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  status: string;
  created_at: number;
  last_login_at: number | null;
  bookmark_count: number;
};

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtRel(ts: number | null): string {
  if (!ts) return '—';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 3600) return `${Math.floor(d / 60)} mnt lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)} jam lalu`;
  return `${Math.floor(d / 86400)} hari lalu`;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'text-success border-success/30 bg-success/10',
    suspended: 'text-[oklch(70%_0.12_75)] border-[oklch(70%_0.12_75)]/30 bg-[oklch(70%_0.12_75)]/10',
    banned: 'text-error border-error/30 bg-error/10',
  };
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${map[status] ?? 'text-secondary border-border-default'}`}>
      {status}
    </span>
  );
}

type ConfirmState = {
  user: UserSummary;
  action: 'ban' | 'suspend' | 'activate' | 'make_admin' | 'make_member';
} | null;

export default function AdminUsersPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
    const limit = 20;

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

  const runAction = useCallback(async (target: UserSummary, action: NonNullable<ConfirmState>['action']) => {
    setBusy(true);
    setError(null);
    try {
      const patch: { status?: string; role?: string } = {};
      if (action === 'ban') patch.status = 'banned';
      if (action === 'suspend') patch.status = 'suspended';
      if (action === 'activate') patch.status = 'active';
      if (action === 'make_admin') patch.role = 'admin';
      if (action === 'make_member') patch.role = 'user';
      await apiPatch(`/api/admin/users/${target.id}`, patch);
      await loadUsers();
      setConfirm(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [loadUsers]);

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

  const confirmText = (c: NonNullable<ConfirmState>) => {
    switch (c.action) {
      case 'ban': return `Ban ${c.user.name || c.user.email}? Semua sesi dicabut & user tidak bisa login lagi.`;
      case 'suspend': return `Suspend ${c.user.name || c.user.email}? User tidak bisa login sampai di-aktifkan ulang.`;
      case 'activate': return `Aktifkan kembali ${c.user.name || c.user.email}?`;
      case 'make_admin': return `Jadikan ${c.user.name || c.user.email} admin? Mereka dapat akses penuh ke panel ini.`;
      case 'make_member': return `Turunkan ${c.user.name || c.user.email} jadi member?`;
    }
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
      <div className="flex items-center justify-between mb-6">
        <div>
          <a href="/admin" className="text-sm text-secondary hover:text-primary transition-colors mb-2 inline-block">
            ← Dashboard
          </a>
          <h1 className="text-2xl font-semibold text-primary">Users</h1>
          <p className="text-sm text-muted mt-1">{total} registered</p>
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className={`status-dot ${refreshing ? 'live' : 'unknown'}`} />
          {refreshing ? 'refreshing' : 'live'}
        </span>
      </div>

      {error && (
        <div className="mb-4 text-sm text-error border border-error/40 rounded-lg p-3 bg-error/5">{error}</div>
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
          <div className="col-span-4">User</div>
          <div className="col-span-1">Role</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-1 text-right">Bm</div>
          <div className="col-span-2 text-right">Last login</div>
          <div className="col-span-2 text-right">Aksi</div>
        </div>
        {users.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted text-center">No users found.</div>
        ) : (
          users.map((u) => (
            <div key={u.id} className="grid grid-cols-12 gap-2 px-4 py-3 items-center text-sm border-b border-subtle last:border-0 hover:bg-bg-secondary/30 transition-colors">
              <div className="col-span-4 min-w-0">
                <a href={`/admin/users/${u.id}`} className="text-primary truncate block hover:text-accent transition-colors">{u.email}</a>
                {u.name && <div className="text-xs text-muted truncate">{u.name}</div>}
              </div>
              <div className="col-span-1">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${u.role === 'admin' ? 'border-accent/40 text-accent' : 'border-border-default text-secondary'}`}>
                  {roleLabel(u.role)}
                </span>
              </div>
              <div className="col-span-2"><StatusBadge status={u.status} /></div>
              <div className="col-span-1 text-right font-mono tabular text-secondary">{u.bookmark_count}</div>
              <div className="col-span-2 text-right text-xs text-muted">{fmtRel(u.last_login_at)}</div>
              <div className="col-span-2 flex items-center justify-end gap-1">
                {u.status !== 'banned' && u.status !== 'suspended' ? (
                  <>
                    <button onClick={() => setConfirm({ user: u, action: 'suspend' })}
                      className="text-[10px] px-2 py-1 rounded border border-border-default text-secondary hover:text-[oklch(70%_0.12_75)] hover:border-[oklch(70%_0.12_75)]/40 transition-colors">
                      suspend
                    </button>
                    <button onClick={() => setConfirm({ user: u, action: 'ban' })}
                      className="text-[10px] px-2 py-1 rounded border border-border-default text-secondary hover:text-error hover:border-error/40 transition-colors">
                      ban
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirm({ user: u, action: 'activate' })}
                    className="text-[10px] px-2 py-1 rounded border border-border-default text-secondary hover:text-success hover:border-success/40 transition-colors">
                    activate
                  </button>
                )}
                {u.role === 'admin' ? (
                  <button onClick={() => setConfirm({ user: u, action: 'make_member' })}
                    className="text-[10px] px-2 py-1 rounded border border-border-default text-secondary hover:text-secondary transition-colors">
                    → member
                  </button>
                ) : (
                  <button onClick={() => setConfirm({ user: u, action: 'make_admin' })}
                    className="text-[10px] px-2 py-1 rounded border border-border-default text-secondary hover:text-accent transition-colors">
                    → admin
                  </button>
                )}
              </div>
            </div>
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

      {/* Confirm dialog — destructive actions never fire without explicit confirm */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-2xl border border-border-default bg-elevated p-6 shadow-2xl">
            <h2 className="text-base font-medium text-primary mb-2">
              {confirm.action === 'ban' ? 'Ban user' : confirm.action === 'suspend' ? 'Suspend user' : 'Konfirmasi'}
            </h2>
            <p className="text-sm text-secondary mb-5">{confirmText(confirm)}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirm(null)}
                disabled={busy}
                className="px-4 py-2 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-40"
              >
                Batal
              </button>
              <button
                onClick={() => runAction(confirm.user, confirm.action)}
                disabled={busy}
                className={`px-4 py-2 text-sm rounded-lg transition-colors disabled:opacity-40 ${
                  confirm.action === 'ban'
                    ? 'bg-error/15 text-error border border-error/40 hover:bg-error/25'
                    : confirm.action === 'suspend'
                      ? 'bg-[oklch(70%_0.12_75)]/15 text-[oklch(70%_0.12_75)] border border-[oklch(70%_0.12_75)]/40 hover:bg-[oklch(70%_0.12_75)]/25'
                      : 'bg-accent text-white hover:bg-accent-hover'
                }`}
              >
                {busy ? '…' : 'Ya, lanjutkan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
