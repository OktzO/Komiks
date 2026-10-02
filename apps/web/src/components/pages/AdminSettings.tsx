'use client';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchMe, apiGet, apiPost, roleLabel, type AuthUser } from '@/lib/api';
import type { AdminInventory } from '@manga-platform/shared/types';
import { Card, CardHead, StatCard, EmptyState, AreaChart, StorageDonut, fmtNum } from '@/components/admin/charts';
import {
  B2Section,
  D1Section,
  InventoryWarningBanner,
  KVSection,
  TopologySection,
} from '@/components/admin/InventorySections';
import {
  PENDING_TOPOLOGY_STEPS,
  EMPTY_BANNERS,
  accountCreateOutcome,
  accountOptionsFromConflict,
  accountSelectionControl,
  bannersAfter,
  canSubmitCredential,
  credentialDraftChanged,
  filterInventory,
  inventoryUrl,
  lbRowsFromInventory,
  originDraftFrom,
  storageFromInventory,
  tabIndexFromKey,
  type AdminBanners,
  type CredentialDraft,
  type InventoryAccountOption,
} from '@/lib/adminInventory';
import { useAdminRefresh } from '@/lib/useAdminRefresh';

/* ═══════════════════════════════════════════════════════════════════════
 * Types — mirror the exact API response shapes.
 *
 * NOTE ON ENVELOPES: /api/admin/inventory, /api/admin/overview and the
 * dashboard metric routes are wrapped in `{ data }`. See
 * apps/api-cf/src/routes/admin/*.ts. Do not "unify" these blindly.
 * ═══════════════════════════════════════════════════════════════════════ */

type Overview = {
  usersTotal: number;
  bookmarksTotal: number;
  scrape24h: { success: number; failed: number };
  providers: { healthy: number; degraded: number; down: number };
};

type SourceHealth = {
  source: string;
  total: number;
  healthy: number;
  uptime_pct: number | null;
  last_checked_at: number | null;
  last_healthy: number | null;
  last_down: number | null;
  chapters_7d: number;
  last_scrape_7d: number | null;
};

type ReqData = { dates: string[]; series: Array<{ origin: string; points: number[] }> };

type ProvisionStatus = {
  status: string;
  step: string;
  error: string | null;
  workerUrl: string | null;
};

type MutationFailure = { error?: string; accounts?: unknown };
/* ═══════════════════════════════════════════════════════════════════════
 * Format helpers
 * ═══════════════════════════════════════════════════════════════════════ */

const fmtRel = (ts: number | null): string => {
  if (!ts) return 'belum pernah';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 60) return `${d} detik lalu`;
  if (d < 3600) return `${Math.floor(d / 60)} mnt lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)} jam lalu`;
  return `${Math.floor(d / 86400)} hari lalu`;
};

const fmtDayLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'UTC' });
};

/** Strip scheme + trailing slash for compact display. */
const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

const TEST_LABELS: Record<string, string> = {
  verified: 'Terverifikasi',
  failed: 'Gagal diverifikasi',
  unavailable: 'Tidak tersedia',
};

const credentialTone = (status: string | null): string =>
  status === 'verified' ? 'text-success' : status === 'failed' ? 'text-error' : 'text-muted';

/* ═══════════════════════════════════════════════════════════════════════
 * Icons — inline SVG, consistent 1.6–1.8 stroke, no emoji.
 * ═══════════════════════════════════════════════════════════════════════ */

type IconProps = { className?: string };

const iconBase = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconUsers({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconBookmark({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconPulse({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function IconServer({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <rect x="2" y="3" width="20" height="8" rx="2" />
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M6 7h.01M6 17h.01" />
    </svg>
  );
}

function IconDatabase({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function IconSearch({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function IconChevronDown({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function IconRefresh({ className }: IconProps) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Source health — real uptime_pct from source_health table.
 * ═══════════════════════════════════════════════════════════════════════ */

function SourceHealthCard({ sources, delay = 160 }: { sources: SourceHealth[]; delay?: number }) {
  return (
    <Card delay={delay}>
      <CardHead
        icon={<IconPulse className="w-4 h-4" />}
        title="Kesehatan sumber"
        hint={`${sources.length} sumber terpantau`}
      />
      {sources.length === 0 ? (
        <EmptyState>Belum ada baris source_health. Jalankan pencarian atau baca satu chapter untuk mengisinya.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {sources.map((s) => {
            const pct = s.uptime_pct ?? 0;
            const barColor =
              pct >= 95 ? 'var(--success)' : pct >= 70 ? 'oklch(75% 0.14 75)' : 'var(--error)';
            return (
              <li key={s.source}>
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-[12px] text-primary truncate">{s.source}</span>
                  <span className="text-[11px] tabular text-secondary shrink-0">
                    {s.uptime_pct == null ? '—' : `${s.uptime_pct}%`}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-bg-secondary/70 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: barColor }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1 text-[10px] text-muted">
                  <span className="tabular">
                    {s.healthy}/{s.total} check sehat
                  </span>
                  <span>{fmtRel(s.last_checked_at)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Credential forms
 * ═══════════════════════════════════════════════════════════════════════ */

const chipCls =
  'text-[10px] px-2 py-0.5 border border-border-default rounded-full text-secondary whitespace-nowrap';

const labelCls = 'text-[11px] text-secondary block';
const hintCls = 'text-[10px] text-muted leading-relaxed';

function AccountPicker({
  id,
  choices,
  value,
  onChange,
  required,
}: {
  id: string;
  choices: InventoryAccountOption[];
  value: string;
  onChange: (next: string) => void;
  required: boolean;
}) {
  return (
    <div className="pt-1 space-y-1.5">
      <label htmlFor={id} className={labelCls}>
        Akun Cloudflare yang dipakai
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
        required={required}
        aria-describedby={`${id}-hint`}
      >
        <option value="">Pilih akun…</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
            {choice.type ? ` · ${choice.type}` : ''}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className={hintCls}>
        Token tetap hanya di memori halaman ini dan tidak pernah ditulis ke storage peramban.
      </p>
    </div>
  );
}

function PendingTopologySteps() {
  return (
    <ol className="text-[11px] text-secondary leading-relaxed space-y-1 pt-1">
      <li className="text-muted">Origin baru nonaktif sampai topologi sinkron:</li>
      {PENDING_TOPOLOGY_STEPS.map((step, i) => (
        <li key={step} className="flex gap-1.5">
          <span className="text-muted tabular shrink-0">{i + 1}.</span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Main page
 * ═══════════════════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'topology', label: 'Topology' },
  { key: 'd1', label: 'D1' },
  { key: 'kv', label: 'KV' },
  { key: 'b2', label: 'B2' },
  { key: 'credentials', label: 'Kredensial' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const inputCls =
  'w-full bg-base/60 border border-border-subtle rounded-xl px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors';
const btnCls =
  'px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors disabled:opacity-50';

const workerNameFallback = (): string => `manga-api-${crypto.randomUUID().slice(0, 8)}`;

export default function AdminSettingsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [banners, setBanners] = useState<AdminBanners>(EMPTY_BANNERS);
  const [lastLoad, setLastLoad] = useState<number | null>(null);

  const [inventory, setInventory] = useState<AdminInventory | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [requests, setRequests] = useState<ReqData | null>(null);

  const [tab, setTab] = useState<TabKey>('topology');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [query, setQuery] = useState('');

  const [provision, setProvision] = useState({ label: '', workerName: '', token: '' });
  const [provisionAccountId, setProvisionAccountId] = useState('');
  const [provisionChoices, setProvisionChoices] = useState<InventoryAccountOption[]>([]);
  const [provisionStatus, setProvisionStatus] = useState<ProvisionStatus | null>(null);
  const [submittingProvision, setSubmittingProvision] = useState(false);
  const provisionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [account, setAccount] = useState({ label: '', provider: 'cloudflare', accountRef: '', token: '' });
  const [accountAccountId, setAccountAccountId] = useState('');
  const [accountChoices, setAccountChoices] = useState<InventoryAccountOption[]>([]);
  const [submittingAccount, setSubmittingAccount] = useState(false);
  const [submittingOrigin, setSubmittingOrigin] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  /* ── Data loading ────────────────────────────────────────────────────
   * One inventory call drives every resource tab. A failed inventory
   * response leaves the previous snapshot in place and only records the
   * inventory banner, so a transient outage never blanks the page and
   * never overwrites a mutation error.
   * ─────────────────────────────────────────────────────────────────── */
  const loadAll = useCallback(async (forceRefresh: boolean) => {
    const [inv, ov, sh, rq] = await Promise.allSettled([
      apiGet<{ data: AdminInventory }>(inventoryUrl(forceRefresh)),
      apiGet<{ data: Overview }>('/api/admin/overview'),
      apiGet<{ data: SourceHealth[] }>('/api/admin/dashboard/source-health'),
      apiGet<{ data: ReqData }>('/api/admin/dashboard/requests?days=14'),
    ]);

    setOverview(ov.status === 'fulfilled' ? ov.value.data : null);
    setSources(sh.status === 'fulfilled' ? (sh.value.data ?? []) : []);
    setRequests(rq.status === 'fulfilled' ? rq.value.data : null);
    setLastLoad(Date.now());

    if (inv.status === 'fulfilled' && inv.value.data) {
      setInventory(inv.value.data);
      setBanners((prev) => bannersAfter(prev, { kind: 'inventory', ok: true }));
    } else {
      const reason = inv.status === 'rejected' ? String(inv.reason) : 'respons inventaris kosong';
      setBanners((prev) =>
        bannersAfter(prev, {
          kind: 'inventory',
          ok: false,
          message: `Inventaris gagal dimuat — menampilkan data terakhir. ${reason}`,
        })
      );
    }

    setLoading(false);
    setRefreshing(false);
  }, []);

  const refresh = useAdminRefresh(loadAll, user?.role === 'admin');

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setUser(u);
      setAuthLoading(false);
      if (!u || u.role !== 'admin') window.location.replace('/');
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (provisionPollRef.current) clearInterval(provisionPollRef.current);
    },
    [],
  );

  const setMutationBanner = useCallback(
    (outcome: 'success' | 'partial' | 'failure', message?: string) => {
      setBanners((prev) => bannersAfter(prev, { kind: 'mutation', outcome, message }));
    },
    []
  );

  /* ── Mutations ─────────────────────────────────────────────────────── */

  const readFailure = async (res: Response): Promise<{ body: unknown; choices: InventoryAccountOption[] }> => {
    const body = await res.json().catch(() => null);
    const code = typeof (body as MutationFailure | null)?.error === 'string' ? String((body as MutationFailure).error) : '';
    return {
      body,
      choices: code === 'account selection required' ? accountOptionsFromConflict((body as MutationFailure).accounts) : [],
    };
  };

  const provisionAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      !canSubmitCredential({
        busy: submittingProvision,
        awaitingSelection: provisionControl.kind === 'picker',
        selectedAccountId: provisionAccountId,
      })
    ) {
      setMutationBanner('failure', 'Pilih akun Cloudflare terlebih dahulu, lalu kirim ulang.');
      return;
    }
    setSubmittingProvision(true);
    setProvisionStatus(null);
    try {
      const base = '';
      const res = await fetch(`${base}/api/admin/lb/accounts/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          label: provision.label,
          cfApiToken: provision.token,
          workerName: provision.workerName.trim() || workerNameFallback(),
          accountId: provisionAccountId || null,
        }),
      });
      if (!res.ok) {
        const { choices } = await readFailure(res);
        if (choices.length > 0) {
          setProvisionChoices(choices);
          setSubmittingProvision(false);
          setMutationBanner('failure', 'Token ini melihat beberapa akun Cloudflare — pilih satu, lalu kirim ulang.');
          return;
        }
        throw new Error(`Gagal provision (${res.status})`);
      }
      const j = (await res.json()) as { job_id?: string };
      const jobId = j.job_id;
      if (!jobId) throw new Error('Server tidak mengembalikan job_id');
      setProvisionAccountId('');
      setProvisionChoices([]);
      setProvision((p) => ({ ...p, token: '' }));
      setMutationBanner('success');

      let ticks = 0;
      const poll = setInterval(async () => {
        if (document.hidden) return;
        if (++ticks > 100) {
          clearInterval(poll);
          provisionPollRef.current = null;
          setSubmittingProvision(false);
          setMutationBanner('failure', 'Provision polling timeout — cek status akun secara manual.');
          return;
        }
        try {
          const st = await apiGet<{ data: ProvisionStatus }>(
            `/api/admin/lb/accounts/${jobId}/provision-status`
          );
          const data = st?.data ?? null;
          setProvisionStatus(data);
          if (data?.status === 'completed' || data?.status === 'failed') {
            clearInterval(poll);
            provisionPollRef.current = null;
            setSubmittingProvision(false);
            await loadAll(true);
          }
        } catch {
          /* keep polling */
        }
      }, 3000);
      provisionPollRef.current = poll;
    } catch (err) {
      setSubmittingProvision(false);
      setMutationBanner('failure', String(err));
    }
  };

  const addAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      !canSubmitCredential({
        busy: submittingAccount,
        awaitingSelection: accountControl.kind === 'picker',
        selectedAccountId: accountAccountId,
      })
    ) {
      setMutationBanner('failure', 'Pilih akun Cloudflare terlebih dahulu, lalu kirim ulang.');
      return;
    }
    setSubmittingAccount(true);
    try {
      const base = '';
      const res = await fetch(`${base}/api/admin/lb/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          label: account.label,
          provider: account.provider,
          accountId: account.provider === 'vercel' ? account.accountRef || null : accountAccountId || null,
          rawToken: account.token,
        }),
      });
      const { body, choices } = await readFailure(res);
      if (choices.length > 0) {
        setAccountChoices(choices);
        setSubmittingAccount(false);
        setMutationBanner('failure', 'Token ini melihat beberapa akun Cloudflare — pilih satu, lalu kirim ulang.');
        return;
      }
      if (!res.ok) {
        const outcome = accountCreateOutcome(res.status, body);
        if (outcome.kind === 'failed') {
          setSubmittingAccount(false);
          setMutationBanner('failure', outcome.message);
          return;
        }
        setMutationBanner('partial', `Akun tersimpan dengan status ${outcome.status} — token tidak lolos verifikasi provider.`);
      } else {
        setMutationBanner('success');
      }
      setSubmittingAccount(false);
      setAccount({ label: '', provider: 'cloudflare', accountRef: '', token: '' });
      setAccountAccountId('');
      setAccountChoices([]);
      await loadAll(true);
    } catch (err) {
      setSubmittingAccount(false);
      setMutationBanner('failure', String(err));
    }
  };

  const addOrigin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submittingOrigin) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const draft = originDraftFrom((name) => data.get(name));
    setSubmittingOrigin(true);
    try {
      const base = '';
      const res = await fetch(`${base}/api/admin/lb/origins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          account_id: draft.accountId || null,
          origin_url: draft.url,
          priority: draft.priority,
          weight: draft.weight,
          enabled: 0,
        }),
      });
      if (!res.ok) {
        setMutationBanner('failure', `Gagal menambah origin (${res.status})`);
        return;
      }
      form.reset();
      setMutationBanner('success');
      await loadAll(true);
    } catch (err) {
      setMutationBanner('failure', String(err));
    } finally {
      setSubmittingOrigin(false);
    }
  };

  const testAccount = async (id: string) => {
    if (testingId !== null) return;
    setTestingId(id);
    try {
      const res = await apiPost<{ ok: boolean; status: string }>(`/api/admin/lb/accounts/${id}/test`);
      setTestResults((prev) => ({ ...prev, [id]: TEST_LABELS[res.status] ?? `Status: ${res.status}` }));
      setMutationBanner('success');
      await loadAll(true);
    } catch (err) {
      setMutationBanner('failure', String(err));
    } finally {
      setTestingId(null);
    }
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = tabIndexFromKey(TABS.findIndex((t) => t.key === tab), e.key, TABS.length);
    if (next === null) return;
    e.preventDefault();
    setTab(TABS[next].key);
    tabRefs.current[next]?.focus();
  };

  /* ── Derived (all real) ────────────────────────────────────────────── */

  const view = useMemo(() => filterInventory(inventory, query), [inventory, query]);
  const storage = useMemo(() => storageFromInventory(inventory), [inventory]);
  const credentials = useMemo(
    () => lbRowsFromInventory(inventory, undefined, query).filter((row) => row.accountId !== null),
    [inventory, query]
  );
  const originAccountOptions = useMemo(
    () => lbRowsFromInventory(inventory).filter((row) => row.accountId !== null),
    [inventory]
  );
  const provisionDraft: CredentialDraft = {
    token: provision.token,
    accountId: provisionAccountId,
    choices: provisionChoices,
  };
  const accountDraft: CredentialDraft = {
    token: account.token,
    accountId: accountAccountId,
    choices: accountChoices,
  };
  const accountControl = accountSelectionControl(account.provider, accountDraft.choices);
  const provisionControl = accountSelectionControl('cloudflare', provisionDraft.choices);
  const provisionSubmit = canSubmitCredential({
    busy: submittingProvision,
    awaitingSelection: provisionControl.kind === 'picker',
    selectedAccountId: provisionDraft.accountId,
  });
  const accountSubmit = canSubmitCredential({
    busy: submittingAccount,
    awaitingSelection: accountControl.kind === 'picker',
    selectedAccountId: accountDraft.accountId,
  });

  const onProvisionToken = (token: string) => {
    const next = credentialDraftChanged(provisionDraft, token);
    if (next.choices !== provisionDraft.choices) setProvisionChoices(next.choices);
    if (next.accountId !== provisionDraft.accountId) setProvisionAccountId(next.accountId);
    setProvision((p) => ({ ...p, token: next.token }));
  };

  const onAccountToken = (token: string) => {
    const next = credentialDraftChanged(accountDraft, token);
    if (next.choices !== accountDraft.choices) setAccountChoices(next.choices);
    if (next.accountId !== accountDraft.accountId) setAccountAccountId(next.accountId);
    setAccount((a) => ({ ...a, token: next.token }));
  };

  const scrapeTotal = (overview?.scrape24h.success ?? 0) + (overview?.scrape24h.failed ?? 0);
  const scrapeRate = scrapeTotal > 0 ? Math.round(((overview?.scrape24h.success ?? 0) / scrapeTotal) * 100) : 0;

  const trafficPoints = useMemo(() => {
    if (!requests?.series.length) return [];
    return requests.dates.map((_, i) =>
      requests.series.reduce((sum, s) => sum + (s.points[i] ?? 0), 0),
    );
  }, [requests]);

  const trafficTotal = trafficPoints.reduce((a, b) => a + b, 0);

  /* ── Guards ────────────────────────────────────────────────────────── */

  if (authLoading) {
    return (
      <main className="max-w-7xl mx-auto p-4 md:p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-56 rounded-lg bg-elevated" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 rounded-2xl bg-elevated" />
            ))}
          </div>
          <div className="h-64 rounded-2xl bg-elevated" />
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') return null;

  return (
    <main className="max-w-7xl mx-auto">
      {/* Ambient glow — purely decorative, sits behind content */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-64 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 70% 100% at 50% 0%, color-mix(in oklab, var(--accent) 6%, transparent), transparent 70%)',
        }}
      />

      {banners.inventory && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-5 text-sm text-error border border-error/30 rounded-xl p-3 bg-error/5"
        >
          {banners.inventory}
        </div>
      )}

      {banners.mutation && (
        <div
          role="alert"
          aria-live="assertive"
          className={`mb-5 text-sm border rounded-xl p-3 ${
            banners.mutationTone === 'warning'
              ? 'text-accent border-accent/30 bg-accent/5'
              : 'text-error border-error/30 bg-error/5'
          }`}
        >
          {banners.mutation}
        </div>
      )}

      {/* ── Header ── */}
      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6 anim-slide-up">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Settings</h1>
          <p className="text-sm text-muted mt-1">
            Inventaris dinamis seluruh worker, D1, KV, B2, dan kredensial
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {lastLoad && (
            <span className="hidden xl:flex items-center gap-1.5 text-[11px] text-muted tabular">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-75 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              {new Date(lastLoad).toLocaleTimeString('id-ID')}
            </span>
          )}

          <div className="hidden sm:flex items-center gap-2 bg-elevated border border-border-subtle rounded-full pl-3.5 pr-3 py-2 focus-within:border-border-default transition-colors">
            <IconSearch className="w-4 h-4 text-muted shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari sumber daya..."
              aria-label="Cari sumber daya"
              className="w-36 md:w-48 bg-transparent text-sm text-primary placeholder:text-muted focus:outline-none"
            />
          </div>

          <button
            onClick={() => {
              setRefreshing(true);
              refresh(true);
            }}
            disabled={refreshing}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-elevated border border-border-subtle text-secondary hover:text-primary hover:border-border-default transition-colors disabled:opacity-50"
            aria-label="Muat ulang inventaris"
            title="Muat ulang inventaris"
          >
            <IconRefresh className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>

          <div className="flex items-center gap-2.5 pl-1">
            <span className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-sm font-semibold text-base">
              {(user.email || '?').charAt(0).toUpperCase()}
            </span>
            <div className="hidden lg:block">
              <div className="text-xs font-medium text-primary truncate max-w-[170px]">{user.email}</div>
              <div className="text-[10px] text-muted">{roleLabel(user.role)}</div>
            </div>
            <IconChevronDown className="w-4 h-4 text-muted hidden lg:block" />
          </div>
        </div>
      </header>

      {/* ── KPI row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard
          icon={<IconUsers className="w-4 h-4" />}
          label="Pengguna terdaftar"
          value={overview ? fmtNum(overview.usersTotal) : '—'}
          sub="total akun di database"
          delay={0}
        />
        <StatCard
          icon={<IconBookmark className="w-4 h-4" />}
          label="Bookmark tersimpan"
          value={overview ? fmtNum(overview.bookmarksTotal) : '—'}
          sub="akumulasi seluruh pengguna"
          delay={40}
        />
        <StatCard
          icon={<IconPulse className="w-4 h-4" />}
          label="Scrape 24 jam"
          value={overview ? `${scrapeRate}%` : '—'}
          sub={overview ? `${overview.scrape24h.success} sukses · ${overview.scrape24h.failed} gagal` : 'memuat...'}
          tone={scrapeTotal === 0 ? 'default' : scrapeRate >= 80 ? 'success' : scrapeRate >= 50 ? 'default' : 'error'}
          delay={80}
        />
        <StatCard
          icon={<IconServer className="w-4 h-4" />}
          label="Peer terjangkau"
          value={`${fmtNum(view.coverage.reachable)}/${fmtNum(view.topology.count)}`}
          sub={`${fmtNum(view.coverage.liveAccounts)} akun live · ${fmtNum(view.totals.registrations)} pendaftaran`}
          tone={view.topology.count > 0 && view.coverage.reachable === view.topology.count ? 'success' : 'default'}
          delay={120}
        />
      </div>

      {/* ── Bento grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Traffic — spans 2 */}
        <Card delay={160} className="lg:col-span-2">
          <CardHead
            icon={<IconPulse className="w-4 h-4" />}
            title="Permintaan origin"
            hint="Jumlah panggilan GET /api/origins per hari · 14 hari terakhir"
            action={
              <span className="text-[11px] text-muted tabular shrink-0">
                total {fmtNum(trafficTotal)}
              </span>
            }
          />
          {loading ? (
            <div className="h-[190px] rounded-lg bg-bg-secondary/40 animate-pulse" />
          ) : (
            <AreaChart
              points={trafficPoints}
              labels={(requests?.dates ?? []).map(fmtDayLabel)}
            />
          )}
          {requests && requests.series.length > 0 && (
            <div className="mt-4 pt-3 border-t border-border-subtle space-y-1.5">
              {requests.series.map((s) => {
                const sum = s.points.reduce((a, b) => a + b, 0);
                return (
                  <div key={s.origin} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-secondary truncate" title={s.origin}>
                      {hostOf(s.origin)}
                    </span>
                    <span className="tabular text-muted shrink-0">{fmtNum(sum)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <StorageDonut
          accounts={storage.accounts}
          totalBytes={null}
          quota={storage.totalQuota}
          d1Bytes={null}
          tracked
          icon={<IconDatabase className="w-4 h-4" />}
        />

        <SourceHealthCard sources={sources} delay={200} />
      </div>

      {/* ── Resource tabs ── */}
      <div className="mt-6 bg-elevated border border-border-subtle rounded-2xl p-5 anim-slide-up">
        <div
          role="tablist"
          aria-label="Inventaris sumber daya"
          onKeyDown={onTabKeyDown}
          className="flex gap-1 mb-5 border-b border-border-subtle pb-4 flex-wrap"
        >
          {TABS.map((t, i) => (
            <button
              key={t.key}
              ref={(node) => {
                tabRefs.current[i] = node;
              }}
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`panel-${t.key}`}
              tabIndex={tab === t.key ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 text-sm rounded-full transition-all duration-200 ${
                tab === t.key
                  ? 'bg-accent text-base font-medium'
                  : 'text-secondary hover:text-primary hover:bg-bg-secondary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id="panel-topology" aria-labelledby="tab-topology" hidden={tab !== 'topology'}>
          <InventoryWarningBanner warnings={view.warnings} stale={view.stale} observedAt={view.observedAt} />
          <TopologySection view={view} />
        </div>
        <div role="tabpanel" id="panel-d1" aria-labelledby="tab-d1" hidden={tab !== 'd1'}>
          <D1Section view={view} />
        </div>
        <div role="tabpanel" id="panel-kv" aria-labelledby="tab-kv" hidden={tab !== 'kv'}>
          <KVSection view={view} />
        </div>
        <div role="tabpanel" id="panel-b2" aria-labelledby="tab-b2" hidden={tab !== 'b2'}>
          <B2Section view={view} />
        </div>

        <div role="tabpanel" id="panel-credentials" aria-labelledby="tab-credentials" hidden={tab !== 'credentials'}>
          <InventoryWarningBanner warnings={view.warnings} stale={view.stale} observedAt={view.observedAt} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-medium text-primary">Auto-Provision akun CF baru</h3>
                <p className="text-xs text-muted leading-relaxed">
                  Membuat D1 + Worker baru otomatis di akun Cloudflare lain. Token memerlukan permission:
                  Workers Scripts:Edit, D1:Edit, KV:Edit, R2:Edit.
                </p>
                <form onSubmit={provisionAccount} className="space-y-2" aria-busy={submittingProvision}>
                  <div>
                    <label htmlFor="provision-label" className={labelCls}>
                      Nama akun
                    </label>
                    <input
                      id="provision-label"
                      value={provision.label}
                      onChange={(e) => setProvision((p) => ({ ...p, label: e.target.value }))}
                      placeholder="Nama akun (opsional)"
                      className={`${inputCls} mt-1`}
                    />
                  </div>
                  <div>
                    <label htmlFor="provision-worker" className={labelCls}>
                      Nama worker
                    </label>
                    <input
                      id="provision-worker"
                      value={provision.workerName}
                      onChange={(e) => setProvision((p) => ({ ...p, workerName: e.target.value }))}
                      placeholder="Nama worker (opsional)"
                      className={`${inputCls} mt-1`}
                    />
                  </div>
                  <div>
                    <label htmlFor="provision-token" className={labelCls}>
                      CF API Token
                    </label>
                    <input
                      id="provision-token"
                      value={provision.token}
                      onChange={(e) => onProvisionToken(e.target.value)}
                      type="password"
                      autoComplete="new-password"
                      placeholder="CF API Token"
                      required
                      className={`${inputCls} mt-1`}
                    />
                  </div>
                  {provisionControl.kind === 'picker' && (
                    <AccountPicker
                      id="provision-account"
                      choices={provisionControl.choices}
                      value={provisionAccountId}
                      onChange={setProvisionAccountId}
                      required
                    />
                  )}
                  <button type="submit" disabled={!provisionSubmit} className={btnCls}>
                    {submittingProvision
                      ? 'Provisioning...'
                      : provisionControl.kind === 'picker'
                        ? 'Kirim ulang dengan akun terpilih'
                        : 'Provision'}
                  </button>
                </form>
                {provisionStatus && (
                  <div className="text-xs space-y-1 pt-1">
                    <div
                      className={
                        provisionStatus.status === 'completed'
                          ? 'text-success'
                          : provisionStatus.status === 'failed'
                            ? 'text-error'
                            : 'text-secondary'
                      }
                    >
                      Status: {provisionStatus.status} — {provisionStatus.step}
                    </div>
                    {provisionStatus.workerUrl && (
                      <div className="text-success break-all">Worker URL: {provisionStatus.workerUrl}</div>
                    )}
                    {provisionStatus.error && (
                      <div className="text-error break-all">Error: {provisionStatus.error}</div>
                    )}
                    {provisionStatus.status === 'completed' && <PendingTopologySteps />}
                  </div>
                )}
              </div>

              <form
                onSubmit={addAccount}
                className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2"
                aria-busy={submittingAccount}
              >
                <h3 className="text-sm font-medium text-primary">Tambah akun</h3>
                <div>
                  <label htmlFor="account-label" className={labelCls}>
                    Nama akun
                  </label>
                  <input
                    id="account-label"
                    value={account.label}
                    onChange={(e) => setAccount((a) => ({ ...a, label: e.target.value }))}
                    placeholder="Nama akun (opsional)"
                    className={`${inputCls} mt-1`}
                  />
                </div>
                <div>
                  <label htmlFor="account-provider" className={labelCls}>
                    Provider
                  </label>
                  <select
                    id="account-provider"
                    value={account.provider}
                    onChange={(e) => {
                      setAccount({ ...account, provider: e.target.value });
                      setAccountAccountId('');
                      setAccountChoices([]);
                    }}
                    className={`${inputCls} mt-1`}
                  >
                    <option value="cloudflare">Cloudflare</option>
                    <option value="vercel">Vercel</option>
                  </select>
                </div>
                {accountControl.kind === 'reference' && (
                  <div>
                    <label htmlFor="account-ref" className={labelCls}>
                      Vercel account / team ID
                    </label>
                    <input
                      id="account-ref"
                      value={account.accountRef}
                      onChange={(e) => setAccount((a) => ({ ...a, accountRef: e.target.value }))}
                      maxLength={100}
                      placeholder="Account / Team ID (opsional)"
                      className={`${inputCls} mt-1`}
                    />
                    <p className={`${hintCls} mt-1`}>Maksimal 100 karakter.</p>
                  </div>
                )}
                <div>
                  <label htmlFor="account-token" className={labelCls}>
                    API Token
                  </label>
                  <input
                    id="account-token"
                    value={account.token}
                    onChange={(e) => onAccountToken(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder="API Token"
                    required
                    className={`${inputCls} mt-1`}
                  />
                </div>
                {accountControl.kind === 'picker' && (
                  <AccountPicker
                    id="account-picker"
                    choices={accountControl.choices}
                    value={accountAccountId}
                    onChange={setAccountAccountId}
                    required
                  />
                )}
                <button type="submit" disabled={!accountSubmit} className={btnCls}>
                  {submittingAccount
                    ? 'Menyimpan...'
                    : accountControl.kind === 'picker'
                      ? 'Kirim ulang dengan akun terpilih'
                      : 'Tambah'}
                </button>
              </form>

              <form
                onSubmit={addOrigin}
                className="bg-base/50 border border-border-subtle rounded-xl p-4 space-y-2"
                aria-busy={submittingOrigin}
              >
                <h3 className="text-sm font-medium text-primary">Tambah origin</h3>
                <p className="text-xs text-muted leading-relaxed">
                  Origin baru selalu dibuat nonaktif dan belum masuk trafik sampai topologi sinkron.
                </p>
                <div>
                  <label htmlFor="origin-url" className={labelCls}>
                    URL origin
                  </label>
                  <input
                    id="origin-url"
                    name="origin_url"
                    type="url"
                    placeholder="https://..."
                    required
                    className={`${inputCls} mt-1`}
                  />
                </div>
                <div>
                  <label htmlFor="origin-account" className={labelCls}>
                    Akun
                  </label>
                  <select id="origin-account" name="origin_account_id" className={`${inputCls} mt-1`} defaultValue="">
                    <option value="">Tanpa akun</option>
                    {originAccountOptions.map((row) => (
                      <option key={row.accountId} value={row.accountId ?? ''}>
                        {row.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label htmlFor="origin-priority" className={labelCls}>
                      Priority
                    </label>
                    <input
                      id="origin-priority"
                      name="priority"
                      type="number"
                      min={0}
                      defaultValue={0}
                      className={`${inputCls} mt-1`}
                    />
                  </div>
                  <div className="flex-1">
                    <label htmlFor="origin-weight" className={labelCls}>
                      Weight
                    </label>
                    <input
                      id="origin-weight"
                      name="weight"
                      type="number"
                      min={1}
                      defaultValue={1}
                      className={`${inputCls} mt-1`}
                    />
                  </div>
                </div>
                <button type="submit" disabled={submittingOrigin} className={btnCls}>
                  {submittingOrigin ? 'Menyimpan...' : 'Tambah'}
                </button>
                <PendingTopologySteps />
              </form>
            </div>

            <div className="divide-y divide-border-subtle border border-border-subtle rounded-xl bg-base/50 max-h-[600px] overflow-y-auto self-start">
              {credentials.map((row) => (
                <div key={row.key} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-primary truncate">{row.label}</span>
                        {row.provider && <span className={chipCls}>{row.provider}</span>}
                        {row.topologyStatus === 'pending_topology' && (
                          <span className={`${chipCls} text-accent border-accent/40`}>menunggu topologi</span>
                        )}
                      </div>
                      <p className="text-muted text-[11px] tabular mt-0.5 break-all">
                        {row.accountRef ?? row.accountId}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[11px] ${credentialTone(row.status)}`}>{row.status ?? '—'}</span>
                      <button
                        onClick={() => testAccount(row.accountId as string)}
                        disabled={testingId !== null}
                        className="text-[11px] text-secondary hover:text-primary transition-colors disabled:opacity-50"
                      >
                        {testingId === row.accountId ? 'Menguji...' : 'Tes'}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted">
                    {row.accountId && testResults[row.accountId] && (
                      <span className="text-secondary">{testResults[row.accountId]}</span>
                    )}
                    <span>Tes terakhir: {fmtRel(row.lastTestedAt)}</span>
                  </div>
                  {row.origins.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {row.origins.map((origin) => (
                        <li
                          key={origin.id ?? origin.url ?? 'origin'}
                          className="flex items-center justify-between gap-2 text-[10px] text-muted"
                        >
                          <span className="truncate" title={origin.url ?? ''}>
                            {origin.url === null ? '—' : hostOf(origin.url)}
                          </span>
                          <span className="tabular shrink-0">
                            P{origin.priority ?? '—'} · W{origin.weight ?? '—'} ·{' '}
                            {origin.enabled === 1 ? 'aktif' : 'nonaktif'} ·{' '}
                            {origin.lastHealthStatus ?? 'belum dicek'}
                            {origin.lastCheckedAt ? ` · dicek ${fmtRel(origin.lastCheckedAt)}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {credentials.length === 0 && (
                <div className="px-4 py-3 text-muted text-sm">
                  {query ? 'Tidak ada kredensial yang cocok dengan pencarian.' : 'Belum ada kredensial terdaftar.'}
                </div>
              )}
            </div>
          </div>
        </div>

        {!inventory && !banners.inventory && (
          <EmptyState>Belum ada inventaris. Muat ulang untuk mengambil snapshot sumber daya.</EmptyState>
        )}
      </div>
    </main>
  );
}
