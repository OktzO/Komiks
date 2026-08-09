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
  ScrapeJob
} from '@manga-platform/shared/types';

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
  markPageR2Uploaded: (params: { chapterId: string; pageNumber: number; imageUrl: string; r2Key: string; r2AccountIdx: number }) => Promise<{ success: boolean }>;
  touchLastAccess: (params: { r2Keys: string[]; accountIdx: number }) => Promise<{ success: boolean }>;
  incrementLbUsage: (params: { originUrl: string; dateKey: string }) => Promise<{ success: boolean }>;
  listLbUsage: (dateKey: string) => Promise<Array<{ origin_url: string; req_count: number }>>;
  searchSeries: (query: string) => Promise<ListResult<Series>>;
  createUser: (params: { email: string; name?: string | null; passwordHash: string; role?: string }) => Promise<Result<{ id: number }>>;
  getUserById: (id: number) => Promise<Result<{ id: number; email: string; name: string | null; role: string }>>;
   getUserByEmail: (email: string) => Promise<Result<{ id: number; email: string; password_hash: string | null; role: string }>>;
   updateUserProfile: (userId: number, params: { displayName?: string | null; bio?: string | null; preferences?: Record<string, unknown> }) => Promise<{ success: boolean }>;
   deleteUserAccount: (userId: number) => Promise<{ success: boolean }>;
   clearUserHistory: (userId: number) => Promise<{ success: boolean; deleted: number }>;
   clearUserBookmarks: (userId: number) => Promise<{ success: boolean; deleted: number }>;
   addBookmark: (params: { userId: number; seriesSlug: string }) => Promise<{ success: boolean }>;
  removeBookmark: (params: { userId: number; seriesSlug: string }) => Promise<{ success: boolean }>;
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
  getImageHashesByPrefix: (prefix: string) => Promise<Array<{ series_slug: string; hash: string; r2_key: string | null }>>;
  getAllImageHashes: () => Promise<Array<{ series_slug: string; hash: string; r2_key: string | null }>>;
  createScrapeJob: (params: { id: string; source: string; sourceUrl?: string | null; query?: string | null; createdBy?: number | null }) => Promise<{ id: string }>;
  updateScrapeJob: (id: string, params: { status: string; seriesSlug?: string | null; error?: string | null; completedAt?: number | null }) => Promise<{ success: boolean }>;
  getScrapeJob: (id: string) => Promise<Result<ScrapeJob>>;
  listScrapeJobs: (limit?: number) => Promise<ListResult<ScrapeJob>>;
  recordSourceHealth: (params: { source: string; healthy: boolean; latencyMs?: number | null; error?: string | null }) => Promise<{ id: number }>;
  getLatestSourceHealth: (source: string) => Promise<Result<{ source: string; healthy: boolean; latency_ms: number | null; error: string | null; checked_at: number }>>;
  upsertSourceLink: (params: { mangaId: number; source: string; sourceSlug: string; hasChapterList?: number; chapterCount?: number; lastScrapedAt?: number }) => Promise<Result<{ id: number }>>;
  getSourceLinksByManga: (mangaId: number) => Promise<Array<{ source: string; source_slug: string; chapter_count: number; has_chapter_list: number; last_scraped_at: number | null }>>;
  getMangaBySource: (source: string, sourceSlug: string) => Promise<Result<{ id: number; slug: string; title: string; source: string }>>;
  getAllSeriesTitles: () => Promise<Array<{ id: number; title: string; alt_titles: string | null }>>;
  listMergeQueue: (status?: string) => Promise<ListResult<{ id: number; source: string; source_slug: string; title: string; candidate_ids: string; confidence: number; status: string; created_at: number }>>;
  addMergeQueue: (params: { source: string; sourceSlug: string; title: string; candidateIds: number[]; confidence: number }) => Promise<Result<{ id: number }>>;
  resolveMergeQueue: (id: number, action: 'merge' | 'reject', targetMangaId?: number) => Promise<{ success: boolean }>;
  mergeSeries: (targetSlug: string, sourceSlug: string) => Promise<{ success: boolean }>;
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

    markPageR2Uploaded: async (p) => {
      await prep(`INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx`)
        .bind(p.chapterId, p.pageNumber, p.imageUrl, p.r2Key, p.r2AccountIdx).run();
      return { success: true };
    },

    touchLastAccess: async (p) => {
      const now = Date.now();
      const stmts = p.r2Keys.map((k) =>
        prep(`INSERT INTO r2_last_access (r2_key, account_idx, last_viewed, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(r2_key) DO UPDATE SET last_viewed = excluded.last_viewed, account_idx = excluded.account_idx`)
          .bind(k, p.accountIdx, now, now)
      );
      if (stmts.length > 0) await client.batch(stmts);
      return { success: true };
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

     getUserByEmail: async (email) =>
       fromRow<{ id: number; email: string; password_hash: string | null; role: string }>(
         await prep('SELECT id, email, password_hash, role FROM users WHERE email = ?1 LIMIT 1').bind(email).first<Row>()
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

     addBookmark: async ({ userId, seriesSlug }) => {
      const res = await prep('INSERT OR IGNORE INTO bookmarks (user_id, series_slug) VALUES (?1, ?2)')
        .bind(userId, seriesSlug).run();
      return { success: res.success };
    },

    removeBookmark: async ({ userId, seriesSlug }) => {
      const res = await prep('DELETE FROM bookmarks WHERE user_id = ?1 AND series_slug = ?2')
        .bind(userId, seriesSlug).run();
      return { success: res.success };
    },

    listBookmarks: async (userId) => {
      const { results } = await prep(
        `SELECT s.* FROM bookmarks b JOIN series s ON s.slug = b.series_slug
         WHERE b.user_id = ?1 ORDER BY b.created_at DESC`
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

    getImageHashesByPrefix: async (prefix) => {
      const { results } = await prep('SELECT series_slug, hash, r2_key FROM image_hashes WHERE hash LIKE ?1').bind(`${prefix}%`).all<Row>();
      return (results ?? []) as unknown as Array<{ series_slug: string; hash: string; r2_key: string | null }>;
    },

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

    recordSourceHealth: async (p) =>
      (await prep('INSERT INTO source_health (source, healthy, latency_ms, error) VALUES (?1, ?2, ?3, ?4) RETURNING id')
        .bind(p.source, p.healthy ? 1 : 0, p.latencyMs ?? null, p.error ?? null).first<Row>()) as { id: number },

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
    }
  };
};

/** `db.client` convenience: build a Db from an env binding. */
export const client = (envDb: D1Database): Db => db(envDb);
