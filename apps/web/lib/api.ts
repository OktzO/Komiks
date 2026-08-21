import { murmur3_32 } from '@manga-platform/shared/r2-routing';

// API_URL must be set in production via NEXT_PUBLIC_API_URL. The localhost
// fallback is only for local dev (wrangler dev on :8787).
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

// Image proxy fallback base: situs sendiri (oktzz.xyz). Dipakai bila pool origin
// /img kosong (semua worker lain down). Priority utama: round-robin worker.
export const IMG_BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://oktzz.xyz';

// Auth API: primary akun-2, fallback akun-3, last resort akun-1 (main).
// Sticky origin via sessionStorage — setelah login, semua /api/auth/* + /api/user/*
// calls ikut origin yang dipilih (D1 split per-akun, data user harus konsisten).
const AUTH_API_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || API_URL;
const AUTH_CACHE_KEY = 'auth_origin';
// Module-level cache (5 min): hindari health-check berulang tiap mount
// (BookmarkButton, Navbar, AuthForm, admin pages). Sticky sessionStorage
// tetap prioritas utama; cache ini hanya menutup window sebelum login.
let authOriginCache: { origin: string; at: number } | null = null;

export async function getAuthApiUrl(): Promise<string> {
  if (typeof sessionStorage !== 'undefined') {
    const cached = sessionStorage.getItem(AUTH_CACHE_KEY);
    if (cached) return cached;
  }
  if (authOriginCache && Date.now() - authOriginCache.at < 300000) {
    return authOriginCache.origin;
  }
  const candidate = AUTH_API_URL || API_URL;
  try {
    const res = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      authOriginCache = { origin: candidate, at: Date.now() };
      return candidate;
    }
  } catch {}
  authOriginCache = { origin: candidate, at: Date.now() };
  return candidate;
}

// Set sticky origin after successful login (called by AuthForm post-callback).
// MUST be called immediately after login so subsequent bookmark/me calls hit the
// cookie-bearing origin (avoids cross-origin cookie 401 + D1-split inconsistency).
export function setAuthOrigin(origin: string): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(AUTH_CACHE_KEY, origin);
  }
}

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
  pages?: { proxyUrl: string; imgUrl?: string | null; b2Url?: string | null }[];
}

// 12s timeout prevents Cloudflare Pages Function timeout (30s) from
// triggering a 502 when the Worker API is slow on cold KV cache.
async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
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

// ---- Data API (now merged into single manga-api Worker) ----------------------
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
  latency_ms: number | null;
  last_checked_at: number;
  error?: string;
  uptime_pct?: number | null;
  history?: Array<{ healthy: boolean; latency_ms: number | null; error: string | null; checked_at: number }>;
}

export const searchMerged = (q: string): Promise<{ data: MergedManga[]; sources_queried: string[] }> =>
  apiWithFailover(`/api/search?q=${encodeURIComponent(q)}`);

// Homepage feed: KV-cached 12 jam (cron akun-1 scrape + push cross-account).
export const fetchHomepage = (): Promise<{ data: Array<MergedManga & { popularity?: number }>; sources_queried: string[] }> =>
  apiWithFailover('/api/homepage');

// Status + riwayat monitoring: selalu ke API utama (akun-1) supaya data
// source_health konsisten (tidak round-robin ke D1 per-akun yang beda).
// Update hanya pasif — tercatat saat ada aktivitas baca dari sumber (bukan polling).
export const getSourceStatus = (): Promise<{ data: SourceStatus[] }> =>
  api('/api/source-status');

// ---- Round-robin origin failover (LB multi-account) --------------------
// Health-aware: skip origin yang 429/5xx/timeout (circuit breaker 60s per
// origin setelah 2 gagal beruntun). Round-robin cursor di sessionStorage
// supaya beban tersebar ke semua worker (bukan selalu mulai di index 0).
// Hanya path publik yang boleh dipanggil ke origin — allowlist eksplisit.
// D1 chapter_pages kini shard-readable dari worker mana pun (owner forwarding),
// jadi reader/series/search/health boleh round-robin. source-status TIDAK di
// sini — data source_health di D1 tiap akun bisa beda (recordHealth per-akun),
// jadi status page harus selalu baca dari akun-1 (konsisten).
const ORIGIN_PATH_ALLOWLIST = [
  '/api/reader/',
  '/api/series',
  '/api/search',
  '/api/homepage',
  '/api/health',
];

// Module-level cache (60s): SSR render (detail page) juga butuh daftar origins,
// sessionStorage tidak ada di server — tanpa cache ini tiap server render
// melakukan 1 fetch /api/origins tambahan.
let originsCache: { data: { url: string }[]; at: number } | null = null;

const getOrigins = async (): Promise<{ url: string }[]> => {
  const cached = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('origins') : null;
  if (cached) return JSON.parse(cached) as { url: string }[];
  if (originsCache && Date.now() - originsCache.at < 60000) return originsCache.data;
  try {
    const res = await fetch(`${API_URL}/api/origins`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json = await res.json() as { data: { url: string }[] };
    const data = json.data || [];
    if (typeof sessionStorage !== 'undefined' && data.length > 0) {
      sessionStorage.setItem('origins', JSON.stringify(data));
      setTimeout(() => sessionStorage.removeItem('origins'), 60000);
    }
    originsCache = { data, at: Date.now() };
    return data;
  } catch {
    return [];
  }
};

// Round-robin cursor (client only). Persisted in sessionStorage so consecutive
// page loads rotate across workers instead of always starting at index 0.
// NOT used on the server: sessionStorage doesn't exist there and a fixed
// fallback (prev=0) would pin every SSR request to the same origin index,
// skewing ~100% of SSR load onto a single worker.
const getNextRrIndex = (len: number): number => {
  const key = 'rr_index';
  const prev = typeof sessionStorage !== 'undefined' ? Number(sessionStorage.getItem(key)) || 0 : 0;
  const next = (prev + 1) % len;
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, String(next));
  return next;
};

// Image proxy origin picker — round-robin /img/* ke worker, EXCEPT origin
// utama (akun-1, = API_URL) yang sering penuh (test + web lain di akun itu).
// Hash deterministik per path → halaman selalu ke worker yang sama (Workers
// Cache per-worker hangat). `retry > 0` → geser ke worker lain (failover saat
// worker down/429). Pool kosong → fallback IMG_BASE_URL (oktzz.xyz).
// sessionStorage 'origins' dihapus getOrigins() tiap 60s — simpan module cache
// supaya tidak flip balik ke akun-1 di tengah sesi; warm ulang async bila kosong.
let imgOriginsFallback: string[] | null = null;
let imgOriginsWarming = false;

export const imgOriginFor = (imgPath: string, retry = 0): string => {
  let os: string[] | null = null;
  if (typeof sessionStorage !== 'undefined') {
    const c = sessionStorage.getItem('origins');
    if (c) {
      try { os = (JSON.parse(c) as { url: string }[]).map((o) => o.url); } catch { os = null; }
    }
  }
  if (os === null) os = imgOriginsFallback;
  else imgOriginsFallback = os;

  const pool = (os ?? []).filter((u) => u !== API_URL);
  if (pool.length === 0) {
    if (!imgOriginsWarming) {
      imgOriginsWarming = true;
      getOrigins().catch(() => {}).finally(() => { imgOriginsWarming = false; });
    }
    return IMG_BASE_URL;
  }
  const idx = (murmur3_32(imgPath) + retry) % pool.length;
  return pool[idx];
};

// Circuit state per origin: gagal beruntun → skip 60s.
const failures = new Map<string, { count: number; until: number }>();

const isCircuitOpen = (url: string, now: number): boolean => {
  const s = failures.get(url);
  return !!(s && s.until > now);
};

// Build the ordered attempt list for one request.
// - Client: cursor rotation (unchanged behavior); open origins are skipped
//   inside the fetch loop.
// - Server (SSR, stateless edge): random rotation per request over HEALTHY
//   origins only, so load spreads evenly and an open origin is never picked
//   first. If every origin is open (edge case), fall back to the full pool —
//   never fail hard — and log the event for investigation.
const buildOriginOrder = (origins: { url: string }[]): { url: string }[] => {
  if (typeof sessionStorage === 'undefined') {
    const now = Date.now();
    const healthy = origins.filter((o) => !isCircuitOpen(o.url, now));
    const pool = healthy.length > 0 ? healthy : origins;
    if (healthy.length === 0) {
      console.warn('[apiWithFailover] all origins circuit-open — using full pool (may add latency)');
    }
    const start = Math.floor(Math.random() * pool.length);
    return [...pool.slice(start), ...pool.slice(0, start)];
  }
  const start = getNextRrIndex(origins.length);
  return [...origins.slice(start), ...origins.slice(0, start)];
};

export async function apiWithFailover<T>(path: string): Promise<T> {
  if (!ORIGIN_PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
    return api<T>(path); // non-publik → main API saja
  }
  const origins = await getOrigins();
  if (origins.length === 0) return api<T>(path);

  const now = Date.now();
  // Rotate across ALL origins (not a fixed 2-attempt cap) so load spreads.
  for (const origin of buildOriginOrder(origins)) {
    const state = failures.get(origin.url);
    if (state && state.until > now) continue; // circuit open → skip
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
import type { UserPreferences, MeResponse } from '@manga-platform/shared/types';

export type { UserPreferences };

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
    const base = await getAuthApiUrl();
    const res = await fetch(`${base}/api/user/me`, {
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
    const base = await getAuthApiUrl();
    await fetch(`${base}/api/auth/logout`, {
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
  const base = await getAuthApiUrl();
  const res = await fetch(`${base}/api/user/me`, {
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
  const base = await getAuthApiUrl();
  const res = await fetch(`${base}/api/user/me`, {
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

export const clearHistory = async (): Promise<{ deleted: number }> => {
  const base = await getAuthApiUrl();
  const res = await fetch(`${base}/api/user/history`, {
    method: 'DELETE',
    credentials: 'include',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`clearHistory → ${res.status}`);
  const json = await res.json() as { data: { deleted: number } };
  return json.data;
};

export const clearBookmarks = async (): Promise<{ deleted: number }> => {
  const base = await getAuthApiUrl();
  const res = await fetch(`${base}/api/user/bookmarks`, {
    method: 'DELETE',
    credentials: 'include',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`clearBookmarks → ${res.status}`);
  const json = await res.json() as { data: { deleted: number } };
  return json.data;
};

// ── Admin dashboard helpers ──

export const roleLabel = (role: string): string => (role === 'admin' ? 'Admin' : 'Member');

// Cookie auth GET for admin monitoring endpoints (read-only, session.role===admin enforced server-side).
// Uses getAuthApiUrl() so the session cookie is sent to the auth origin —
// without this, admin endpoints can fail with 403/CORS when the main API_URL
// differs from the origin that set the session cookie.
export async function apiGet<T>(path: string): Promise<T> {
  const base = await getAuthApiUrl();
  const res = await fetch(`${base}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`apiGet ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const base = await getAuthApiUrl();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`apiPost ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const base = await getAuthApiUrl();
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`apiPatch ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
