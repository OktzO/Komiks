'use client';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { fetchMe, apiGet, getAuthApiUrl, roleLabel, type AuthUser } from '@/lib/api';

const BLUE = 'var(--accent)';
const GREEN = 'var(--success)';
const YELLOW = 'oklch(70% 0.12 75)';
const ORANGE = 'oklch(70% 0.12 75)';
const RED = 'var(--error)';
const PURPLE = 'var(--text-secondary)';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Sparkles({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2l1.8 4.6L18 8.4l-4.2 1.8L12 14.8l-1.8-4.6L6 8.4l4.2-1.8L12 2zm6.5 10l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3zM5 12l.7 1.8L7.5 14.5l-1.8.7L5 17l-.7-1.8-1.8-.7 1.8-.7L5 12z" />
    </svg>
  );
}

function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function BarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 3v18h18" />
      <path d="M7 16v-5M12 16V8M17 16v-9" />
    </svg>
  );
}

// ── Revenue / activity chart: 12 bars from scrape trend ──
function ActivityChart({ data }: { data: number[] }) {
  const [active, setActive] = useState(-1);
  const max = Math.max(...data, 1);
  const total = data.reduce((a, b) => a + b, 0);
  const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (
    <div className="col-span-12 lg:col-span-8 bg-elevated border border-border-subtle rounded-2xl p-6 anim-slide-up">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-sm text-secondary">Scrape activity · 12h</h2>
          <div className="flex items-end gap-3 mt-1">
            <span className="text-4xl font-semibold tabular tracking-tight text-primary">{total.toLocaleString('en-US')}</span>
            <span className="text-xs font-medium px-2 py-1 rounded-full bg-[var(--success)]/10 text-success mb-1">+8.3%</span>
          </div>
        </div>
        <div className="flex gap-1 p-1 rounded-full bg-black/30">
          {['Weekly', 'Monthly', 'Yearly'].map((t, i) => (
            <button key={t} className={`px-3 py-1.5 text-xs rounded-full transition-all duration-200 ${i === 2 ? 'bg-accent text-[var(--bg-base)] font-medium' : 'text-secondary hover:text-secondary'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="h-40 flex items-end gap-1.5">
        {data.map((v, i) => {
          const h = Math.max(4, (v / max) * 100);
          const isActive = active === i;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1" onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(-1)}>
              {isActive && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-[var(--bg-base)] font-medium whitespace-nowrap transition-opacity duration-200">
                  {v > 0 ? `+${v}` : '0'} · {v.toLocaleString('en-US')}
                </span>
              )}
              <div className="w-full rounded-sm transition-colors duration-200 relative overflow-hidden" style={{ height: `${h}%`, background: isActive ? BLUE : 'transparent', border: isActive ? 'none' : '1px solid rgba(255,255,255,0.12)' }}>
                <div className="absolute inset-0" style={{ background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.14) 0 2px, transparent 2px 5px)', opacity: isActive ? 0 : 1 }} />
              </div>
              <span className={`text-[10px] tabular ${isActive ? 'text-secondary' : 'text-muted'}`}>{labels[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Calendar widget ──
function CalendarCard({ now, todayScrapes }: { now: Date; todayScrapes: number }) {
  const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const firstDay = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells = useMemo(() => {
    const prevDays = new Date(view.y, view.m, 0).getDate();
    const out: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(d);
    while (out.length % 7 !== 0) out.push(null);
    return out.map((d, i) => {
      if (d !== null) return d;
      const offset = i - firstDay;
      return offset < 0 ? -(prevDays + offset) : offset - daysInMonth + 1;
    });
  }, [view, firstDay, daysInMonth]);

  const shift = (n: number) => setView(({ y, m }) => {
    const d = new Date(y, m + n, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const isToday = (d: number) => view.y === now.getFullYear() && view.m === now.getMonth() && d === now.getDate();

  return (
    <div className="col-span-12 lg:col-span-4 bg-elevated border border-border-subtle rounded-2xl p-6 anim-slide-up">
      <div className="flex items-center justify-between mb-5">
        <span className="text-sm font-medium text-primary">{MONTHS[view.m]}, {view.y}</span>
        <div className="flex gap-1">
          <button onClick={() => shift(-1)} className="w-7 h-7 flex items-center justify-center rounded-full text-secondary hover:text-secondary hover:bg-bg-secondary transition-colors" aria-label="Previous month">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={() => shift(1)} className="w-7 h-7 flex items-center justify-center rounded-full text-secondary hover:text-secondary hover:bg-bg-secondary transition-colors" aria-label="Next month">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center mb-1">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i} className="text-[10px] text-muted font-medium py-1">{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {cells.map((d, i) => {
          const out = d <= 0;
          const today = isToday(d);
          return (
            <div key={i} className={`relative aspect-square flex items-center justify-center rounded-full text-xs tabular transition-colors duration-200 ${out ? 'text-muted opacity-50' : today ? 'bg-accent text-[var(--bg-base)] font-medium' : 'text-secondary hover:bg-bg-secondary'}`}>
              {Math.abs(d)}
              {today && <span className="absolute bottom-0.5 w-1 h-1 rounded-full bg-white" />}
            </div>
          );
        })}
      </div>
      <div className="mt-5 pt-4 border-t border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 flex items-center justify-center rounded-lg bg-bg-secondary/60 text-secondary"><BarIcon className="w-4 h-4" /></span>
          <div>
            <div className="text-sm font-semibold tabular tracking-tight text-primary">${todayScrapes.toLocaleString('en-US')}</div>
            <div className="text-[10px] text-muted">today</div>
          </div>
        </div>
        <span className="text-xs font-medium text-success">+12.4%</span>
      </div>
    </div>
  );
}

// ── AI summary card ──
function AISummaryCard({ settings, status }: { settings: any; status: any }) {
  const healthy = status?.origins?.filter((o: any) => o.last_health_status === 'healthy').length ?? 0;
  const total = status?.origins?.length ?? 0;
  const pct = total ? Math.round((healthy / total) * 100) : 0;
  const [readMore, setReadMore] = useState(false);
  return (
    <div className="col-span-12 md:col-span-6 lg:col-span-4 bg-elevated border border-border-subtle rounded-2xl p-6 flex flex-col anim-slide-up">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]"><Sparkles className="w-4 h-4" /></span>
        <h2 className="text-sm font-medium text-primary">How can I help you?</h2>
      </div>
      <p className="text-xs leading-relaxed text-secondary">
        Mode load balancer <span className="text-primary">{settings?.mode === 'on' ? 'aktif' : 'nonaktif'}</span>. {healthy} dari {total} origin sehat, {pct}% uptime. {settings?.implementation === 'native_cf' ? 'Native CF LB' : 'Custom steering'} digunakan untuk routing.
        {readMore && <> Rata-rata <span className="text-primary">{settings?.health_check_interval_sec ?? '—'}s</span> interval health check dengan timeout <span className="text-primary">{settings?.health_check_timeout_ms ?? '—'}ms</span> dan failure threshold {settings?.failure_threshold ?? '—'}.</>}
      </p>
      <button onClick={() => setReadMore(!readMore)} className="text-xs text-[var(--accent)] hover:underline mt-1 self-start">...Read {readMore ? 'less' : 'more'}</button>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <div className="bg-base/50 border border-border-subtle rounded-xl p-3">
          <div className="text-[10px] text-muted mb-1">Spending Trends</div>
          <div className="text-xs font-medium text-primary">{settings?.mode === 'on' ? 'Active' : 'Off'}</div>
          <span className="inline-block mt-1.5 text-[10px] px-2 py-0.5 rounded-full bg-[var(--success)]/10 text-success">Stable</span>
        </div>
        <div className="bg-base/50 border border-border-subtle rounded-xl p-3">
          <div className="text-[10px] text-muted mb-1">Customer Payments</div>
          <div className="text-xs font-medium text-primary">{healthy} origin</div>
          <span className="inline-block mt-1.5 text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">Processed</span>
        </div>
      </div>
      <div className="mt-auto pt-4">
        <div className="flex items-center gap-2 bg-base/50 border border-border-subtle rounded-full pl-4 pr-1.5 py-1.5">
          <input placeholder="Ask me anything..." className="flex-1 bg-transparent text-xs text-secondary placeholder:text-muted focus:outline-none" />
          <button className="w-7 h-7 flex items-center justify-center rounded-full bg-accent text-[var(--bg-base)] transition-transform duration-200 hover:scale-105" aria-label="Send">
            <SendIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Spending donut ──
function SpendingCard({ accounts, status }: { accounts: any[]; status: any }) {
  const [active, setActive] = useState(-1);
  const segs = useMemo(() => {
    const counts: { label: string; value: number; color: string }[] = [];
    const totals: Record<string, number> = { healthy: 0, degraded: 0, down: 0, unchecked: 0 };
    for (const o of status?.origins ?? []) {
      const k = o.last_health_status ?? 'unchecked';
      totals[k] = (totals[k] ?? 0) + 1;
    }
    const meta: Record<string, { label: string; color: string }> = {
      healthy: { label: 'Healthy', color: GREEN },
      degraded: { label: 'Degraded', color: YELLOW },
      down: { label: 'Down', color: RED },
      unchecked: { label: 'Unchecked', color: PURPLE },
    };
    for (const [k, v] of Object.entries(totals)) {
      if (v > 0) counts.push({ label: meta[k]?.label ?? k, value: v as number, color: meta[k]?.color ?? 'var(--text-muted)' });
    }
    if (counts.length === 0) counts.push({ label: 'No origin', value: 1, color: 'var(--text-muted)' });
    return counts;
  }, [status]);
  const grand = segs.reduce((a, b) => a + b.value, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  let acc = 0;

  return (
    <div className="col-span-12 md:col-span-6 lg:col-span-4 bg-elevated border border-border-subtle rounded-2xl p-6 anim-slide-up">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-primary">Spending</h2>
        <select defaultValue="30" className="bg-base/50 border border-border-subtle rounded-full px-3 py-1 text-xs text-secondary focus:outline-none">
          <option value="7">Last 7 Days</option>
          <option value="30">Last 30 Days</option>
          <option value="90">Last 90 Days</option>
        </select>
      </div>
      <div className="relative w-40 h-40 mx-auto mb-2">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
          {segs.map((s, i) => {
            const len = (s.value / grand) * C;
            const off = acc;
            acc += len;
            const isActive = active === i;
            return (
              <circle
                key={i}
                cx="50" cy="50" r={R} fill="none"
                stroke={s.color}
                strokeWidth={isActive ? 16 : 12}
                strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${C - Math.max(len - 1.5, 0.5)}`}
                strokeDashoffset={-off}
                strokeLinecap="round"
                className="transition-all duration-200 cursor-pointer"
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(-1)}
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-semibold tabular tracking-tight text-primary">{active >= 0 ? `$${segs[active].value.toLocaleString('en-US')}` : '$' + grand.toLocaleString('en-US')}</span>
          <span className="text-[10px] text-muted">{active >= 0 ? `${Math.round((segs[active].value / grand) * 100)}%` : 'total'}</span>
        </div>
      </div>
      <div className="space-y-1.5">
        {segs.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-xs" onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(-1)}>
            <span className="flex items-center gap-2 text-secondary"><span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
            <span className="tabular text-secondary">{Math.round((s.value / grand) * 100)}%</span>
          </div>
        ))}
      </div>
      {accounts.length > 0 && (
        <p className="mt-4 pt-3 border-t border-border-subtle text-[10px] text-muted">{accounts.length} akun terhubung</p>
      )}
    </div>
  );
}

// ── Invoices / origins list ──
function InvoicesCard({ origins, onViewAll, query }: { origins: any[]; onViewAll: () => void; query: string }) {
  const healthy = origins.filter((o) => o.enabled === 1).length;
  const score = origins.length ? Math.round((healthy / origins.length) * 100) : 0;
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = q ? origins.filter((o) => String(o.origin_url).toLowerCase().includes(q)) : origins;
    return f.slice(0, 5);
  }, [origins, query]);

  const dot = (o: any) => {
    const st = o.last_health_status;
    if (st === 'healthy') return { c: GREEN, label: 'Paid' };
    if (st === 'unhealthy' || st === 'down') return { c: RED, label: 'Unpaid' };
    return { c: ORANGE, label: 'Pending' };
  };

  return (
    <div className="col-span-12 lg:col-span-4 bg-elevated border border-border-subtle rounded-2xl p-6 anim-slide-up">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-primary">Invoices</h2>
        <span className="text-xs tabular text-secondary">{score} score</span>
      </div>
      <div className="h-1.5 rounded-full bg-bg-secondary/60 overflow-hidden mb-5">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${score}%`, background: 'repeating-linear-gradient(90deg, oklch(70% 0.12 75) 0 5px, rgba(250,204,21,0.4) 5px 9px)' }} />
      </div>
      <div className="space-y-3">
        {list.map((o) => {
          const d = dot(o);
          return (
            <div key={o.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-primary">P{o.priority}</div>
                <div className="text-[10px] text-muted">W{o.weight} · {o.enabled === 1 ? 'in week' : 'paused'}</div>
              </div>
              <span className="flex items-center gap-1.5 text-[10px] text-muted whitespace-nowrap"><span className="w-1.5 h-1.5 rounded-full" style={{ background: d.c }} />{d.label}</span>
              <div className="min-w-0 flex-1 text-right">
                <div className="text-xs text-primary truncate">{o.origin_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</div>
                <div className="text-[10px] tabular text-muted">${(o.priority * 7).toLocaleString('en-US')}</div>
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div className="text-xs text-muted text-center py-4">{query ? 'No match' : 'Belum ada origin.'}</div>}
      </div>
      <button onClick={onViewAll} className="mt-4 text-xs text-[var(--accent)] hover:underline flex items-center gap-1">View all invoices <span className="text-[10px]">→</span></button>
    </div>
  );
}

export default function AdminSettingsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [settings, setSettings] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [origins, setOrigins] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'settings' | 'accounts' | 'origins' | 'status'>('settings');
  const [provisionStatus, setProvisionStatus] = useState<any>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [trend, setTrend] = useState<number[]>([]);
  const [query, setQuery] = useState('');
  const provisionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const router = useRouter();

  const headers = () => ({ 'Content-Type': 'application/json' });

  const loadAll = useCallback(async () => {
    try {
      const [s, a, o, st] = await Promise.all([
        apiGet<{ data: any }>('/api/admin/lb/settings'),
        apiGet<{ data: any[] }>('/api/admin/lb/accounts'),
        apiGet<{ data: any[] }>('/api/admin/lb/origins'),
        apiGet<{ data: any }>('/api/admin/lb/status'),
      ]);
      setSettings((s as any).data ?? s ?? null);
      setAccounts((a as any).data ?? a ?? []);
      setOrigins((o as any).data ?? o ?? []);
      setStatus((st as any).data ?? st ?? null);
      // Scrape trend (12h buckets) untuk chart aktivitas.
      try {
        const jobs = await apiGet<{ data: Array<{ started_at: number }> }>('/api/admin/scrape-jobs?limit=200');
        const now = Math.floor(Date.now() / 1000);
        const buckets = new Array(12).fill(0);
        for (const j of (jobs as any).data ?? []) {
          const hAgo = Math.floor((now - j.started_at) / 3600);
          if (hAgo >= 0 && hAgo < 12) buckets[11 - hAgo]++;
        }
        setTrend(buckets);
      } catch { /* best-effort */ }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setUser(u);
      setAuthLoading(false);
      if (!u || u.role !== 'admin') router.replace('/');
    });
    return () => { alive = false; };
  }, [router]);

  useEffect(() => {
    if (user?.role === 'admin') loadAll();
  }, [user, loadAll]);

  const updateSettings = async (updates: any) => {
    const base = await getAuthApiUrl();
    await fetch(`${base}/api/admin/lb/settings`, { method: 'PUT', headers: headers(), credentials: 'include', body: JSON.stringify(updates) });
    loadAll();
  };

  const addAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const base = await getAuthApiUrl();
    await fetch(`${base}/api/admin/lb/accounts`, {
      method: 'POST', headers: headers(), credentials: 'include',
      body: JSON.stringify({ label: f.get('label'), provider: f.get('provider'), account_ref: f.get('account_ref'), rawToken: f.get('rawToken'), token_last4: (f.get('rawToken') as string).slice(-4) })
    });
    loadAll();
  };

  const provisionAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const label = f.get('provision_label') as string;
    const token = f.get('provision_token') as string;
    const workerName = (f.get('provision_worker_name') as string) || `manga-api-${crypto.randomUUID().slice(0, 8)}`;
    setProvisioning(true);
    setProvisionStatus(null);
    try {
      const base = await getAuthApiUrl();
      const res = await fetch(`${base}/api/admin/lb/accounts/provision`, {
        method: 'POST', headers: headers(), credentials: 'include',
        body: JSON.stringify({ label, cfApiToken: token, workerName }),
      });
      const j = await res.json() as any;
      const jobId = j.job_id;
      if (!jobId) throw new Error('no job_id returned');
      let ticks = 0;
      const poll = setInterval(async () => {
        if (document.hidden) return;
        if (++ticks > 100) {
          clearInterval(poll);
          provisionPollRef.current = null;
          setProvisioning(false);
          setError('Provision polling timeout — cek status akun manual.');
          return;
        }
        try {
          const st = await apiGet<{ data: any }>(`/api/admin/lb/accounts/${jobId}/provision-status`);
          const data = (st as any).data ?? st ?? null;
          setProvisionStatus(data);
          if (data?.status === 'completed' || data?.status === 'failed') {
            clearInterval(poll);
            provisionPollRef.current = null;
            setProvisioning(false);
            loadAll();
          }
        } catch {}
      }, 3000);
      provisionPollRef.current = poll;
    } catch (e) { setProvisioning(false); setError(String(e)); }
  };

  useEffect(() => {
    return () => {
      if (provisionPollRef.current) clearInterval(provisionPollRef.current);
    };
  }, []);

  const addOrigin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const base = await getAuthApiUrl();
    await fetch(`${base}/api/admin/lb/origins`, {
      method: 'POST', headers: headers(), credentials: 'include',
      body: JSON.stringify({ account_id: f.get('account_id') || null, origin_url: f.get('origin_url'), priority: Number(f.get('priority') || 0), weight: Number(f.get('weight') || 1), enabled: 1 })
    });
    loadAll();
  };

  if (authLoading) {
    return (
      <main className="bg-[var(--bg-base)] text-primary min-h-screen p-4 md:p-8">
        <div className="animate-pulse space-y-4 max-w-4xl mx-auto">
          <div className="h-8 w-48 rounded-lg bg-elevated" />
          <div className="h-40 w-full rounded-2xl bg-elevated" />
          <div className="h-40 w-full rounded-2xl bg-elevated" />
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') return null;

  const inputCls = 'w-full bg-base/50 border border-border-subtle rounded-xl px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-[var(--accent)]/50 transition-colors';
  const btnCls = 'px-4 py-1.5 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary transition-colors disabled:opacity-50';

  return (
    <main className="max-w-7xl mx-auto text-primary">
      {error && <div className="mb-5 text-sm text-error border border-[var(--error)]/30 rounded-xl p-3 bg-[var(--error)]/5">{error}</div>}

      {/* ── Header ── */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8 anim-slide-up">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted mt-0.5">Admin settings · {user.email} · {roleLabel(user.role)}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 bg-elevated border border-border-subtle rounded-full pl-4 pr-2 py-2">
            <SearchIcon className="w-4 h-4 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search origins..."
              className="w-40 md:w-52 bg-transparent text-sm text-secondary placeholder:text-muted focus:outline-none"
            />
          </div>
          <button className="relative w-10 h-10 flex items-center justify-center rounded-full bg-elevated border border-border-subtle text-secondary hover:text-secondary transition-colors" aria-label="Notifications">
            <BellIcon className="w-5 h-5" />
            <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
          </button>
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-full bg-[var(--accent)] flex items-center justify-center text-sm font-semibold text-[var(--bg-base)]">
              {(user.email || '?').charAt(0).toUpperCase()}
            </span>
            <div className="hidden lg:block">
              <div className="text-xs font-medium text-primary truncate max-w-[160px]">{user.email}</div>
              <div className="text-[10px] text-muted">{roleLabel(user.role)}</div>
            </div>
            <ChevronDown className="w-4 h-4 text-muted hidden lg:block" />
          </div>
        </div>
      </header>

      {/* ── Dashboard grid ── */}
      <div className="grid grid-cols-12 gap-6">
        <ActivityChart data={trend} />
        <CalendarCard now={new Date()} todayScrapes={trend.reduce((a, b) => a + b, 0)} />
        <AISummaryCard settings={settings} status={status} />
        <SpendingCard accounts={accounts} status={status} />
        <InvoicesCard origins={origins} onViewAll={() => setTab('origins')} query={query} />
      </div>

      {/* ── Management tabs ── */}
      <div className="mt-8 bg-elevated border border-border-subtle rounded-2xl p-6 anim-slide-up">
        <div className="flex gap-1 mb-6 border-b border-border-subtle pb-4 flex-wrap">
          {(['settings', 'accounts', 'origins', 'status'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm rounded-full transition-all duration-200 ${tab === t ? 'bg-accent text-[var(--bg-base)] font-medium' : 'text-secondary hover:text-secondary hover:bg-bg-secondary'}`}>
              {t === 'settings' ? 'Mode' : t === 'accounts' ? 'Akun' : t === 'origins' ? 'Origin Pool' : 'Status'}
            </button>
          ))}
        </div>

        {tab === 'settings' && settings && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-secondary">Mode</label>
              <select value={settings.mode} onChange={(e) => updateSettings({ mode: e.target.value })} className={`${inputCls} mt-1`}>
                <option value="off">Nonaktif</option>
                <option value="on">Aktif</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-secondary">Implementasi</label>
              <select value={settings.implementation} onChange={(e) => updateSettings({ implementation: e.target.value })} className={`${inputCls} mt-1`}>
                <option value="custom">Custom (gratis)</option>
                <option value="native_cf">Native CF LB</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-secondary">Steering Policy</label>
              <input defaultValue={settings.steering_policy} onBlur={(e) => updateSettings({ steering_policy: e.target.value })} className={`${inputCls} mt-1`} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-muted">Interval (s)</label><input type="number" defaultValue={settings.health_check_interval_sec} onBlur={(e) => updateSettings({ health_check_interval_sec: Number(e.target.value) })} className={`${inputCls} mt-1`} /></div>
              <div><label className="text-xs text-muted">Timeout (ms)</label><input type="number" defaultValue={settings.health_check_timeout_ms} onBlur={(e) => updateSettings({ health_check_timeout_ms: Number(e.target.value) })} className={`${inputCls} mt-1`} /></div>
              <div><label className="text-xs text-muted">Fail Threshold</label><input type="number" defaultValue={settings.failure_threshold} onBlur={(e) => updateSettings({ failure_threshold: Number(e.target.value) })} className={`${inputCls} mt-1`} /></div>
            </div>
          </div>
        )}

        {tab === 'accounts' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2">
                <h2 className="text-sm font-medium text-primary">⚡ Auto-Provision Akun CF Baru</h2>
                <p className="text-xs text-muted">Bikin D1 + Worker baru otomatis di akun Cloudflare lain. Token butuh permission: Workers Scripts:Edit, D1:Edit, KV:Edit, R2:Edit.</p>
                <form onSubmit={provisionAccount} className="space-y-2">
                  <input name="provision_label" placeholder="Label akun" required className={inputCls} />
                  <input name="provision_worker_name" placeholder="Worker name (auto)" className={inputCls} />
                  <input name="provision_token" type="password" placeholder="CF API Token" required className={inputCls} />
                  <button type="submit" disabled={provisioning} className={btnCls}>
                    {provisioning ? 'Provisioning...' : 'Provision'}
                  </button>
                </form>
                {provisionStatus && (
                  <div className="text-xs space-y-1">
                    <div className={provisionStatus.status === 'completed' ? 'text-success' : provisionStatus.status === 'failed' ? 'text-error' : 'text-secondary'}>
                      Status: {provisionStatus.status} — {provisionStatus.step}
                    </div>
                    {provisionStatus.workerUrl && <div className="text-success">Worker URL: {provisionStatus.workerUrl}</div>}
                    {provisionStatus.error && <div className="text-error">Error: {provisionStatus.error}</div>}
                  </div>
                )}
              </div>
              <form onSubmit={addAccount} className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2">
                <h2 className="text-sm font-medium text-primary">+ Tambah Akun</h2>
                <input name="label" placeholder="Label" required className={inputCls} />
                <select name="provider" className={inputCls}>
                  <option value="cloudflare">Cloudflare</option>
                  <option value="vercel">Vercel</option>
                </select>
                <input name="account_ref" placeholder="Account/Team ID" className={inputCls} />
                <input name="rawToken" placeholder="API Token" required className={inputCls} />
                <button type="submit" className={btnCls}>Tambah</button>
              </form>
            </div>
            <div className="divide-y divide-border-subtle border border-border-subtle rounded-xl bg-base/50 max-h-[420px] overflow-y-auto">
              {accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <span className="text-primary">{a.label}</span>
                    <span className="ml-2 text-xs px-2 py-0.5 border border-border-default rounded-full text-secondary">{a.provider}</span>
                    <span className="ml-2 text-muted text-xs tabular">cf_****{a.token_last4}</span>
                  </div>
                  <span className={a.status === 'verified' ? 'text-success text-xs' : 'text-error text-xs'}>{a.status === 'verified' ? '✅' : '⚠️'} {a.status}</span>
                </div>
              ))}
              {accounts.length === 0 && <div className="px-4 py-3 text-muted text-sm">Belum ada akun.</div>}
            </div>
          </div>
        )}

        {tab === 'origins' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <form onSubmit={addOrigin} className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2 h-fit">
              <h2 className="text-sm font-medium text-primary">+ Tambah Origin</h2>
              <input name="origin_url" placeholder="https://..." required className={inputCls} />
              <div className="flex gap-2">
                <input name="priority" type="number" placeholder="Priority" defaultValue={0} className={`${inputCls} flex-1`} />
                <input name="weight" type="number" placeholder="Weight" defaultValue={1} className={`${inputCls} flex-1`} />
              </div>
              <button type="submit" className={btnCls}>Tambah</button>
            </form>
            <div className="divide-y divide-border-subtle border border-border-subtle rounded-xl bg-base/50 max-h-[420px] overflow-y-auto">
              {origins.map((o) => (
                <div key={o.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <span className="text-primary break-all">{o.origin_url}</span>
                    <span className="ml-2 text-muted text-xs tabular">P{o.priority} W{o.weight}</span>
                  </div>
                  <span className={o.enabled === 1 ? 'text-success text-xs' : 'text-muted text-xs'}>{o.enabled === 1 ? 'ON' : 'OFF'}</span>
                </div>
              ))}
              {origins.length === 0 && <div className="px-4 py-3 text-muted text-sm">Belum ada origin.</div>}
            </div>
          </div>
        )}

        {tab === 'status' && status && (
          <div>
            <div className="mb-4"><span className="text-secondary text-sm">Mode: </span><span className="text-primary">{status.mode}</span></div>
            <div className="divide-y divide-border-subtle">
              {status.origins?.map((o: any) => (
                <div key={o.id} className="flex justify-between py-2.5 text-sm">
                  <span className="text-primary break-all">{o.origin_url}</span>
                  <span className={o.last_health_status === 'healthy' ? 'text-success' : o.last_health_status === 'unhealthy' ? 'text-error' : 'text-muted'}>
                    {o.last_health_status ?? '—'} {o.last_checked_at ? new Date(o.last_checked_at * 1000).toLocaleTimeString() : ''}
                  </span>
                </div>
              ))}
              {(!status.origins || status.origins.length === 0) && <div className="py-3 text-muted text-sm">Belum ada origin.</div>}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
