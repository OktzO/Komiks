'use client';
import { useEffect, useState } from 'react';
import { listSessions, revokeSession, revokeAllSessions, getCurrentSessionToken } from '@/lib/api';
import type { SessionMeta } from '@/lib/api';

export function SessionsSection() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listSessions();
      setSessions(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    setCurrent(getCurrentSessionToken());
  }, []);

  const revokeOne = async (token: string) => {
    setRevoking((s) => new Set(s).add(token));
    try {
      await revokeSession(token);
      setSessions((s) => s.filter((x) => x.token !== token));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRevoking((s) => {
        const copy = new Set(s);
        copy.delete(token);
        return copy;
      });
    }
  };

  const revokeOthers = async () => {
    setRevoking(new Set(sessions.filter((s) => s.token !== current).map((s) => s.token)));
    try {
      const res = await revokeAllSessions();
      setSessions((s) => s.filter((x) => x.token === current));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRevoking(new Set());
    }
  };

  const fmtUa = (ua: string): string => {
    const isMobile = /Mobile|Android|iPhone|iPad/.test(ua);
    const isMac = /Mac OS X/.test(ua);
    const isWin = /Windows NT/.test(ua);
    let device = isMobile ? 'Mobile' : isMac ? 'Mac' : isWin ? 'Windows' : 'Device';
    let os = '';
    if (isMac && !isMobile) os = 'macOS';
    else if (isWin) os = 'Windows';
    else if (isMobile) os = 'Mobile OS';
    return `${device}${os ? ' · ' + os : ''}`;
  };

  const relTime = (ts: number): string => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s > 86400) return Math.floor(s / 86400) + 'd ago';
    if (s > 3600) return Math.floor(s / 3600) + 'h ago';
    if (s > 60) return Math.floor(s / 60) + 'm ago';
    return 'baru saja';
  };

  return (
    <section id="sessions" className="mb-8 scroll-mt-20">
      <h2 className="text-lg font-semibold text-primary mb-1">Sesi Aktif</h2>
      <p className="text-sm text-muted mb-4">Device yang sedang login dengan akun ini.</p>

      {error && <p className="text-xs text-error mb-2">{error}</p>}
      {loading && <p className="text-sm text-secondary">Memuat sesi...</p>}

      {!loading && sessions.length > 0 && (
        <ul className="divide-y divide-border-subtle border border-subtle rounded-xl bg-card">
          {sessions.map((s) => {
            const isCurrent = s.token === current;
            return (
              <li key={s.token} className="flex items-center justify-between p-3">
                <div className="min-w-0">
                  <p className="text-sm text-primary truncate">{fmtUa(s.ua)}</p>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span>{new Date(s.lastSeen).toLocaleDateString('id-ID')}</span>
                    <span>•</span>
                    <span>{relTime(s.createdAt)}</span>
                    {isCurrent && <span className="text-accent font-medium"> (ini perangkat)</span>}
                  </div>
                </div>
                <button
                  onClick={() => revokeOne(s.token)}
                  disabled={isCurrent || revoking.has(s.token)}
                  className={`px-3 py-1.5 text-xs border border-border-default rounded-lg transition-colors ${
                    isCurrent
                      ? 'text-muted cursor-default'
                      : 'text-secondary hover:text-error hover:border-error/30 hover:bg-error/10 disabled:opacity-50'
                  }`}
                  title={isCurrent ? 'Sesi ini yang sedang dipakai' : 'Logout sesi ini'}
                >
                  {revoking.has(s.token) ? '...' : isCurrent ? 'Aktif' : 'Logout'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && sessions.length === 0 && (
        <p className="text-sm text-secondary">Tidak ada sesi lain yang aktif.</p>
      )}

      {!loading && sessions.filter((s) => s.token !== current).length > 0 && (
        <button
          onClick={revokeOthers}
          disabled={revoking.size > 0}
          className="mt-4 px-4 py-2 text-sm font-medium text-error border border-error/30 rounded-lg hover:bg-error/10 transition-colors disabled:opacity-50"
        >
          {revoking.size > 0 ? '...' : 'Logout Semua Sesi Lain'}
        </button>
      )}
    </section>
  );
}
