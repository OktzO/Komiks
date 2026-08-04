import { z } from 'zod';

// Shared domain schemas (single source of truth across worker API + frontend)
// Mirrors packages/db/schema.sql. Row types derive via z.infer.

// ---- primitives / reusable enums -----------------------------------------
export const SeriesType = z.enum(['manga', 'manhwa', 'manhua']);
export const SeriesStatus = z.enum(['ongoing', 'completed', 'hiatus', 'cancelled']);
export const UserRole = z.enum(['user', 'admin']);
export const LbProvider = z.enum(['cloudflare', 'vercel', 'custom']);

export type SeriesType = z.infer<typeof SeriesType>;
export type SeriesStatus = z.infer<typeof SeriesStatus>;
export type UserRole = z.infer<typeof UserRole>;
export type LbProvider = z.infer<typeof LbProvider>;

// ---- Series ---------------------------------------------------------------
export const SeriesSchema = z.object({
  id: z.number().int().positive().optional(),
  slug: z.string().min(1),
  external_id: z.string().nullable().optional(),
  source: z.string().default('mangadex'),
  title: z.string().min(1),
  synopsis: z.string().nullable().optional(),
  type: SeriesType,
  status: SeriesStatus,
  author: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  cover_image: z.string().nullable().optional(),
  genres: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional()
});
export type Series = z.infer<typeof SeriesSchema>;

// ---- Chapter --------------------------------------------------------------
export const ChapterSchema = z.object({
  id: z.string().min(1),
  series_slug: z.string().min(1),
  chapter_number: z.number().nonnegative(), // REAL, allows 0.5
  volume: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  language: z.string().default('en'),
  pages_count: z.number().int().nonnegative().default(0),
  published_at: z.number().int().nullable().optional(),
  created_at: z.number().int().optional()
});
export type Chapter = z.infer<typeof ChapterSchema>;

// ---- ChapterPage ----------------------------------------------------------
export const ChapterPageSchema = z.object({
  id: z.number().int().positive().optional(),
  chapter_id: z.string().min(1),
  page_number: z.number().int().positive(),
  image_url: z.string().url()
});
export type ChapterPage = z.infer<typeof ChapterPageSchema>;
export type Bookmark = z.infer<typeof BookmarkSchema>;

// ---- User -----------------------------------------------------------------
export const UserSchema = z.object({
  id: z.number().int().positive().optional(),
  email: z.string().email(),
  name: z.string().nullable().optional(),
  password_hash: z.string().nullable().optional(),
  role: UserRole.default('user'),
  created_at: z.number().int().optional()
});

// ---- Bookmark -------------------------------------------------------------
export const BookmarkSchema = z.object({
  user_id: z.number().int().positive(),
  series_slug: z.string().min(1),
  created_at: z.number().int().optional()
});// ---- ReadingHistory -------------------------------------------------------
export const ReadingHistorySchema = z.object({
  user_id: z.number().int().positive(),
  chapter_id: z.string().min(1),
  last_page: z.number().int().nonnegative().default(0),
  updated_at: z.number().int().optional()
});
export type ReadingHistory = z.infer<typeof ReadingHistorySchema>;

// ---- Load balancing settings ---------------------------------------------
export const LbSettingsSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1)
});
export type LbSettings = z.infer<typeof LbSettingsSchema>;

// ---- Load balancing accounts ----------------------------------------------
export const LbAccountSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  provider: LbProvider,
  encrypted_token: z.string().min(1),
  token_last4: z.string().length(4),
  enabled: z.number().int().min(0).max(1).default(1),
  created_at: z.number().int().optional()
});
export type LbAccount = z.infer<typeof LbAccountSchema>;

// ---- Load balancing origins -----------------------------------------------
export const LbOriginSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  url: z.string().url(),
  enabled: z.number().int().min(0).max(1).default(1),
  priority: z.number().int().default(0),
  weight: z.number().int().positive().default(1),
  created_at: z.number().int().optional()
});
export type LbOrigin = z.infer<typeof LbOriginSchema>;

// ---- Convenience: JSON-array parsing for genres/tags -----------------------
export const JsonStringArraySchema = z
  .string()
  .optional()
  .transform((s) => (s ? JSON.parse(s) as string[] : undefined))
  .pipe(z.array(z.string()).optional());
