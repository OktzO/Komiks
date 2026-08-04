import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type {
  Series,
  Chapter,
  ChapterPage,
  Bookmark,
  ReadingHistory,
  LbSettings,
  LbAccount,
  LbOrigin
} from '@manga-platform/shared/types';

export { D1Database as Database };

type Row = Record<string, unknown>;
type Result<T> = T | null;
type ListResult<T> = T[];

export interface Db {
  getSeriesBySlug: (slug: string) => Promise<Result<Series>>;
  listSeries: (params: { genre?: string; page?: number; limit?: number }) => Promise<ListResult<Series>>;
  getChapter: (chapterId: string) => Promise<Result<Chapter>>;
  listChapterPages: (chapterId: string) => Promise<ListResult<ChapterPage>>;
  searchSeries: (query: string) => Promise<ListResult<Series>>;
  createUser: (params: { email: string; name?: string | null; passwordHash: string; role?: string }) => Promise<Result<{ id: number }>>;
  getUserById: (id: number) => Promise<Result<{ id: number; email: string; name: string | null; role: string }>>;
  addBookmark: (params: { userId: number; seriesSlug: string }) => Promise<{ success: boolean }>;
  removeBookmark: (params: { userId: number; seriesSlug: string }) => Promise<{ success: boolean }>;
  listBookmarks: (userId: number) => Promise<ListResult<Series>>;
  upsertHistory: (params: { userId: number; chapterId: string; lastPage: number }) => Promise<Result<ReadingHistory>>;
  listHistory: (userId: number, limit?: number) => Promise<ListResult<Chapter>>;
  getLbSettings: () => Promise<ListResult<LbSettings>>;
  setLbSettings: (key: string, value: string) => Promise<{ success: boolean }>;
  listAccounts: () => Promise<ListResult<LbAccount>>;
  addAccount: (params: Omit<LbAccount, 'id' | 'created_at'>) => Promise<Result<{ id: number }>>;
  createOrigin: (params: Omit<LbOrigin, 'id' | 'created_at'>) => Promise<Result<{ id: number }>>;
  listOrigins: () => Promise<ListResult<LbOrigin>>;
  updateOrigin: (id: number, params: Partial<Omit<LbOrigin, 'id' | 'created_at'>>) => Promise<{ success: boolean }>;
  recordOriginHealth: (originId: number, healthy: boolean) => Promise<{ success: boolean }>;
  getOriginStatus: (originId: number) => Promise<Result<{ healthy: boolean }>>;
  addAuditLog: (params: { accountId?: number; originId?: number; action: string; userId?: number }) => Promise<{ success: boolean }>;
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

    getLbSettings: async () => {
      const { results } = await prep('SELECT key, value FROM lb_settings').all<Row>();
      return (results ?? []) as unknown as ListResult<LbSettings>;
    },

    setLbSettings: async (key, value) => {
      const res = await prep(
        'INSERT INTO lb_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2'
      ).bind(key, value).run();
      return { success: res.success };
    },

    listAccounts: async () => {
      const { results } = await prep('SELECT * FROM lb_accounts ORDER BY id').all<Row>();
      return (results ?? []) as unknown as ListResult<LbAccount>;
    },

    addAccount: async ({ name, provider, encrypted_token, token_last4, enabled = 1 }) =>
      fromRow<{ id: number }>(
        await prep(
          'INSERT INTO lb_accounts (name, provider, encrypted_token, token_last4, enabled) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id'
        ).bind(name, provider, encrypted_token, token_last4, enabled).first<Row>()
      ),

    createOrigin: async ({ name, url, enabled = 1, priority = 0, weight = 1 }) =>
      fromRow<{ id: number }>(
        await prep(
          'INSERT INTO lb_origins (name, url, enabled, priority, weight) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id'
        ).bind(name, url, enabled, priority, weight).first<Row>()
      ),

    listOrigins: async () => {
      const { results } = await prep('SELECT * FROM lb_origins ORDER BY priority DESC, id').all<Row>();
      return (results ?? []) as unknown as ListResult<LbOrigin>;
    },

    updateOrigin: async (id, params) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      for (const [k, v] of Object.entries(params)) {
        sets.push(`${k} = ?${args.length + 1}`);
        args.push(v);
      }
      if (sets.length === 0) return { success: true };
      const res = await prep(`UPDATE lb_origins SET ${sets.join(', ')} WHERE id = ?${args.length + 1}`)
        .bind(...args, id).run();
      return { success: res.success };
    },

    // append-only health record (also written by cron)
    recordOriginHealth: async (originId, healthy) => {
      const res = await prep(
        `INSERT INTO lb_audit_log (origin_id, action) VALUES (?1, ?2)`
      ).bind(originId, healthy ? 'healthy' : 'unhealthy').run();
      return { success: res.success };
    },

    getOriginStatus: async (originId) => {
      const row = await prep(
        `SELECT action FROM lb_audit_log WHERE origin_id = ?1 ORDER BY created_at DESC LIMIT 1`
      ).bind(originId).first<Row>();
      if (!row) return null;
      return { healthy: (row.action as string) === 'healthy' };
    },

    addAuditLog: async ({ accountId, originId, action, userId }) => {
      const res = await prep(
        `INSERT INTO lb_audit_log (account_id, origin_id, action, user_id) VALUES (?1, ?2, ?3, ?4)`
      ).bind(accountId ?? null, originId ?? null, action, userId ?? null).run();
      return { success: res.success };
    }
  };
};

/** `db.client` convenience: build a Db from an env binding. */
export const client = (envDb: D1Database): Db => db(envDb);
