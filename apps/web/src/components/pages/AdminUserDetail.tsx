'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchMe, apiGet, roleLabel, isValidType, typedUrl, type AuthUser, type ComicType } from '@/lib/api';
import { Card, CardHead, fmtNum, EmptyState } from '@/components/admin/charts';

// Admin bookmarks API belum kirim `type` — safeType(undefined) → '/manga'
// (route kanonik redirect ke type benar). Field opsional siap saat API nambah.
const safeType = (t?: string | null): ComicType =>
  isValidType(t ?? '') ? (t as ComicType) : 'manga';

type UserDetail = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  created_at: number;
  last_login_at: number | null;
  bookmark_count: number;
};

type BookmarkRow = {
  series_slug: string;
  title: string | null;
  cover_image: string | null;
  added_at: number;
  type?: string | null;
};

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRelative(ts: number | null): string {
  if (!ts) return 'belum pernah';
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} menit lalu`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} jam lalu`;
  return `${Math.floor(diffSec / 86400)} hari lalu`;
}

export default function AdminUserDetailPage({ id }: { id: string }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const [bmPage, setBmPage] = useState(1);
  const [bmTotal, setBmTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
      const userId = Number(id);
  const bmLimit = 20;

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

  // Sequence counter: respons lambat dari request sebelumnya tidak boleh
  // menimpa data page yang lebih baru saat paginasi cepat.
  const bmSeq = useRef(0);

  const loadDetail = useCallback(async () => {
    if (!Number.isFinite(userId)) { setError('invalid user id'); return; }
    try {
      const res = await apiGet<{ data: UserDetail }>(`/api/admin/users/${userId}`);
      setDetail(res.data);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [userId]);

  const loadBookmarks = useCallback(async () => {
    if (!Number.isFinite(userId)) return;
    const seq = ++bmSeq.current;
    try {
      const res = await apiGet<{ data: BookmarkRow[]; total: number; page: number }>(
        `/api/admin/users/${userId}/bookmarks?page=${bmPage}&limit=${bmLimit}`
      );
      if (seq !== bmSeq.current) return;
      setBookmarks(res.data || []);
      setBmTotal(res.total);
    } catch (e) {
      // bookmarks may fail silently — keep detail visible
    }
  }, [userId, bmPage]);

  useEffect(() => {
    if (user?.role === 'admin') {
      loadDetail();
      loadBookmarks();
    }
  }, [user, loadDetail, loadBookmarks]);

  if (loading) {
    return (
      <div className="admin-page space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 w-full rounded-2xl bg-elevated animate-pulse" />
        ))}
      </div>
    );
  }

  if (!user || user.role !== 'admin') return null;

  const bmTotalPages = Math.max(1, Math.ceil(bmTotal / bmLimit));

  return (
    <div className="admin-page space-y-6">
      <a href="/admin/users" className="text-sm text-secondary hover:text-primary transition-colors mb-4 inline-block">
        ← Users
      </a>

      {error && (
        <div className="mb-4 text-sm text-error border border-error/40 rounded-lg p-3 bg-error/5">
          {error}
        </div>
      )}

      {detail ? (
        <>
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <h1 className="text-lg font-semibold tracking-tight text-primary truncate">{detail.email}</h1>
              <span className={`text-xs px-2 py-0.5 rounded-full border ${detail.role === 'admin' ? 'border-accent/40 text-accent' : 'border-border-default text-secondary'}`}>
                {roleLabel(detail.role)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-[11px] text-muted mb-0.5">Nama</div>
                <div className="text-primary">{detail.name || '—'}</div>
              </div>
              <div>
                <div className="text-[11px] text-muted mb-0.5">Bookmark</div>
                <div className="text-primary font-mono tabular">{detail.bookmark_count}</div>
              </div>
              <div>
                <div className="text-[11px] text-muted mb-0.5">Terdaftar</div>
                <div className="text-primary">{formatDate(detail.created_at)}</div>
              </div>
              <div>
                <div className="text-[11px] text-muted mb-0.5">Login terakhir</div>
                <div className="text-primary">
                  {formatDate(detail.last_login_at)}
                  {detail.last_login_at && <span className="text-xs text-muted ml-2">({formatRelative(detail.last_login_at)})</span>}
                </div>
              </div>
            </div>
          </Card>

          {/* Disabled action placeholders — read-only scope per spec */}
          <div className="flex flex-wrap gap-2">
            <button
              disabled
              title="Coming soon — admin write actions out of scope"
              className="px-3 py-1.5 text-xs text-muted border border-border-default rounded-xl opacity-50 cursor-not-allowed"
            >
              Edit
            </button>
            <button
              disabled
              title="Coming soon — admin write actions out of scope"
              className="px-3 py-1.5 text-xs text-muted border border-border-default rounded-xl opacity-50 cursor-not-allowed"
            >
              Ban
            </button>
            <button
              disabled
              title="Coming soon — admin write actions out of scope"
              className="px-3 py-1.5 text-xs text-muted border border-border-default rounded-xl opacity-50 cursor-not-allowed"
            >
              Delete
            </button>
          </div>

          <Card>
            <CardHead title="Bookmark" hint={`${fmtNum(bmTotal)} total`} />
            <div className="admin-inner divide-y divide-border-subtle overflow-hidden">
              {bookmarks.length === 0 ? (
                <EmptyState>Tidak ada bookmark.</EmptyState>
              ) : (
                bookmarks.map((b) => (
                  <div key={b.series_slug} className="flex items-center gap-3 px-4 py-3">
                    {b.cover_image ? (
                      <img src={b.cover_image} alt="" className="w-10 h-14 object-cover rounded shrink-0 bg-bg-secondary" loading="lazy" />
                    ) : (
                      <div className="w-10 h-14 rounded bg-bg-secondary shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <a href={typedUrl(safeType(b.type), b.series_slug)}
                        className="text-sm text-primary hover:text-accent transition-colors truncate block"
                      >
                        {b.title || b.series_slug}
                      </a>
                      <div className="text-xs text-muted">ditambahkan {formatDate(b.added_at)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {bmTotalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <button
                  onClick={() => setBmPage((p) => Math.max(1, p - 1))}
                  disabled={bmPage <= 1}
                  className="px-3 py-1.5 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-40"
                >
                  ← Prev
                </button>
                <span className="text-xs text-muted font-mono tabular">{bmPage} / {bmTotalPages}</span>
                <button
                  onClick={() => setBmPage((p) => Math.min(bmTotalPages, p + 1))}
                  disabled={bmPage >= bmTotalPages}
                  className="px-3 py-1.5 text-sm text-secondary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            )}
          </Card>
        </>
      ) : (
        !error && <div className="text-sm text-muted">Loading...</div>
      )}
    </div>
  );
}