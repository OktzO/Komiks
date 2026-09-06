import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type {
  Series,
  Chapter,
  ChapterPage,
  Bookmark,
  ReadingHistory,
  LbSettings,
  LbAccount,
  LbAccountSafe,
  LbOrigin,
  ScrapeJob,
  MeResponse
} from '@manga-platform/shared/types';
import { matchCandidate, type MatchCandidate } from './src/matching.js';

export { D1Database as Database };

type Row = Record<string, unknown>;
type Result<T> = T | null;
type ListResult<T> = T[];

export interface Db {
  getSeriesBySlug: (slug: string) => Promise<Result<Series>>;
  getSeriesById: (id: number) => Promise<Result<Series>>;
  listSeries: (params: { genre?: string; page?: number; limit?: number }) => Promise<ListResult<Series>>;
  getChapter: (chapterId: string) => Promise<Result<Chapter>>;
  listChapterPages: (chapterId: string) => Promise<ListResult<ChapterPage>>;
  markPageB2Uploaded: (params: { chapterId: string; pageNumber: number; imageUrl: string; b2Key: string; b2AccountIdx: number }) => Promise<{ success: boolean }>;
  incrementLbUsage: (params: { originUrl: string; dateKey: string }) => Promise<{ success: boolean }>;
  listLbUsage: (dateKey: string) => Promise<Array<{ origin_url: string; req_count: number }>>;
  searchSeries: (query: string) => Promise<ListResult<Series>>;
  createUser: (params: { email: string; name?: string | null; passwordHash: string; role?: string }) => Promise<Result<{ id: number }>>;
  getUserById: (id: number) => Promise<Result<{ id: number; email: string; name: string | null; role: string }>>;
  getUserProfileById: (id: number) => Promise<Result<MeResponse>>;
   getUserByEmail: (email: string) => Promise<Result<{ id: number; email: string; password_hash: string | null; role: string; status: string }>>;
   updateUserProfile: (userId: number, params: { displayName?: string | null; bio?: string | null; preferences?: Record<string, unknown> }) => Promise<{ success: boolean }>;
   deleteUserAccount: (userId: number) => Promise<{ success: boolean }>;
   clearUserHistory: (userId: number) => Promise<{ success: boolean; deleted: number }>;
   clearUserBookmarks: (userId: number) => Promise<{ success: boolean; deleted: number }>;
   addBookmark: (params: { userId: number; seriesSlug: string; source?: string; source_url?: string; title?: string; cover_image?: string }) => Promise<{ success: boolean }>;
   removeBookmark: (params: { userId: number; seriesSlug: string }) => Promise<{ success: boolean }>;
   isBookmarked: (params: { userId: number; seriesSlug: string }) => Promise<boolean>;
   listBookmarks: (userId: number) => Promise<ListResult<Series>>;
  upsertHistory: (params: { userId: number; chapterId: string; lastPage: number }) => Promise<Result<ReadingHistory>>;
  listHistory: (userId: number, limit?: number) => Promise<ListResult<Chapter>>;
  getLbSettings: () => Promise<Result<LbSettings>>;
  setLbSettings: (updates: Partial<Omit<LbSettings, 'id'>>, id?: number) => Promise<{ success: boolean }>;
  listAccounts: () => Promise<ListResult<LbAccountSafe>>;
  addAccount: (params: Pick<LbAccount, 'label' | 'provider' | 'account_ref' | 'encrypted_token' | 'token_last4' | 'status' | 'created_by'>) => Promise<Result<{ id: string }>>;
  deleteAccount: (id: string) => Promise<{ success: boolean }>;
  createOrigin: (params: Pick<LbOrigin, 'account_id' | 'origin_url' | 'priority' | 'weight' | 'enabled'>) => Promise<Result<{ id: string }>>;
  listOrigins: () => Promise<ListResult<LbOrigin>>;
  updateOrigin: (id: string, params: Partial<Omit<LbOrigin, 'id' | 'created_at'>>) => Promise<{ success: boolean }>;
  recordOriginHealth: (originId: string, healthy: boolean, checkedAt?: number) => Promise<{ success: boolean }>;
  getOriginStatus: (originId: string) => Promise<Result<{ healthy: boolean; last_checked_at: number | null }>>;
  addAuditLog: (params: { accountId?: string | null; originId?: string | null; action: string; userId?: number | null }) => Promise<{ success: boolean }>;
  upsertSeries: (params: { slug: string; title: string; external_id?: string | null; source: string; synopsis?: string | null; type: string; status?: string; author?: string | null; artist?: string | null; cover_image?: string | null; genres?: string[]; tags?: string[]; alt_titles?: string | null; source_url?: string | null; cover_r2_key?: string | null; language?: string | null }) => Promise<{ slug: string }>;
  addImageHash: (params: { seriesSlug: string; hash: string; r2Key?: string | null; imageType: 'cover' | 'page' }) => Promise<{ id: number }>;
  getAllImageHashes: () => Promise<Array<{ series_slug: string; hash: string; r2_key: string | null }>>;
  createScrapeJob: (params: { id: string; source: string; sourceUrl?: string | null; query?: string | null; createdBy?: number | null }) => Promise<{ id: string }>;
  updateScrapeJob: (id: string, params: { status: string; seriesSlug?: string | null; error?: string | null; completedAt?: number | null }) => Promise<{ success: boolean }>;
  getScrapeJob: (id: string) => Promise<Result<ScrapeJob>>;
  listScrapeJobs: (limit?: number) => Promise<ListResult<ScrapeJob>>;
  recordSourceHealth: (params: { source: string; healthy: boolean; latencyMs?: number | null; error?: string | null }) => Promise<{ id: number }>;
  getLatestSourceHealth: (source: string) => Promise<Result<{ source: string; healthy: boolean; latency_ms: number | null; error: string | null; checked_at: number }>>;
  getSourceHistory: (source: string, limit?: number) => Promise<Array<{ healthy: boolean; latency_ms: number | null; error: string | null; checked_at: number }>>;
  upsertSourceLink: (params: { mangaId: number; source: string; sourceSlug: string; hasChapterList?: number; chapterCount?: number; lastScrapedAt?: number }) => Promise<Result<{ id: number }>>;
  getSourceLinksByManga: (mangaId: number) => Promise<Array<{ source: string; source_slug: string; chapter_count: number; has_chapter_list: number; last_scraped_at: number | null }>>;
  getMangaBySource: (source: string, sourceSlug: string) => Promise<Result<{ id: number; slug: string; title: string; source: string }>>;
  getAllSeriesTitles: () => Promise<Array<{ id: number; title: string; alt_titles: string | null }>>;
  pickMergeTarget: (mangaIds: number[]) => Promise<{ id: number; slug: string } | null>;
  mergeSeriesInto: (targetMangaId: number, sourceMangaIds: number[]) => Promise<{ success: boolean }>;
  dedupeOnIndex: (params: { source: string; sourceSlug: string; title: string; altTitles?: string[] }) => Promise<{ merged: boolean; queued: boolean; candidateId?: number }>;
  listMergeQueue: (status?: string) => Promise<ListResult<{ id: number; source: string; source_slug: string; title: string; candidate_ids: string; confidence: number; status: string; created_at: number }>>;
  addMergeQueue: (params: { source: string; sourceSlug: string; title: string; candidateIds: number[]; confidence: number }) => Promise<Result<{ id: number }>>;
  resolveMergeQueue: (id: number, action: 'merge' | 'reject', targetMangaId?: number) => Promise<{ success: boolean }>;
  mergeSeries: (targetSlug: string, sourceSlug: string) => Promise<{ success: boolean }>;

  // ── Admin monitoring (0006) ──
  listProviderAccounts: () => Promise<ListResult<{ id: string; provider: string; label: string; status: string; last_success_at: number | null; last_failure_at: number | null; last_error: string | null; requests_24h: number; failures_24h: number; quota_used_bytes: number | null; quota_limit_bytes: number | null; updated_at: number }>>;
  listScrapeJobsLog: (params: { source?: string; status?: string; from?: number; to?: number; page?: number; limit?: number }) => Promise<{ data: Array<{ id: string; source: string; provider_account_id: string | null; status: string; items_scraped: number; duration_ms: number | null; error_message: string | null; started_at: number; finished_at: number | null }>; total: number; page: number }>;
  getDbUsageTrend: (days?: number) => Promise<Array<{ db_name: string; points: Array<{ ts: number; size_bytes: number | null; rows_or_objects: number | null }> }>>;
  getAdminOverview: () => Promise<{ usersTotal: number; bookmarksTotal: number; scrape24h: { success: number; failed: number }; providers: { healthy: number; degraded: number; down: number } }>;
  listUsersAdmin: (params: { q?: string; page?: number; limit?: number }) => Promise<{ data: Array<{ id: number; email: string; name: string | null; role: string; status: string; created_at: number; last_login_at: number | null; bookmark_count: number }>; total: number; page: number }>;
  getUserDetail: (id: number) => Promise<Result<{ id: number; email: string; name: string | null; role: string; status: string; created_at: number; last_login_at: number | null; bookmark_count: number }>>;
  listUserBookmarksAdmin: (userId: number, params: { page?: number; limit?: number }) => Promise<{ data: Array<{ series_slug: string; title: string | null; cover_image: string | null; added_at: number }>; total: number; page: number }>;
  getProviderHealthBuckets: (providerAccountId: string, hours: number) => Promise<Array<{ started_at: number; status: string; items_scraped: number; duration_ms: number | null }>>;

  // ── Sessions (0008) — KV-free signed-cookie auth ──
  insertSession: (params: { sid: string; userId: number; createdAt: number; expiresAt: number; ua: string | null; ip: string | null }) => Promise<{ success: boolean }>;
  getSession: (sid: string) => Promise<Result<{ sid: string; user_id: number; created_at: number; expires_at: number; revoked_at: number | null; ua: string | null; ip: string | null }>>;
  revokeSession: (sid: string) => Promise<{ success: boolean }>;
  listUserSessions: (userId: number) => Promise<Array<{ sid: string; created_at: number; expires_at: number; revoked_at: number | null; ua: string | null }>>;
  revokeAllUserSessions: (userId: number, exceptSid?: string) => Promise<{ revoked: number }>;
  // ── chapter_pages.last_access (0009) — LRU eviction ──
  touchPageLastAccess: (chapterId: string, pageNo: number) => Promise<{ success: boolean }>;
  listStalePages: (accountIdx: number, staleBeforeTs: number, limit: number) => Promise<Array<{ chapter_id: string; page_number: number; r2_key: string; r2_account_idx: number; last_access: number | null }>>;
  clearPageStorage: (chapterId: string, pageNo: number) => Promise<{ success: boolean }>;

  // ── Admin dashboard (0013) — moderation + security feed ──
  getUserStatusAdmin: (id: number) => Promise<Result<{ id: number; role: string; status: string }>>;
  updateUserAdmin: (id: number, params: { status?: string; role?: string }) => Promise<{ success: boolean }>;
  addSecurityEvent: (params: { type: string; severity?: string; message?: string | null; ip?: string | null; path?: string | null }) => Promise<{ id: number }>;
  listSecurityEvents: (params: { resolved?: boolean; page?: number; limit?: number }) => Promise<{ data: Array<{ id: number; type: string; severity: string; message: string | null; ip: string | null; path: string | null; resolved: number; created_at: number; resolved_at: number | null }>; total: number; page: number }>;
  resolveSecurityEvent: (id: number) => Promise<{ success: boolean }>;
  getSourceHealthSummary: () => Promise<Array<{ source: string; total: number; healthy: number; uptime_pct: number | null; last_checked_at: number | null; last_healthy: number | null; last_error: string | null }>>;
  countScrapedChaptersBySource: (since: number) => Promise<Array<{ source: string; chapters: number; last_scraped_at: number | null }>>;
  listLbUsageRange: (fromDate: string, toDate: string) => Promise<Array<{ origin_url: string; date_key: string; req_count: number }>>;
  insertUsageSnapshot: (params: { dbName: string; rowsOrObjects?: number | null; sizeBytes?: number | null; capturedAt?: number }) => Promise<{ success: boolean }>;
}

export const db = (client: D1Database): Db => {
  const prep = (sql: string): D1PreparedStatement => client.prepare(sql);
  const fromRow = <T>(r: Row | null): Result<T> => (r ? (r as unknown as T) : null);

  const parseJson = (row: Row): Series => {
    const out = { ...(row as Record<string, unknown>) } as Record<string, unknown>;
    for (const k of ['genres', 'tags']) {
      const v = row[k];
      out[k] = typeof v === 'string' ? (JSON.parse(v) as string[]) : v;
    }
    return out as unknown as Series;
  };

  return {
    getSeriesBySlug: async (slug) =>
      fromRow<Series>(await prep('SELECT * FROM series WHERE slug = ?1 LIMIT 1').bind(slug).first<Row>()
        .then(r => (r ? parseJson(r) : null))),

    getSeriesById: async (id) =>
      fromRow<Series>(await prep('SELECT * FROM series WHERE id = ?1 LIMIT 1').bind(id).first<Row>()
        .then(r => (r ? parseJson(r) : null))),

    listSeries: async ({ genre, page = 1, limit = 20 }) => {
      const offset = (page - 1) * limit;
      if (genre) {
        const { results } = await prep(
          "SELECT * FROM series WHERE genres LIKE ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2 OFFSET ?3"
        ).bind(`%"${genre}"%`, limit, offset).all<Row>();
        return (results ?? []).map(parseJson);
      }
      const { results } = await prep(
        'SELECT * FROM series ORDER BY updated_at DESC, id DESC LIMIT ?1 OFFSET ?2'
      ).bind(limit, offset).all<Row>();
      return (results ?? []).map(parseJson);
    },

    getChapter: async (chapterId) =>
      fromRow<Chapter>(await prep('SELECT * FROM chapters WHERE id = ?1 LIMIT 1').bind(chapterId).first<Row>()),

    listChapterPages: async (chapterId) => {
      const { results } = await prep(
        'SELECT id, chapter_id, page_number, image_url FROM chapter_pages WHERE chapter_id = ?1 ORDER BY page_number ASC'
      ).bind(chapterId).all<Row>();
      return (results ?? []) as unknown as ListResult<ChapterPage>;
    },

    markPageB2Uploaded: async (p) => {
      try {
        await prep(`INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx, last_access)
          VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
          ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx, image_url = excluded.image_url, last_access = strftime('%s','now')`)
          .bind(p.chapterId, p.pageNumber, p.imageUrl, p.b2Key, p.b2AccountIdx).run();
        return { success: true };
      } catch (e) {
        console.error('[markPageB2Uploaded] failed:', String(e));
        return { success: false };
      }
    },

    incrementLbUsage: async (p) => {
      await prep(`INSERT INTO lb_usage (origin_url, date_key, req_count, updated_at) VALUES (?, ?, 1, ?)
        ON CONFLICT(origin_url, date_key) DO UPDATE SET req_count = req_count + 1, updated_at = excluded.updated_at`)
        .bind(p.originUrl, p.dateKey, Date.now()).run();
      return { success: true };
    },

    listLbUsage: async (dateKey) => {
      const { results } = await prep('SELECT origin_url, req_count FROM lb_usage WHERE date_key = ? ORDER BY req_count DESC')
        .bind(dateKey).all<Row>();
      return (results ?? []) as unknown as Array<{ origin_url: string; req_count: number }>;
    },

    searchSeries: async (query) => {
      const { results } = await prep(
        'SELECT s.* FROM series_search f JOIN series s ON s.id = f.rowid WHERE series_search MATCH ?1 ORDER BY rank'
      ).bind(query).all<Row>();
      if (results && results.length > 0) return results.map(parseJson);
      const like = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      const fb = await prep(
        "SELECT * FROM series WHERE title LIKE ?1 ESCAPE '\\' OR synopsis LIKE ?1 ESCAPE '\\' ORDER BY title LIMIT 50"
      ).bind(like).all<Row>();
      return (fb.results ?? []).map(parseJson);
    },

    createUser: async ({ email, name, passwordHash, role = 'user' }) =>
      fromRow<{ id: number }>(
        await prep(
          'INSERT INTO users (email, name, password_hash, role) VALUES (?1, ?2, ?3, ?4) RETURNING id'
        ).bind(email, name ?? null, passwordHash, role).first<Row>()
      ),

    getUserById: async (id) =>
      fromRow<{ id: number; email: string; name: string | null; role: string }>(
        await prep('SELECT id, email, name, role FROM users WHERE id = ?1 LIMIT 1').bind(id).first<Row>()
      ),

    getUserProfileById: async (id) => {
      const row = await prep(
        'SELECT id, email, name, role, display_name, avatar_url, bio, preferences, created_at FROM users WHERE id = ?1 LIMIT 1'
      ).bind(id).first<Row>();
      if (!row) return null;
      return {
        id: Number(row.id),
        email: row.email as string,
        name: row.name as string | null,
        role: row.role as string,
        display_name: row.display_name as string | null,
        avatar_url: row.avatar_url as string | null,
        bio: row.bio as string | null,
        preferences: JSON.parse(row.preferences as string) as MeResponse['preferences'],
        created_at: Number(row.created_at),
      } as MeResponse;
    },

     getUserByEmail: async (email) =>
       fromRow<{ id: number; email: string; password_hash: string | null; role: string; status: string }>(
         await prep('SELECT id, email, password_hash, role, status FROM users WHERE email = ?1 LIMIT 1').bind(email).first<Row>()
       ),

     updateUserProfile: async (userId, { displayName, bio, preferences }) => {
       const sets: string[] = [];
       const args: unknown[] = [];
       if (displayName !== undefined) {
         sets.push(`display_name = COALESCE(?${args.length + 1}, display_name)`);
         args.push(displayName);
       }
       if (bio !== undefined) {
         sets.push(`bio = COALESCE(?${args.length + 1}, bio)`);
         args.push(bio);
       }
       if (preferences !== undefined) {
         sets.push(`preferences = COALESCE(?${args.length + 1}, preferences)`);
         args.push(preferences ? JSON.stringify(preferences) : null);
       }
       if (sets.length === 0) return { success: true };
       const res = await prep(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${args.length + 1}`)
         .bind(...args, userId).run();
       return { success: res.success };
     },

     deleteUserAccount: async (userId) => {
       const res = await prep('DELETE FROM users WHERE id = ?1').bind(userId).run();
       return { success: res.success };
     },

     clearUserHistory: async (userId) => {
       const countRow = await prep('SELECT COUNT(*) AS c FROM reading_history WHERE user_id = ?1').bind(userId).first<Row>();
       const deleted = countRow ? Number(countRow.c) : 0;
       await prep('DELETE FROM reading_history WHERE user_id = ?1').bind(userId).run();
       return { success: true, deleted };
     },

     clearUserBookmarks: async (userId) => {
       const countRow = await prep('SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?1').bind(userId).first<Row>();
       const deleted = countRow ? Number(countRow.c) : 0;
       await prep('DELETE FROM bookmarks WHERE user_id = ?1').bind(userId).run();
       return { success: true, deleted };
     },

      addBookmark: async ({ userId, seriesSlug, source, source_url, title, cover_image }) => {
       // Ensure the FK parent `series` row exists BEFORE inserting the bookmark.
       // The auth origin's D1 (akun-2) has a sparse `series` table (only scraped
       // rows) — a user can bookmark a slug that isn't in this account's DB yet.
       // Without the parent row, `INSERT OR IGNORE` still throws
       // SQLITE_CONSTRAINT (FOREIGN KEY) → POST 500 → frontend button reverts.
       await prep(
         `INSERT INTO series (slug, source, title, type, status, cover_image, updated_at)
          VALUES (?1, ?2, ?3, 'manga', 'ongoing', ?4, unixepoch())
          ON CONFLICT(slug) DO UPDATE SET
            cover_image = COALESCE(excluded.cover_image, series.cover_image),
            updated_at = unixepoch()`
       ).bind(seriesSlug, source ?? 'local', title ?? seriesSlug, cover_image ?? null).run();
       const res = await prep('INSERT OR IGNORE INTO bookmarks (user_id, series_slug, source, source_url) VALUES (?1, ?2, ?3, ?4)')
         .bind(userId, seriesSlug, source ?? null, source_url ?? null).run();
       return { success: res.success };
      },

    removeBookmark: async ({ userId, seriesSlug }) => {
      const res = await prep('DELETE FROM bookmarks WHERE user_id = ?1 AND series_slug = ?2')
        .bind(userId, seriesSlug).run();
      return { success: res.success };
    },

    isBookmarked: async ({ userId, seriesSlug }) => {
      const row = await prep('SELECT 1 FROM bookmarks WHERE user_id = ?1 AND series_slug = ?2')
        .bind(userId, seriesSlug).first<Row>();
      return !!row;
    },

    listBookmarks: async (userId) => {
       const { results } = await prep(
         `SELECT s.*, b.source AS bookmark_source, b.source_url AS bookmark_url, b.created_at AS bookmark_created_at
          FROM bookmarks b JOIN series s ON s.slug = b.series_slug
          WHERE b.user_id = ?1
          ORDER BY b.created_at DESC`
       ).bind(userId).all<Row>();
       return (results ?? []).map(parseJson);
     },

    upsertHistory: async ({ userId, chapterId, lastPage }) =>
      fromRow<ReadingHistory>(
        await prep(
          `INSERT INTO reading_history (user_id, chapter_id, last_page)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(user_id, chapter_id) DO UPDATE SET last_page = ?3, updated_at = unixepoch()
           RETURNING *`
        ).bind(userId, chapterId, lastPage).first<Row>()
      ),

    listHistory: async (userId, limit = 50) => {
      const { results } = await prep(
        `SELECT c.* FROM reading_history rh
         JOIN chapters c ON c.id = rh.chapter_id
         WHERE rh.user_id = ?1 ORDER BY rh.updated_at DESC LIMIT ?2`
      ).bind(userId, limit).all<Row>();
      return (results ?? []) as unknown as ListResult<Chapter>;
    },

    getLbSettings: async () =>
      fromRow<LbSettings>(
        await prep('SELECT * FROM lb_settings WHERE id = ?1 LIMIT 1').bind(1).first<Row>()
      ),

    setLbSettings: async (updates, id = 1) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      for (const [k, v] of Object.entries(updates)) {
        if (k === 'id') continue;
        sets.push(`${k} = ?${args.length + 1}`);
        args.push(v);
      }
      if (sets.length === 0) return { success: true };
      const res = await prep(`UPDATE lb_settings SET ${sets.join(', ')} WHERE id = ?${args.length + 1}`)
        .bind(...args, id).run();
      return { success: res.success };
    },

    listAccounts: async () => {
      const { results } = await prep(
        'SELECT id, provider, label, account_ref, token_last4, status, created_by, created_at FROM lb_accounts ORDER BY id'
      ).all<Row>();
      return (results ?? []) as unknown as ListResult<LbAccountSafe>;
    },

    addAccount: async ({ label, provider, account_ref, encrypted_token, token_last4, status = 'unverified', created_by }) =>
      fromRow<{ id: string }>(
        await prep(
          'INSERT INTO lb_accounts (id, provider, label, account_ref, encrypted_token, token_last4, status, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id'
        ).bind(crypto.randomUUID(), provider, label, account_ref ?? null, encrypted_token, token_last4, status, created_by ?? null).first<Row>()
      ),

    deleteAccount: async (id) => {
      const res = await prep('DELETE FROM lb_accounts WHERE id = ?1').bind(id).run();
      return { success: res.success };
    },

    createOrigin: async ({ account_id, origin_url, priority = 0, weight = 1, enabled = 1 }) =>
      fromRow<{ id: string }>(
        await prep(
          'INSERT INTO lb_origins (id, account_id, origin_url, priority, weight, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id'
        ).bind(crypto.randomUUID(), account_id ?? null, origin_url, priority, weight, enabled).first<Row>()
      ),

    listOrigins: async () => {
      const { results } = await prep(
        'SELECT * FROM lb_origins ORDER BY priority DESC, id'
      ).all<Row>();
      return (results ?? []) as unknown as ListResult<LbOrigin>;
    },

    updateOrigin: async (id, params) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      for (const [k, v] of Object.entries(params)) {
        if (k === 'id' || k === 'created_at') continue;
        sets.push(`${k} = ?${args.length + 1}`);
        args.push(v);
      }
      if (sets.length === 0) return { success: true };
      const res = await prep(`UPDATE lb_origins SET ${sets.join(', ')} WHERE id = ?${args.length + 1}`)
        .bind(...args, id).run();
      return { success: res.success };
    },

    // updates lb_origins last_health_status + last_checked_at (append-only audit via addAuditLog separately)
    recordOriginHealth: async (originId, healthy, checkedAt) => {
      const status = healthy ? 'healthy' : 'unhealthy';
      const ts = checkedAt ?? Math.floor(Date.now() / 1000);
      const res = await prep(
        'UPDATE lb_origins SET last_health_status = ?1, last_checked_at = ?2 WHERE id = ?3'
      ).bind(status, ts, originId).run();
      return { success: res.success };
    },

    getOriginStatus: async (originId) => {
      const row = await prep(
        'SELECT last_health_status, last_checked_at FROM lb_origins WHERE id = ?1 LIMIT 1'
      ).bind(originId).first<Row>();
      if (!row) return null;
      return {
        healthy: (row.last_health_status as string) === 'healthy',
        last_checked_at: row.last_checked_at as number | null
      };
    },

    addAuditLog: async ({ accountId, originId, action, userId }) => {
      const res = await prep(
        'INSERT INTO lb_audit_log (account_id, origin_id, action, user_id) VALUES (?1, ?2, ?3, ?4)'
      ).bind(accountId ?? null, originId ?? null, action, userId ?? null).run();
      return { success: res.success };
    },

    upsertSeries: async (p) => {
      const genres = p.genres ? JSON.stringify(p.genres) : null;
      const tags = p.tags ? JSON.stringify(p.tags) : null;
      await prep(
        `INSERT INTO series (slug, external_id, source, title, synopsis, type, status, author, artist, cover_image, genres, tags, alt_titles, source_url, cover_r2_key, language, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, unixepoch())
         ON CONFLICT(slug) DO UPDATE SET
           title=excluded.title, synopsis=excluded.synopsis, status=excluded.status,
           author=excluded.author, artist=excluded.artist, cover_image=excluded.cover_image,
           genres=excluded.genres, tags=excluded.tags, alt_titles=excluded.alt_titles,
           source_url=excluded.source_url, cover_r2_key=excluded.cover_r2_key,
           language=excluded.language, updated_at=unixepoch()`
      ).bind(p.slug, p.external_id ?? null, p.source, p.title, p.synopsis ?? null, p.type, p.status ?? 'ongoing', p.author ?? null, p.artist ?? null, p.cover_image ?? null, genres, tags, p.alt_titles ?? null, p.source_url ?? null, p.cover_r2_key ?? null, p.language ?? null).run();
      return { slug: p.slug };
    },

    addImageHash: async (p) =>
      (await prep('INSERT INTO image_hashes (series_slug, hash, r2_key, image_type) VALUES (?1, ?2, ?3, ?4) RETURNING id')
        .bind(p.seriesSlug, p.hash, p.r2Key ?? null, p.imageType).first<Row>()) as { id: number },

    getAllImageHashes: async () => {
      const { results } = await prep('SELECT series_slug, hash, r2_key FROM image_hashes').all<Row>();
      return (results ?? []) as unknown as Array<{ series_slug: string; hash: string; r2_key: string | null }>;
    },

    createScrapeJob: async (p) =>
      (await prep('INSERT INTO scrape_jobs (id, source, source_url, query, status, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id')
        .bind(p.id, p.source, p.sourceUrl ?? null, p.query ?? null, 'pending', p.createdBy ?? null).first<Row>()) as { id: string },

    updateScrapeJob: async (id, p) => {
      const res = await prep('UPDATE scrape_jobs SET status = ?1, series_slug = ?2, error = ?3, completed_at = ?4 WHERE id = ?5')
        .bind(p.status, p.seriesSlug ?? null, p.error ?? null, p.completedAt ?? null, id).run();
      return { success: res.success };
    },

    getScrapeJob: async (id) =>
      fromRow<ScrapeJob>(await prep('SELECT * FROM scrape_jobs WHERE id = ?1 LIMIT 1').bind(id).first<Row>()),

    listScrapeJobs: async (limit = 50) => {
      const { results } = await prep('SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT ?1').bind(limit).all<Row>();
      return (results ?? []) as unknown as ListResult<ScrapeJob>;
    },

    recordSourceHealth: async (p) => {
      const res = (await prep('INSERT INTO source_health (source, healthy, latency_ms, error) VALUES (?1, ?2, ?3, ?4) RETURNING id')
        .bind(p.source, p.healthy ? 1 : 0, p.latencyMs ?? null, p.error ?? null).first<Row>()) as { id: number };
      // Prune: simpan maks 40 cek terakhir per source (buang yang lebih lama).
      await prep('DELETE FROM source_health WHERE source = ?1 AND id NOT IN (SELECT id FROM source_health WHERE source = ?1 ORDER BY checked_at DESC LIMIT 40)')
        .bind(p.source).run().catch(() => {});
      return res;
    },

    getLatestSourceHealth: async (source) => {
      const row = await prep('SELECT source, healthy, latency_ms, error, checked_at FROM source_health WHERE source = ?1 ORDER BY checked_at DESC LIMIT 1').bind(source).first<Row>();
      if (!row) return null;
      return {
        source: row.source as string,
        healthy: (row.healthy as number) === 1,
        latency_ms: (row.latency_ms as number) ?? null,
        error: (row.error as string) ?? null,
        checked_at: row.checked_at as number
      };
    },

    getSourceHistory: async (source, limit = 40) => {
      const { results } = await prep('SELECT healthy, latency_ms, error, checked_at FROM source_health WHERE source = ?1 ORDER BY checked_at DESC LIMIT ?2').bind(source, limit).all<Row>();
      return (results ?? []).map((row: Row) => ({
        healthy: (row.healthy as number) === 1,
        latency_ms: (row.latency_ms as number) ?? null,
        error: (row.error as string) ?? null,
        checked_at: row.checked_at as number,
      }));
    },

    upsertSourceLink: async (p) => {
      const res = await prep(`
        INSERT INTO manga_source_link (manga_id, source, source_slug, has_chapter_list, chapter_count, last_scraped_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(source, source_slug) DO UPDATE SET
          manga_id = excluded.manga_id,
          has_chapter_list = excluded.has_chapter_list,
          chapter_count = excluded.chapter_count,
          last_scraped_at = excluded.last_scraped_at
        RETURNING id`).bind(p.mangaId, p.source, p.sourceSlug, p.hasChapterList ?? 1, p.chapterCount ?? 0, p.lastScrapedAt ?? null).first<Row>();
      return res ? { id: res.id as number } : null;
    },

    getSourceLinksByManga: async (mangaId) => {
      const { results } = await prep(
        'SELECT source, source_slug, chapter_count, has_chapter_list, last_scraped_at FROM manga_source_link WHERE manga_id = ?1 ORDER BY source'
      ).bind(mangaId).all<Row>();
      return (results ?? []) as unknown as Array<{ source: string; source_slug: string; chapter_count: number; has_chapter_list: number; last_scraped_at: number | null }>;
    },

    getMangaBySource: async (source, sourceSlug) => {
      const row = await prep(
        'SELECT s.id, s.slug, s.title, s.source FROM manga_source_link m JOIN series s ON s.id = m.manga_id WHERE m.source = ?1 AND m.source_slug = ?2 LIMIT 1'
      ).bind(source, sourceSlug).first<Row>();
      return fromRow<{ id: number; slug: string; title: string; source: string }>(row);
    },

    getAllSeriesTitles: async () => {
      const { results } = await prep('SELECT id, title, alt_titles FROM series').all<Row>();
      return (results ?? []) as unknown as Array<{ id: number; title: string; alt_titles: string | null }>;
    },

    // Hot-path dedup: after a series is upserted, find duplicates.
    //   exact match -> auto-merge (keep row with most chapters)
    //   fuzzy >= 0.92 (or ambiguous exact/queue) -> manga_merge_queue for admin
    async dedupeOnIndex({ source, sourceSlug, title, altTitles }: { source: string; sourceSlug: string; title: string; altTitles?: string[] }) {
      const all = await this.getAllSeriesTitles();
      if (!all.length) return { merged: false, queued: false };
      const candidates: MatchCandidate[] = all.map((s) => ({
        id: s.id,
        title: s.title,
        alt_titles: s.alt_titles ? JSON.parse(s.alt_titles) as string[] : [],
      }));
      const result = matchCandidate(title, candidates);
      if (result.type === 'new') return { merged: false, queued: false };

      if (result.type === 'exact') {
        const current = await this.getMangaBySource(source, sourceSlug);
        if (!current) return { merged: false, queued: false };
        const ids = [current.id, result.id];
        const target = await this.pickMergeTarget(ids);
        if (!target) return { merged: false, queued: false };
        const sources = ids.filter((i) => i !== target.id);
        const ok = await this.mergeSeriesInto(target.id, sources);
        return { merged: ok.success, queued: false, candidateId: target.id };
      }

      if (result.type === 'fuzzy') {
        const queued = await this.addMergeQueue({ source, sourceSlug, title, candidateIds: [result.id], confidence: result.score });
        return { merged: false, queued: !!queued, candidateId: result.id };
      }

      // queue / ambiguous
      const queued = await this.addMergeQueue({ source, sourceSlug, title, candidateIds: result.candidateIds, confidence: result.confidence });
      return { merged: false, queued: !!queued, candidateId: result.candidateIds[0] };
    },

    listMergeQueue: async (status) => {
      const sql = status
        ? 'SELECT * FROM manga_merge_queue WHERE status = ?1 ORDER BY created_at DESC LIMIT 100'
        : 'SELECT * FROM manga_merge_queue ORDER BY created_at DESC LIMIT 100';
      const stmt = status ? prep(sql).bind(status) : prep(sql);
      const { results } = await stmt.all<Row>();
      return (results ?? []) as unknown as ListResult<{ id: number; source: string; source_slug: string; title: string; candidate_ids: string; confidence: number; status: string; created_at: number }>;
    },

    addMergeQueue: async (p) => {
      const res = await prep('INSERT INTO manga_merge_queue (source, source_slug, title, candidate_ids, confidence) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id')
        .bind(p.source, p.sourceSlug, p.title, JSON.stringify(p.candidateIds), p.confidence).first<Row>();
      return res ? { id: res.id as number } : null;
    },

    resolveMergeQueue: async (id, action, targetMangaId) => {
      if (action === 'reject') {
        const res = await prep("UPDATE manga_merge_queue SET status = 'rejected', resolved_at = unixepoch() WHERE id = ?1").bind(id).run();
        return { success: res.success };
      }
      const item = await prep('SELECT * FROM manga_merge_queue WHERE id = ?1 AND status = ?2 LIMIT 1').bind(id, 'pending').first<Row>();
      if (!item || !targetMangaId) return { success: false };
      // Move source link into target manga.
      const msl = await prep('SELECT * FROM manga_source_link WHERE source = ?1 AND source_slug = ?2 LIMIT 1')
        .bind(item.source as string, item.source_slug as string).first<Row>();
      if (!msl) return { success: false };
      const sourceMangaId = msl.manga_id as number;
      // Update link + move chapters.
      await prep('UPDATE manga_source_link SET manga_id = ?1 WHERE id = ?2').bind(targetMangaId, msl.id as number).run();
      await prep('UPDATE chapters SET series_slug = (SELECT slug FROM series WHERE id = ?1) WHERE series_slug = (SELECT slug FROM series WHERE id = ?2)')
        .bind(targetMangaId, sourceMangaId).run();
      // Delete orphaned series row if it no longer has links.
      await prep('DELETE FROM series WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM manga_source_link WHERE manga_id = ?1)')
        .bind(sourceMangaId).run();
      const res = await prep("UPDATE manga_merge_queue SET status = 'merged', resolved_at = unixepoch() WHERE id = ?1").bind(id).run();
      return { success: res.success };
    },

    mergeSeries: async (targetSlug, sourceSlug) => {
      const target = await prep('SELECT id FROM series WHERE slug = ?1 LIMIT 1').bind(targetSlug).first<Row>();
      const source = await prep('SELECT id, slug FROM series WHERE slug = ?1 LIMIT 1').bind(sourceSlug).first<Row>();
      if (!target || !source || target.id === source.id) return { success: false };
      await prep('UPDATE manga_source_link SET manga_id = ?1 WHERE manga_id = ?2').bind(target.id, source.id).run();
      await prep('UPDATE chapters SET series_slug = ?1 WHERE series_slug = ?2').bind(targetSlug, sourceSlug).run();
      await prep('DELETE FROM series WHERE id = ?1').bind(source.id).run();
      return { success: true };
    },

    // Pick the best merge target among duplicate manga rows. Target = the row
    // with the most chapters (SUM of chapter_count across its source links);
    // tie-break by source priority komiku > bacakomik > thrive > manhwaindo.
    pickMergeTarget: async (mangaIds) => {
      if (!mangaIds.length) return null;
      const placeholders = mangaIds.map(() => '?').join(',');
      const { results } = await prep(
        `SELECT msl.manga_id, SUM(msl.chapter_count) AS total,
                MIN(CASE s.source
                  WHEN 'komiku' THEN 0
                  WHEN 'bacakomik' THEN 1
                  WHEN 'thrive' THEN 2
                  ELSE 3 END) AS src_priority
         FROM manga_source_link msl
         JOIN series s ON s.id = msl.manga_id
         WHERE msl.manga_id IN (${placeholders})
         GROUP BY msl.manga_id
         ORDER BY total DESC, src_priority ASC
         LIMIT 1`
      ).bind(...mangaIds).all<Row>();
      const row = results?.[0];
      if (!row) return null;
      const id = row.manga_id as number;
      const slugRow = await prep('SELECT slug FROM series WHERE id = ?1 LIMIT 1').bind(id).first<Row>();
      return slugRow ? { id, slug: slugRow.slug as string } : null;
    },

    // Move source links + chapters from source rows into target, then delete
    // the orphaned source rows (keeps canonical = target).
    mergeSeriesInto: async (targetMangaId, sourceMangaIds) => {
      if (!targetMangaId || !sourceMangaIds.length) return { success: false };
      const placeholders = sourceMangaIds.map(() => '?').join(',');
      const targetSlugRow = await prep('SELECT slug FROM series WHERE id = ?1 LIMIT 1').bind(targetMangaId).first<Row>();
      if (!targetSlugRow) return { success: false };
      const targetSlug = targetSlugRow.slug as string;
      // Merge alt_titles: union JSON arrays (target keeps its own, source's appended).
      const sourceRows = await prep(`SELECT id, slug, alt_titles FROM series WHERE id IN (${placeholders})`).bind(...sourceMangaIds).all<Row>();
      for (const src of sourceRows.results ?? []) {
        const { results: targetRow } = await prep('SELECT alt_titles FROM series WHERE id = ?1').bind(targetMangaId).all<Row>();
        const targetAlt: string[] = JSON.parse((targetRow?.[0]?.alt_titles as string) ?? '[]');
        const srcAlt: string[] = JSON.parse((src.alt_titles as string) ?? '[]');
        const merged = [...new Set([...targetAlt, ...srcAlt])];
        if (merged.length > 0) {
          await prep('UPDATE series SET alt_titles = ?1 WHERE id = ?2').bind(JSON.stringify(merged), targetMangaId).run();
        }
        await prep('UPDATE manga_source_link SET manga_id = ?1 WHERE manga_id = ?2').bind(targetMangaId, src.id as number).run();
        await prep('UPDATE chapters SET series_slug = ?1 WHERE series_slug = ?2').bind(targetSlug, src.slug as string).run();
        await prep('DELETE FROM series WHERE id = ?1').bind(src.id as number).run();
      }
      return { success: true };
    },

    // ── Admin monitoring (0006) ──

    listProviderAccounts: async () => {
      const { results } = await prep('SELECT * FROM provider_accounts ORDER BY updated_at DESC').all<Row>();
      return (results ?? []) as unknown as ListResult<{ id: string; provider: string; label: string; status: string; last_success_at: number | null; last_failure_at: number | null; last_error: string | null; requests_24h: number; failures_24h: number; quota_used_bytes: number | null; quota_limit_bytes: number | null; updated_at: number }>;
    },

    listScrapeJobsLog: async (p) => {
      const page = p.page ?? 1;
      const limit = p.limit ?? 20;
      const offset = (page - 1) * limit;
      const where: string[] = [];
      const args: unknown[] = [];
      if (p.source) { where.push(`source = ?${args.length + 1}`); args.push(p.source); }
      if (p.status) { where.push(`status = ?${args.length + 1}`); args.push(p.status); }
      if (p.from) { where.push(`started_at >= ?${args.length + 1}`); args.push(p.from); }
      if (p.to) { where.push(`started_at <= ?${args.length + 1}`); args.push(p.to); }
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const countRow = await prep(`SELECT COUNT(*) AS c FROM scrape_jobs_log ${clause}`).bind(...args).first<Row>();
      const total = countRow ? Number(countRow.c) : 0;
      const { results } = await prep(`SELECT * FROM scrape_jobs_log ${clause} ORDER BY started_at DESC LIMIT ?${args.length + 1} OFFSET ?${args.length + 2}`).bind(...args, limit, offset).all<Row>();
      return {
        data: (results ?? []) as unknown as Array<{ id: string; source: string; provider_account_id: string | null; status: string; items_scraped: number; duration_ms: number | null; error_message: string | null; started_at: number; finished_at: number | null }>,
        total,
        page,
      };
    },

    getDbUsageTrend: async (days = 7) => {
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const { results } = await prep('SELECT db_name, captured_at AS ts, size_bytes, rows_or_objects FROM db_usage_snapshot WHERE captured_at >= ?1 ORDER BY db_name, captured_at ASC').bind(since).all<Row>();
      const byDb = new Map<string, Array<{ ts: number; size_bytes: number | null; rows_or_objects: number | null }>>();
      for (const r of results ?? []) {
        const name = r.db_name as string;
        if (!byDb.has(name)) byDb.set(name, []);
        byDb.get(name)!.push({ ts: Number(r.captured_at), size_bytes: r.size_bytes as number | null, rows_or_objects: r.rows_or_objects as number | null });
      }
      return Array.from(byDb.entries()).map(([db_name, points]) => ({ db_name, points }));
    },

    getAdminOverview: async () => {
      const usersRow = await prep('SELECT COUNT(*) AS c FROM users').first<Row>();
      const bookmarksRow = await prep('SELECT COUNT(*) AS c FROM bookmarks').first<Row>();
      const dayAgo = Math.floor(Date.now() / 1000) - 86400;
      const successRow = await prep('SELECT COUNT(*) AS c FROM scrape_jobs_log WHERE status = ?1 AND started_at >= ?2').bind('success', dayAgo).first<Row>();
      const failedRow = await prep('SELECT COUNT(*) AS c FROM scrape_jobs_log WHERE status IN (?1, ?2) AND started_at >= ?3').bind('failed', 'partial', dayAgo).first<Row>();
      const healthyRow = await prep("SELECT COUNT(*) AS c FROM provider_accounts WHERE status = 'healthy'").first<Row>();
      const degradedRow = await prep("SELECT COUNT(*) AS c FROM provider_accounts WHERE status = 'degraded'").first<Row>();
      const downRow = await prep("SELECT COUNT(*) AS c FROM provider_accounts WHERE status = 'down'").first<Row>();
      return {
        usersTotal: Number(usersRow?.c ?? 0),
        bookmarksTotal: Number(bookmarksRow?.c ?? 0),
        scrape24h: { success: Number(successRow?.c ?? 0), failed: Number(failedRow?.c ?? 0) },
        providers: { healthy: Number(healthyRow?.c ?? 0), degraded: Number(degradedRow?.c ?? 0), down: Number(downRow?.c ?? 0) },
      };
    },

    listUsersAdmin: async (p) => {
      const page = p.page ?? 1;
      const limit = p.limit ?? 20;
      const offset = (page - 1) * limit;
      const where = p.q ? `WHERE u.email LIKE ?1 OR u.name LIKE ?1` : '';
      const like = p.q ? `%${p.q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%` : null;
      const args = where ? [like] : [];
      const countRow = await prep(`SELECT COUNT(*) AS c FROM users u ${where}`).bind(...args).first<Row>();
      const total = countRow ? Number(countRow.c) : 0;
      const { results } = await prep(
        `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
          (SELECT COUNT(*) FROM bookmarks b WHERE b.user_id = u.id) AS bookmark_count
         FROM users u ${where}
         ORDER BY u.created_at DESC LIMIT ?${args.length + 1} OFFSET ?${args.length + 2}`
      ).bind(...args, limit, offset).all<Row>();
      return {
        data: (results ?? []) as unknown as Array<{ id: number; email: string; name: string | null; role: string; status: string; created_at: number; last_login_at: number | null; bookmark_count: number }>,
        total,
        page,
      };
    },

    getUserDetail: async (id) => {
      const row = await prep(
        `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
          (SELECT COUNT(*) FROM bookmarks b WHERE b.user_id = u.id) AS bookmark_count
         FROM users u WHERE u.id = ?1 LIMIT 1`
      ).bind(id).first<Row>();
      return fromRow(row as Row | null);
    },

    listUserBookmarksAdmin: async (userId, p) => {
      const page = p.page ?? 1;
      const limit = p.limit ?? 20;
      const offset = (page - 1) * limit;
      const countRow = await prep('SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?1').bind(userId).first<Row>();
      const total = countRow ? Number(countRow.c) : 0;
      const { results } = await prep(
        `SELECT b.series_slug, s.title, s.cover_image, b.created_at AS added_at
         FROM bookmarks b LEFT JOIN series s ON s.slug = b.series_slug
         WHERE b.user_id = ?1 ORDER BY b.created_at DESC LIMIT ?2 OFFSET ?3`
      ).bind(userId, limit, offset).all<Row>();
      return {
        data: (results ?? []) as unknown as Array<{ series_slug: string; title: string | null; cover_image: string | null; added_at: number }>,
        total,
        page,
      };
    },

    getProviderHealthBuckets: async (providerAccountId, hours) => {
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      const { results } = await prep(
        'SELECT started_at, status, items_scraped, duration_ms FROM scrape_jobs_log WHERE provider_account_id = ?1 AND started_at >= ?2 ORDER BY started_at ASC'
      ).bind(providerAccountId, since).all<Row>();
      return (results ?? []) as unknown as Array<{ started_at: number; status: string; items_scraped: number; duration_ms: number | null }>;
    },

    // ── Sessions (0008) — KV-free signed-cookie auth ──
    insertSession: async (p) => {
      try {
        await prep(
          'INSERT INTO sessions (sid, user_id, created_at, expires_at, ua, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        ).bind(p.sid, p.userId, p.createdAt, p.expiresAt, p.ua ?? null, p.ip ?? null).run();
        return { success: true };
      } catch (e) {
        console.error('[insertSession] failed:', String(e));
        return { success: false };
      }
    },

    getSession: async (sid) => {
      const row = await prep(
        'SELECT sid, user_id, created_at, expires_at, revoked_at, ua, ip FROM sessions WHERE sid = ?1 LIMIT 1'
      ).bind(sid).first<Row>();
      return fromRow(row as Row | null);
    },

    revokeSession: async (sid) => {
      const res = await prep('UPDATE sessions SET revoked_at = ?1 WHERE sid = ?2 AND revoked_at IS NULL')
        .bind(Math.floor(Date.now() / 1000), sid).run();
      return { success: res.success };
    },

    listUserSessions: async (userId) => {
      const { results } = await prep(
        'SELECT sid, created_at, expires_at, revoked_at, ua FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50'
      ).bind(userId).all<Row>();
      return (results ?? []) as unknown as Array<{ sid: string; created_at: number; expires_at: number; revoked_at: number | null; ua: string | null }>;
    },

    revokeAllUserSessions: async (userId, exceptSid) => {
      const now = Math.floor(Date.now() / 1000);
      let stmt;
      if (exceptSid) {
        stmt = prep('UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND sid != ?3')
          .bind(now, userId, exceptSid);
      } else {
        stmt = prep('UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL')
          .bind(now, userId);
      }
      const res = await stmt.run();
      return { revoked: res.meta?.changes ?? 0 };
    },

    // ── chapter_pages.last_access (0009) — LRU eviction ──
    touchPageLastAccess: async (chapterId, pageNo) => {
      try {
        await prep('UPDATE chapter_pages SET last_access = ?1 WHERE chapter_id = ?2 AND page_number = ?3')
          .bind(Math.floor(Date.now() / 1000), chapterId, pageNo).run();
        return { success: true };
      } catch {
        return { success: false };
      }
    },

    listStalePages: async (accountIdx, staleBeforeTs, limit) => {
      const { results } = await prep(
        'SELECT chapter_id, page_number, r2_key, r2_account_idx, last_access FROM chapter_pages WHERE r2_account_idx = ?1 AND (last_access IS NULL OR last_access < ?2) ORDER BY last_access ASC NULLS FIRST LIMIT ?3'
      ).bind(accountIdx, staleBeforeTs, limit).all<Row>();
      return (results ?? []) as unknown as Array<{ chapter_id: string; page_number: number; r2_key: string; r2_account_idx: number; last_access: number | null }>;
    },

    clearPageStorage: async (chapterId, pageNo) => {
      try {
        await prep('UPDATE chapter_pages SET r2_key = NULL, r2_account_idx = NULL WHERE chapter_id = ?1 AND page_number = ?2')
          .bind(chapterId, pageNo).run();
        return { success: true };
      } catch {
        return { success: false };
      }
    },

    // ── Admin dashboard (0013) ──
    getUserStatusAdmin: async (id) => {
      const row = await prep('SELECT id, role, status FROM users WHERE id = ?1 LIMIT 1').bind(id).first<Row>();
      return fromRow<{ id: number; role: string; status: string }>(row);
    },

    updateUserAdmin: async (id, { status, role }) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      if (status !== undefined) { sets.push(`status = ?${args.length + 1}`); args.push(status); }
      if (role !== undefined) { sets.push(`role = ?${args.length + 1}`); args.push(role); }
      if (sets.length === 0) return { success: true };
      const res = await prep(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${args.length + 1}`)
        .bind(...args, id).run();
      return { success: res.success };
    },

    addSecurityEvent: async (p) => {
      try {
        const row = await prep(
          'INSERT INTO security_events (type, severity, message, ip, path) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id'
        ).bind(p.type, p.severity ?? 'low', p.message ?? null, p.ip ?? null, p.path ?? null).first<Row>();
        return row ? { id: Number(row.id) } : { id: 0 };
      } catch (e) {
        console.error('[addSecurityEvent] failed:', String(e));
        return { id: 0 };
      }
    },

    listSecurityEvents: async (p) => {
      const page = p.page ?? 1;
      const limit = p.limit ?? 20;
      const offset = (page - 1) * limit;
      const where = p.resolved === undefined ? '' : `WHERE resolved = ?1`;
      const args = p.resolved === undefined ? [] : [p.resolved ? 1 : 0];
      const countRow = await prep(`SELECT COUNT(*) AS c FROM security_events ${where}`).bind(...args).first<Row>();
      const total = countRow ? Number(countRow.c) : 0;
      const { results } = await prep(
        `SELECT id, type, severity, message, ip, path, resolved, created_at, resolved_at
         FROM security_events ${where} ORDER BY created_at DESC LIMIT ?${args.length + 1} OFFSET ?${args.length + 2}`
      ).bind(...args, limit, offset).all<Row>();
      return {
        data: (results ?? []) as unknown as Array<{ id: number; type: string; severity: string; message: string | null; ip: string | null; path: string | null; resolved: number; created_at: number; resolved_at: number | null }>,
        total,
        page,
      };
    },

    resolveSecurityEvent: async (id) => {
      const res = await prep('UPDATE security_events SET resolved = 1, resolved_at = ?1 WHERE id = ?2 AND resolved = 0')
        .bind(Math.floor(Date.now() / 1000), id).run();
      return { success: res.success };
    },

    getSourceHealthSummary: async () => {
      const { results } = await prep(
        `SELECT source,
           COUNT(*) AS total,
           SUM(CASE WHEN healthy = 1 THEN 1 ELSE 0 END) AS healthy,
           MAX(checked_at) AS last_checked_at,
           MAX(CASE WHEN healthy = 1 THEN checked_at END) AS last_healthy,
           MAX(CASE WHEN healthy = 0 THEN checked_at END) AS last_down
         FROM source_health GROUP BY source ORDER BY source`
      ).all<Row>();
      return (results ?? []).map((r) => {
        const total = Number(r.total ?? 0);
        const healthy = Number(r.healthy ?? 0);
        return {
          source: r.source as string,
          total,
          healthy,
          uptime_pct: total > 0 ? Math.round((healthy / total) * 1000) / 10 : null,
          last_checked_at: r.last_checked_at ? Number(r.last_checked_at) : null,
          last_healthy: r.last_healthy ? Number(r.last_healthy) : null,
          last_down: r.last_down ? Number(r.last_down) : null,
          last_error: null,
        };
      });
    },

    countScrapedChaptersBySource: async (since) => {
      const { results } = await prep(
        `SELECT m.source,
           SUM(m.chapter_count) AS chapters,
           MAX(m.last_scraped_at) AS last_scraped_at
         FROM manga_source_link m
         WHERE m.last_scraped_at >= ?1
         GROUP BY m.source`
      ).bind(since).all<Row>();
      return (results ?? []).map((r) => ({
        source: r.source as string,
        chapters: Number(r.chapters ?? 0),
        last_scraped_at: r.last_scraped_at ? Number(r.last_scraped_at) : null,
      }));
    },

    listLbUsageRange: async (fromDate, toDate) => {
      const { results } = await prep(
        'SELECT origin_url, date_key, req_count FROM lb_usage WHERE date_key >= ?1 AND date_key <= ?2 ORDER BY date_key ASC'
      ).bind(fromDate, toDate).all<Row>();
      return (results ?? []) as unknown as Array<{ origin_url: string; date_key: string; req_count: number }>;
    },

    insertUsageSnapshot: async (p) => {
      try {
        await prep(
          'INSERT INTO db_usage_snapshot (id, db_name, rows_or_objects, size_bytes, captured_at) VALUES (?1, ?2, ?3, ?4, ?5)'
        ).bind(p.dbName + ':' + (p.capturedAt ?? Math.floor(Date.now() / 1000)), p.dbName, p.rowsOrObjects ?? null, p.sizeBytes ?? null, p.capturedAt ?? Math.floor(Date.now() / 1000)).run();
        return { success: true };
      } catch (e) {
        console.error('[insertUsageSnapshot] failed:', String(e));
        return { success: false };
      }
    }
  };
};

/** `db.client` convenience: build a Db from an env binding. */
export const client = (envDb: D1Database): Db => db(envDb);
