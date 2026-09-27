import type { ResourceSource, ResourceStatus } from '@manga-platform/shared/types';
import { Card, CardHead, EmptyState, fmtBytes, fmtNum } from '@/components/admin/charts';
import {
  b2RowKey,
  filterInventory,
  formatObservedAt,
  formatSource,
  formatStatus,
  localFieldLabel,
  topologyRowsFromView,
  type AdminInventoryView,
  type InventoryRow,
  type InventoryState,
  type InventoryWarningEntry,
} from '@/lib/adminInventory';

const iconBase = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconTopology({ className }: { className?: string }) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M10.5 7 6.5 16.5M13.5 7l4 9.5M7.5 19h9" />
    </svg>
  );
}

function IconDatabase({ className }: { className?: string }) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function IconLayers({ className }: { className?: string }) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="m12 2 10 6-10 6L2 8l10-6z" />
      <path d="m2 14 10 6 10-6" />
    </svg>
  );
}

function IconBucket({ className }: { className?: string }) {
  return (
    <svg {...iconBase} className={className} aria-hidden="true">
      <path d="M3 9a2 2 0 0 1 1.7-2l6.6-2.3a2 2 0 0 1 1.4 0l6.6 2.3A2 2 0 0 1 21 9v9a2 2 0 0 1-1.7 2l-6.6 2.3a2 2 0 0 1-1.4 0l-6.6-2.3A2 2 0 0 1 3 18z" />
      <path d="m3.3 8 8.7 3 8.7-3M12 21V11" />
    </svg>
  );
}

const UNKNOWN = '—';

const TONE: Record<ResourceStatus | ResourceSource, string> = {
  ok: 'text-success',
  live: 'text-success',
  degraded: 'text-accent',
  local: 'text-accent',
  tracked: 'text-accent',
  derived: 'text-muted',
  unavailable: 'text-muted',
};

const show = (value: unknown): string => {
  if (typeof value !== 'string') return UNKNOWN;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : UNKNOWN;
};

const num = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? fmtNum(value) : UNKNOWN;

const join = (...parts: Array<string | null | undefined>): string => {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return kept.length > 0 ? kept.join(' · ') : UNKNOWN;
};

const b2Key = b2RowKey;

function Badge({ text, tone }: { text: string; tone: string }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 border border-border-default rounded-full ${tone} whitespace-nowrap`}>
      {text}
    </span>
  );
}

function StateBadges({ state }: { state: InventoryState }) {
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap justify-end">
      <Badge text={formatSource(state.source)} tone={TONE[state.source]} />
      <Badge text={formatStatus(state.status)} tone={TONE[state.status]} />
    </span>
  );
}

function StateMeta({ state }: { state: InventoryState }) {
  return (
    <p className="text-[10px] text-muted mt-1 tabular break-all">
      {show(state.errorCode)} · {formatObservedAt(state.observedAt)}
    </p>
  );
}

function StateColumn({ state }: { state: InventoryState }) {
  return (
    <div className="min-w-0 text-right ml-auto">
      <StateBadges state={state} />
      <StateMeta state={state} />
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd
        className={`text-secondary ${mono ? 'font-mono text-[10.5px] break-all' : 'truncate tabular'}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted truncate">{label}</p>
      <p className="text-[13px] text-primary tabular mt-0.5">{value}</p>
    </div>
  );
}

function RowHead({ row }: { row: InventoryRow }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-[13px] text-primary truncate">
        {row.index !== null && (
          <span className="text-muted font-mono text-[11px]">#{row.index} </span>
        )}
        {show(row.account.name)}
        {row.self && <span className="text-muted"> · self</span>}
      </p>
      <p className="text-[11px] text-muted mt-0.5 break-all">{show(row.url)}</p>
    </div>
  );
}

function Filtered({ active, empty, blank }: { active: boolean; empty: string; blank: string }) {
  return <EmptyState>{active ? empty : blank}</EmptyState>;
}

export function InventoryWarningBanner({
  warnings,
  stale,
  observedAt,
}: {
  warnings: InventoryWarningEntry[];
  stale: boolean;
  observedAt: number | null;
}) {
  if (!stale && warnings.length === 0) return null;
  return (
    <section
      role="status"
      aria-live="polite"
      className="mb-4 rounded-2xl border-[1.5px] border-border-default bg-card p-4 anim-slide-up"
    >
      <h2 className="text-[13px] font-medium text-primary">Peringatan inventaris</h2>
      {stale && (
        <p className="text-[11px] text-muted mt-1 leading-relaxed">
          Data basi — nilai ditampilkan dari cache terakhir, diamati {formatObservedAt(observedAt)}.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {warnings.map((warning, i) => (
            <li key={`${warning.code}-${warning.peerUrl ?? 'global'}-${i}`} className="text-[11px] text-secondary leading-relaxed">
              <span className="text-accent">{warning.code}</span> · {show(warning.message)}
              {warning.peerUrl && <span className="text-muted break-all"> · {warning.peerUrl}</span>}
              <span className="text-muted"> · {formatObservedAt(warning.observedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TopologySection({ view }: { view: AdminInventoryView }) {
  const c = view.coverage;
  const peers = topologyRowsFromView(view);
  return (
    <Card>
      <CardHead
        icon={<IconTopology className="w-4 h-4" />}
        title="Topologi"
        hint={`${show(view.topology.source)} · ${view.totals.accounts} baris · ${view.stale ? 'basi' : 'segar'}`}
      />

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
        <Field label="Peer dikonfigurasi" value={fmtNum(view.topology.count)} />
        <Field label="Peer terjangkau" value={`${fmtNum(c.reachable)} / ${fmtNum(view.topology.count)}`} />
        <Field label="Konsisten" value={view.topology.consistent ? 'ya' : 'tidak'} />
        <Field label="Diamati" value={formatObservedAt(view.observedAt)} />
        <Field label="Peringatan" value={fmtNum(view.totals.warnings)} />
        <Field label="Hash" value={show(view.topology.hash)} mono />
      </dl>

      <div className="mt-4 pt-3 border-t border-border-subtle grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniStat label="Akun live" value={`${fmtNum(c.liveAccounts)}/${fmtNum(view.totals.accounts)}`} />
        <MiniStat label="D1 live" value={`${fmtNum(c.d1)}/${fmtNum(view.totals.accounts)}`} />
        <MiniStat label="KV live" value={`${fmtNum(c.kv)}/${fmtNum(view.totals.accounts)}`} />
        <MiniStat label="B2 live" value={`${fmtNum(c.b2)}/${fmtNum(view.totals.b2)}`} />
      </div>

      <h3 className="text-[10px] uppercase tracking-wide text-muted mt-4 pt-3 border-t border-border-subtle">
        Peer terkonfigurasi
      </h3>
      {peers.length === 0 ? (
        <Filtered
          active={view.active}
          empty="Tidak ada peer yang cocok filter."
          blank="PEER_URLS belum memuat peer apa pun."
        />
      ) : (
        <ul className="mt-2 divide-y divide-border-subtle">
          {peers.map((peer) => (
            <li
              key={peer.key}
              className={`py-2.5 ${peer.hashMatches === false ? 'border-l-2 border-error pl-2.5' : 'border-l-2 border-transparent pl-2.5'}`}
            >
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-primary truncate">
                    {peer.index !== null && (
                      <span className="text-muted font-mono text-[11px]">#{peer.index} </span>
                    )}
                    {show(peer.accountName)}
                    {peer.self && <span className="text-muted"> · self</span>}
                    {peer.lbAccountLabel && (
                      <span className="text-muted"> · {peer.lbAccountLabel}</span>
                    )}
                  </p>
                  <p className="text-[11px] text-muted mt-0.5 break-all">{show(peer.url)}</p>
                </div>
                <div className="min-w-0 text-right ml-auto">
                  <StateBadges state={peer.accountState} />
                  <p className="text-[10px] text-muted mt-1 tabular">
                    {peer.reachable ? 'terjangkau' : 'tidak terjangkau'}
                  </p>
                </div>
              </div>
              <dl className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5">
                <Field label="Account ID" value={show(peer.accountId)} mono />
                <Field label="Tipe akun" value={show(peer.accountType)} />
                <Field label="Worker" value={show(peer.workerName)} />
                <Field
                  label="Origin"
                  value={peer.originCount === 0 ? '—' : fmtNum(peer.originCount)}
                />
                <Field
                  label="Hash peer"
                  value={peer.hashMatches === false ? `${show(peer.topologyHash)} · beda` : show(peer.topologyHash)}
                  mono
                />
                <Field label="Worker state" value={formatStatus(peer.workerState.status)} />
              </dl>
            </li>
          ))}
        </ul>
      )}

      <h3 className="text-[10px] uppercase tracking-wide text-muted mt-4 pt-3 border-t border-border-subtle">
        Pendaftaran load balancing
      </h3>
      {view.visibleRegistrations.length === 0 ? (
        <Filtered
          active={view.active}
          empty="Tidak ada pendaftaran yang cocok filter."
          blank="Belum ada pendaftaran akun load balancing."
        />
      ) : (
        <ul className="mt-2 divide-y divide-border-subtle">
          {view.visibleRegistrations.map((entry) => (
            <li key={entry.account.id} className="py-2.5">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-primary truncate">{show(entry.account.label)}</p>
                  <p className="text-[11px] text-muted mt-0.5 break-all">
                    {join(entry.account.accountRef, entry.origin?.url)}
                  </p>
                </div>
                <div className="min-w-0 text-right ml-auto">
                  <Badge
                    text={
                      entry.topologyStatus === 'pending_topology'
                        ? 'menunggu topologi'
                        : 'status topologi tidak diketahui'
                    }
                    tone="text-accent"
                  />
                  <p className="text-[10px] text-muted mt-1 break-all">{show(entry.account.status)}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function D1Section({ view }: { view: AdminInventoryView }) {
  return (
    <Card delay={80}>
      <CardHead
        icon={<IconDatabase className="w-4 h-4" />}
        title="Database D1"
        hint={`${view.visibleD1.length} dari ${view.totals.accounts} database`}
      />
      {view.visibleD1.length === 0 ? (
        <Filtered
          active={view.active}
          empty="Tidak ada database yang cocok filter."
          blank="Belum ada database D1 terkonfigurasi."
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {view.visibleD1.map((row) => {
            const d1 = row.d1;
            return (
              <li key={`${row.index ?? row.url}-${row.url}`} className="py-3">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <RowHead row={row} />
                  <StateColumn state={d1.state} />
                </div>
                <dl className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5">
                  <Field label="Database" value={show(d1.name)} />
                  <Field label="ID" value={show(d1.id)} mono />
                  <Field label="Ukuran" value={fmtBytes(d1.fileBytes)} />
                  <Field label="Wilayah" value={join(d1.jurisdiction, d1.region)} />
                  <Field label={localFieldLabel('Series')} value={num(d1.counts.series)} />
                  <Field label={localFieldLabel('Chapter')} value={num(d1.counts.chapters)} />
                  <Field label={localFieldLabel('Halaman')} value={num(d1.counts.chapterPages)} />
                  <Field label={localFieldLabel('Pengguna')} value={num(d1.counts.users)} />
                  <Field label={localFieldLabel('Bookmark')} value={num(d1.counts.bookmarks)} />
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function KVSection({ view }: { view: AdminInventoryView }) {
  return (
    <Card delay={120}>
      <CardHead
        icon={<IconLayers className="w-4 h-4" />}
        title="Namespace KV"
        hint={`${view.visibleKv.length} dari ${view.totals.accounts} namespace`}
      />
      {view.visibleKv.length === 0 ? (
        <Filtered
          active={view.active}
          empty="Tidak ada namespace yang cocok filter."
          blank="Belum ada namespace KV terkonfigurasi."
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {view.visibleKv.map((row) => {
            const kv = row.kv;
            return (
              <li key={`${row.index ?? row.url}-${row.url}`} className="py-3">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <RowHead row={row} />
                  <StateColumn state={kv.state} />
                </div>
                <dl className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5">
                  <Field label="Namespace" value={show(kv.title)} />
                  <Field label="ID" value={show(kv.id)} mono />
                  <Field label="Wilayah" value={join(kv.jurisdiction)} />
                  <Field label="Kunci" value={num(kv.keyCount)} />
                  <Field label="Byte" value={fmtBytes(kv.byteCount)} />
                  <Field label={localFieldLabel('Byte operasional')} value={fmtBytes(kv.operationalD1Bytes)} />
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function B2Section({ view }: { view: AdminInventoryView }) {
  return (
    <Card delay={160}>
      <CardHead
        icon={<IconBucket className="w-4 h-4" />}
        title="Bucket B2"
        hint={`${view.visibleB2.length} dari ${view.totals.b2} akun · byte terlacak`}
      />
      {view.visibleB2.length === 0 ? (
        <Filtered
          active={view.active}
          empty="Tidak ada bucket B2 yang cocok filter."
          blank="Belum ada akun B2 terkonfigurasi."
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {view.visibleB2.map((entry, position) => (
            <li key={b2Key(entry, position)} className="py-3">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-primary truncate">{entry.configuredName}</p>
                  <p className="text-[11px] text-muted mt-0.5 break-all">{show(entry.bucketName)}</p>
                </div>
                <StateColumn state={entry.state} />
              </div>
              <dl className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5">
                <Field label="Bucket" value={show(entry.bucketName)} />
                <Field label="Bucket ID" value={show(entry.bucketId)} mono />
                <Field label="Tipe" value={show(entry.bucketType)} />
                <Field label="Opsi" value={entry.options.length > 0 ? entry.options.join(', ') : UNKNOWN} />
                <Field label="Account ID" value={show(entry.providerAccountId)} mono />
                <Field label="Byte terlacak" value={fmtBytes(entry.trackedBytes)} />
                <Field label="Kuota" value={entry.quotaBytes === null ? UNKNOWN : fmtBytes(entry.quotaBytes)} />
                <Field label="Diperbarui" value={formatObservedAt(entry.trackedUpdatedAt)} />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function InventorySections({
  inventory,
  query = '',
}: {
  inventory: unknown;
  query?: string;
}) {
  const view = filterInventory(inventory, query);
  return (
    <div>
      <InventoryWarningBanner
        warnings={view.warnings}
        stale={view.stale}
        observedAt={view.observedAt}
      />
      <div className="grid md:grid-cols-2 gap-4">
        <TopologySection view={view} />
        <D1Section view={view} />
        <KVSection view={view} />
        <B2Section view={view} />
      </div>
    </div>
  );
}
