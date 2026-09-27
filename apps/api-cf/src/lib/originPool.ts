import type { LbOrigin } from '@manga-platform/shared/types';
import type { TopologySnapshot } from './peers';

export interface PublicOrigin {
  url: string;
  priority: number;
  weight: number;
  healthy: boolean;
}

const PUBLIC_ORIGIN_FIELDS = ['url', 'priority', 'weight', 'healthy'];

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '');

export const originCacheKey = (hash: string): string => `origins:v2:${hash}`;

export const indexOriginsByUrl = (origins: LbOrigin[]): Map<string, LbOrigin> => {
  const byUrl = new Map<string, LbOrigin>();
  for (const row of origins) {
    const key = normalizeUrl(row.origin_url);
    if (!byUrl.has(key)) byUrl.set(key, row);
  }
  return byUrl;
};

export const buildOriginPool = (topology: TopologySnapshot, origins: LbOrigin[]): PublicOrigin[] => {
  const byUrl = indexOriginsByUrl(origins);
  const pool: PublicOrigin[] = [];
  for (const peer of topology.peers) {
    const url = normalizeUrl(peer.url);
    const row = byUrl.get(url);
    if (row) {
      if (row.enabled !== 1) continue;
      const status = row.last_health_status ?? null;
      if (status !== null && status !== 'healthy') continue;
    }
    pool.push({
      url,
      priority: row?.priority ?? peer.index,
      weight: row?.weight ?? 1,
      healthy: true,
    });
  }
  return pool;
};

export const isPublicOrigin = (value: unknown): value is PublicOrigin => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === PUBLIC_ORIGIN_FIELDS.length &&
    PUBLIC_ORIGIN_FIELDS.every((field) => field in record) &&
    typeof record.url === 'string' &&
    Number.isFinite(record.priority) &&
    Number.isFinite(record.weight) &&
    typeof record.healthy === 'boolean'
  );
};

export const parseCachedPool = (raw: unknown): PublicOrigin[] | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data.every(isPublicOrigin) ? data : null;
};
