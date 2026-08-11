// API_URL must be set in production via NEXT_PUBLIC_API_URL. The localhost
// fallback is only for local dev (wrangler dev on :8787).
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export interface Series {
  slug: string;
  external_id: string;
  source: string;
  title: string;
  synopsis?: string | null;
  type: string;
  status: string;
  author?: string | null;
  artist?: string | null;
  cover_image?: string | null;
  genres?: string[];
  tags?: string[];
}

export interface Chapter {
  id: string;
  series_slug: string;
  chapter_number: number;
  volume?: string | null;
  title?: string | null;
  language: string;
  pages_count: number;
  published_at?: number | null;
  pages?: { proxyUrl: string }[];
}

// 12s timeout prevents Cloudflare Pages Function timeout (30s) from
// triggering a 502 when the Worker API is slow on cold KV cache.
async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

// Consolidated series + chapters endpoint — 1 Worker call instead of 2.
export const getSeriesDetail = (source: string, sourceId: string, lang = 'id') =>
  apiWithFailover<{ data: Series & { chapters: Chapter[] } }>(`/api/reader/${source}/series/${sourceId}/detail?lang=${lang}`).then((r) => r.data);

export const getSeries = (source: string, sourceId: string) =>
  apiWithFailover<{ data: Series }>(`/api/reader/${source}/series/${sourceId}`).then((r) => r.data);

export const getMangaSources = (source: string, sourceId: string) =>
  apiWithFailover<{ data: { sources: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }>; canonicalSlug: string | null } }>(
    `/api/reader/${source}/series/${sourceId}/sources`
  ).then((r) => r.data);

export const getChapters = (source: string, sourceId: string, lang = 'id') =>
  apiWithFailover<{ data: Chapter[] }>(`/api/reader/${source}/series/${sourceId}/chapters?lang=${lang}`).then((r) => r.data);

export const getChapter = (source: string, chapterId: string) =>
  apiWithFailover<{ data: Chapter }>(`/api/reader/${source}/chapter/${chapterId}`).then((r) => r.data);

// Local D1 series list — used by homepage instead of searchMerged('') to
// avoid 2 upstream fetches + 2 source-health writes per homepage load.
export const getSeriesList = (page = 1, limit = 24): Promise<Series[]> =>
  apiWithFailover<Series[]>(`/api/series?page=${page}&limit=${limit}`);

// ---- Data API (now merged into single manga-api Worker) ----------------------
export const DATA_API_URL = process.env.NEXT_PUBLIC_DATA_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export interface MergedManga {
  slug: string;
  title: string;
  cover_image?: string | null;
  source: string;
  sources: string[];
  type?: string;
  status?: string;
}

export interface SourceStatus {
  source: string;
  healthy: boolean;
  latency_ms: number;
  last_checked_at: number;
  error?: string;
}

async function dataApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DATA_API_URL}${path}`, {
    ...init,
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Data API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const searchMerged = (q: string): Promise<{ data: MergedManga[]; sources_queried: string[] }> =>
  dataApi(`/api/search?q=${encodeURIComponent(q)}`);

export const getSourceStatus = (): Promise<{ data: SourceStatus[] }> =>
  dataApi('/api/source-status');

// ---- R2 multi-account direct serving (komiku) --------------------------
// Domain R2 dari env build-time; urutan = index akun, HARUS sama dengan
// R2_ACCOUNTS di Worker. Ring di-build sekali per proses (pure).
import { buildRing, accountFor } from '@manga-platform/shared/r2-routing';

export const R2_DOMAINS = (process.env.NEXT_PUBLIC_R2_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const R2_VNODES = Number(process.env.NEXT_PUBLIC_R2_VNODES) || 32;
const r2Ring = R2_DOMAINS.length > 0 ? buildRing(R2_DOMAINS, R2_VNODES) : null;

// Key deterministik: {source}/{slug}/{chapterId}/{pageNo} (tanpa ext — sama
// dengan sisi Worker). null saat R2 belum dikonfigurasi → proxy-only.
export const r2UrlFor = (source: string, slug: string, chapterId: string, pageNo: number): string | null => {
  if (!r2Ring || !slug) return null;
  const idx = accountFor(slug, r2Ring);
  return `https://${R2_DOMAINS[idx]}/${source}/${slug}/${chapterId}/${pageNo}`;
};

// ---- Round-robin origin failover (LB multi-account) --------------------
// Health-aware: skip origin yang 429/5xx/timeout (circuit breaker 60s per
// origin setelah 2 gagal beruntun). Retry max 2x, bukan coba semua akun.
// Hanya path publik yang boleh dipanggil ke origin — allowlist eksplisit.
const ORIGIN_PATH_ALLOWLIST = [
  '/api/health',
  '/api/search',
  '/api/series',
  '/api/manga/',
  '/api/reader/',
  '/api/source-status',
];

export const getOrigins = async (): Promise<{ url: string }[]> => {
  const cached = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('origins') : null;
  if (cached) return JSON.parse(cached) as { url: string }[];
  try {
    const res = await fetch(`${API_URL}/api/origins`, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const json = await res.json() as { data: { url: string }[] };
    const data = json.data || [];
    if (typeof sessionStorage !== 'undefined' && data.length > 0) {
      sessionStorage.setItem('origins', JSON.stringify(data));
      setTimeout(() => sessionStorage.removeItem('origins'), 60000);
    }
    return data;
  } catch {
    return [];
  }
};

// Circuit state per origin: gagal beruntun → skip 60s.
const failures = new Map<string, { count: number; until: number }>();

export async function apiWithFailover<T>(path: string): Promise<T> {
  if (!ORIGIN_PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
    return api<T>(path); // non-publik → main API saja
  }
  const origins = await getOrigins();
  const now = Date.now();
  let attempts = 0;
  for (const origin of origins) {
    if (attempts >= 2) break; // retry terbatas, bukan loop semua akun
    const state = failures.get(origin.url);
    if (state && state.until > now) continue;
    attempts++;
    try {
      const res = await fetch(`${origin.url}${path}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status >= 500) {
        const f = failures.get(origin.url);
        const count = (f?.count ?? 0) + 1;
        failures.set(origin.url, { count, until: count >= 2 ? now + 60000 : now + 5000 });
        continue;
      }
      failures.set(origin.url, { count: 0, until: 0 });
      if (!res.ok) throw new Error(`origin ${path} → ${res.status}`);
      return res.json() as Promise<T>;
    } catch {
      const f = failures.get(origin.url);
      const count = (f?.count ?? 0) + 1;
      failures.set(origin.url, { count, until: count >= 2 ? now + 60000 : now + 5000 });
    }
  }
  return api<T>(path); // semua origin gagal → main API
}

// ---- Auth (Google OAuth via /api/auth/google/login) ------------------------
import type { UserPreferences, SessionMeta, MeResponse } from '@manga-platform/shared/types';

export type { UserPreferences, SessionMeta, MeResponse };

export interface AuthUser {
  id: number;
  email: string;
  role: string;
  name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  preferences: UserPreferences;
  created_at: number;
}

export const fetchMe = async (): Promise<AuthUser | null> => {
  try {
    const res = await fetch(`${API_URL}/api/user/me`, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data: AuthUser | null };
    return json.data ?? null;
  } catch {
    return null;
  }
};

export const logout = async (): Promise<void> => {
  try {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // logout best-effort — drop cookie client-side even on network error
  }
};

export const patchMe = async (
  patch: Partial<Pick<MeResponse, 'display_name' | 'bio' | 'preferences'>>
): Promise<AuthUser> => {
  const res = await fetch(`${API_URL}/api/user/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `PATCH /me → ${res.status}`);
  }
  const json = await res.json() as { data: AuthUser };
  return json.data;
};

export const deleteMe = async (confirm: string): Promise<void> => {
  const res = await fetch(`${API_URL}/api/user/me`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `DELETE /me → ${res.status}`);
  }
};

export const listSessions = async (): Promise<SessionMeta[]> => {
  const res = await fetch(`${API_URL}/api/user/sessions`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`listSessions → ${res.status}`);
  const json = await res.json() as { data: SessionMeta[] };
  return json.data ?? [];
};

export const revokeSession = async (token: string): Promise<void> => {
  const res = await fetch(`${API_URL}/api/user/sessions/${encodeURIComponent(token)}`, {
    method: 'DELETE',
    credentials: 'include',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`revokeSession → ${res.status}`);
};

export const revokeAllSessions = async (): Promise<{ revoked: number }> => {
  const res = await fetch(`${API_URL}/api/user/sessions/revoke-all`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`revokeAllSessions → ${res.status}`);
  const json = await res.json() as { data: { revoked: number } };
  return json.data;
};

export const clearHistory = async (): Promise<{ deleted: number }> => {
  const res = await fetch(`${API_URL}/api/user/history`, {
    method: 'DELETE',
    credentials: 'include',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`clearHistory → ${res.status}`);
  const json = await res.json() as { data: { deleted: number } };
  return json.data;
};

export const clearBookmarks = async (): Promise<{ deleted: number }> => {
  const res = await fetch(`${API_URL}/api/user/bookmarks`, {
    method: 'DELETE',
    credentials: 'include',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`clearBookmarks → ${res.status}`);
  const json = await res.json() as { data: { deleted: number } };
  return json.data;
};

export const getCurrentSessionToken = (): string | null => {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

// ── Admin dashboard helpers ──

export const roleLabel = (role: string): string => (role === 'admin' ? 'Admin' : 'Member');

// Cookie auth GET for admin monitoring endpoints (read-only, session.role===admin enforced server-side).
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`apiGet ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
