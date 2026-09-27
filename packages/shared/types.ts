import { z } from 'zod';

// Shared domain schemas (single source of truth across worker API + frontend)
// Mirrors packages/db/schema.sql. Row types derive via z.infer.

// ---- primitives / reusable enums -----------------------------------------
export const SeriesType = z.enum(['manga', 'manhwa', 'manhua']);
// 'unknown' = sumber tidak punya info status → UI render '-'. DB CHECK series.status
// tidak menerima 'unknown' — upsertSeries men-sanitize → 'ongoing' saat persist.
export const SeriesStatus = z.enum(['ongoing', 'completed', 'hiatus', 'cancelled', 'unknown']);
export const UserRole = z.enum(['user', 'admin']);
export const LbProvider = z.enum(['cloudflare', 'vercel']);

export type SeriesType = z.infer<typeof SeriesType>;
export type SeriesStatus = z.infer<typeof SeriesStatus>;
export type UserRole = z.infer<typeof UserRole>;
export type LbProvider = z.infer<typeof LbProvider>;

// ---- Series ---------------------------------------------------------------
export const SeriesSchema = z.object({
  id: z.number().int().positive().optional(),
  slug: z.string().min(1),
  external_id: z.string().nullable().optional(),
  source: z.string().default('komiku'),
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

// ---- Load balancing settings (single row, id = 1) --------------------------
export const LbSettingsSchema = z.object({
  id: z.number().int().optional(),
  mode: z.enum(['off', 'on']).default('off'),
  implementation: z.enum(['native_cf', 'custom']).default('custom'),
  steering_policy: z.string().default('failover'),
  health_check_interval_sec: z.number().int().default(30),
  health_check_timeout_ms: z.number().int().default(3000),
  failure_threshold: z.number().int().default(2)
});
export type LbSettings = z.infer<typeof LbSettingsSchema>;

// ---- Load balancing accounts (internal; contains the token BLOB) -----------
export const LbAccountSchema = z.object({
  id: z.string().min(1),
  provider: LbProvider,
  label: z.string().min(1),
  account_ref: z.string().nullable().optional(),
  encrypted_token: z.instanceof(ArrayBuffer).or(z.instanceof(Uint8Array)),
  token_last4: z.string().length(4),
  status: z.enum(['verified', 'unverified', 'failed']).default('unverified'),
  last_tested_at: z.number().int().nullable().optional(),
  created_by: z.number().int().positive().nullable().optional(),
  created_at: z.number().int().optional()
});
export type LbAccount = z.infer<typeof LbAccountSchema>;

// Public account view returned to the frontend (token omitted).
export const LbAccountSafeSchema = LbAccountSchema.omit({ encrypted_token: true });
export type LbAccountSafe = z.infer<typeof LbAccountSafeSchema>;

// ---- Load balancing origins ------------------------------------------------
export const LbOriginSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().nullable().optional(),
  origin_url: z.string().url(),
  priority: z.number().int().default(0),
  weight: z.number().int().positive().default(1),
  enabled: z.number().int().min(0).max(1).default(1),
  last_health_status: z.string().nullable().optional(),
  last_checked_at: z.number().int().nullable().optional(),
  created_at: z.number().int().optional()
});
export type LbOrigin = z.infer<typeof LbOriginSchema>;

export const ResourceStatus = z.enum(['ok', 'degraded', 'unavailable']);
export type ResourceStatus = z.infer<typeof ResourceStatus>;

export const ResourceSource = z.enum(['live', 'local', 'tracked', 'derived', 'unavailable']);
export type ResourceSource = z.infer<typeof ResourceSource>;

export const ResourceStateSchema = z.object({
  status: ResourceStatus,
  source: ResourceSource,
  observedAt: z.number().int().nullable(),
  errorCode: z.string().nullable(),
});
export type ResourceState = z.infer<typeof ResourceStateSchema>;

export const PeerInventorySchema = z.object({
  topologyHash: z.string().min(1),
  self: z.boolean(),
  account: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    type: z.string().nullable(),
    state: ResourceStateSchema,
  }),
  worker: z.object({
    name: z.string().nullable(),
    createdAt: z.string().nullable(),
    modifiedAt: z.string().nullable(),
    state: ResourceStateSchema,
  }),
  d1: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    fileBytes: z.number().int().nonnegative().nullable(),
    jurisdiction: z.string().nullable(),
    region: z.string().nullable(),
    counts: z.object({
      series: z.number().int().nonnegative().nullable(),
      chapters: z.number().int().nonnegative().nullable(),
      chapterPages: z.number().int().nonnegative().nullable(),
      users: z.number().int().nonnegative().nullable(),
      bookmarks: z.number().int().nonnegative().nullable(),
    }),
    state: ResourceStateSchema,
  }),
  kv: z.object({
    id: z.string().nullable(),
    title: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    keyCount: z.number().int().nonnegative().nullable(),
    byteCount: z.number().int().nonnegative().nullable(),
    operationalD1Bytes: z.number().int().nonnegative().nullable(),
    state: ResourceStateSchema,
  }),
  lb: z.object({
    account: LbAccountSafeSchema.pick({
      id: true,
      provider: true,
      label: true,
      account_ref: true,
      status: true,
      last_tested_at: true,
      created_at: true,
    }).nullable(),
    origins: z.array(LbOriginSchema),
  }),
});
export type PeerInventory = z.infer<typeof PeerInventorySchema>;

export const InventoryWarningSchema = z.object({
  code: z.string().min(1),
  peerUrl: z.string().url().nullable(),
  message: z.string().min(1),
  observedAt: z.number().int(),
});
export type InventoryWarning = z.infer<typeof InventoryWarningSchema>;

export const InventoryB2AccountSchema = z.object({
  configuredName: z.string().min(1),
  providerAccountId: z.string().nullable(),
  bucketId: z.string().nullable(),
  bucketName: z.string().nullable(),
  bucketType: z.string().nullable(),
  options: z.array(z.string()),
  trackedBytes: z.number().int().nonnegative().nullable(),
  trackedUpdatedAt: z.number().int().nullable(),
  quotaBytes: z.number().int().positive(),
  state: ResourceStateSchema,
});
export type InventoryB2Account = z.infer<typeof InventoryB2AccountSchema>;

export const InventoryRegistrationSchema = z.object({
  account: LbAccountSafeSchema.pick({
    id: true,
    provider: true,
    label: true,
    account_ref: true,
    status: true,
    last_tested_at: true,
    created_at: true,
  }),
  origin: LbOriginSchema.nullable(),
  topologyStatus: z.enum(['registered', 'pending_topology']),
});
export type InventoryRegistration = z.infer<typeof InventoryRegistrationSchema>;

export const AdminInventorySchema = z.object({
  observedAt: z.number().int(),
  stale: z.boolean(),
  topology: z.object({
    source: z.literal('PEER_URLS'),
    count: z.number().int().nonnegative(),
    hash: z.string().min(1),
    consistent: z.boolean(),
  }),
  accounts: z.array(z.object({
    topologyHash: z.string().min(1),
    index: z.number().int().nonnegative(),
    url: z.string().url(),
    self: z.boolean(),
    reachable: z.boolean(),
    account: PeerInventorySchema.shape.account,
    worker: PeerInventorySchema.shape.worker,
    d1: PeerInventorySchema.shape.d1,
    kv: PeerInventorySchema.shape.kv,
    lb: PeerInventorySchema.shape.lb,
  })),
  registrations: z.array(InventoryRegistrationSchema),
  b2: z.array(InventoryB2AccountSchema),
  warnings: z.array(InventoryWarningSchema),
});
export type AdminInventory = z.infer<typeof AdminInventorySchema>;

// ---- Load balancing audit log ----------------------------------------------
export const LbAuditLogSchema = z.object({
  id: z.number().int().positive().optional(),
  account_id: z.string().nullable().optional(),
  origin_id: z.string().nullable().optional(),
  action: z.string().min(1),
  user_id: z.number().int().positive().nullable().optional(),
  created_at: z.number().int().optional()
});
export type LbAuditLog = z.infer<typeof LbAuditLogSchema>;

// ---- Convenience: JSON-array parsing for genres/tags -----------------------
export const JsonStringArraySchema = z
  .string()
  .optional()
  .transform((s) => (s ? JSON.parse(s) as string[] : undefined))
  .pipe(z.array(z.string()).optional());

// ---- Manga Data API types --------------------------------------------------

export const ScrapeResultSchema = z.object({
  series: SeriesSchema,
  chapters: z.array(ChapterSchema),
  coverImageUrl: z.string().nullable()
});
export type ScrapeResult = z.infer<typeof ScrapeResultSchema>;

export const RobotsResultSchema = z.object({
  allowed: z.boolean(),
  disallowedPaths: z.array(z.string()),
  crawlDelay: z.number().nullable().optional()
});
export type RobotsResult = z.infer<typeof RobotsResultSchema>;

export const SourceHealthSchema = z.object({
  source: z.string(),
  healthy: z.boolean(),
  latency_ms: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  last_checked_at: z.number().optional()
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const ScrapeJobSchema = z.object({
  id: z.string(),
  source: z.string(),
  source_url: z.string().nullable().optional(),
  query: z.string().nullable().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped_robots']),
  series_slug: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  created_by: z.number().int().nullable().optional(),
  created_at: z.number().int().optional(),
  completed_at: z.number().int().nullable().optional()
});
export type ScrapeJob = z.infer<typeof ScrapeJobSchema>;

export const ImageHashRowSchema = z.object({
  id: z.number().int().optional(),
  series_slug: z.string(),
  hash: z.string(),
  r2_key: z.string().nullable().optional(),
  image_type: z.enum(['cover', 'page']),
  created_at: z.number().int().optional()
});
export type ImageHashRow = z.infer<typeof ImageHashRowSchema>;

// ---- Manga aggregation (multi-source) --------------------------------------
export const SourceLinkSchema = z.object({
  id: z.number().int().optional(),
  manga_id: z.number().int(),
  source: z.string(),
  source_slug: z.string(),
  has_chapter_list: z.number().int().min(0).max(1).default(1),
  chapter_count: z.number().int().default(0),
  last_scraped_at: z.number().int().nullable().optional()
});
export type SourceLink = z.infer<typeof SourceLinkSchema>;

export const MergeQueueItemSchema = z.object({
  id: z.number().int(),
  source: z.string(),
  source_slug: z.string(),
  title: z.string(),
  candidate_ids: z.string(), // JSON array string of series.id
  confidence: z.number(),
  status: z.enum(['pending', 'merged', 'rejected']),
  created_at: z.number().int()
});
export type MergeQueueItem = z.infer<typeof MergeQueueItemSchema>;

// ---- User profile (Task 3: plain types, no Zod schema) ----------------------

export type UserSource = 'komiku' | 'bacakomik' | 'thrive' | 'manhwaindo' | 'shinigami';

export type UserPreferences = {
  theme: 'dark' | 'light' | 'system';
  language: 'id' | 'en';
  reader_mode: 'scroll' | 'page';
  default_source: UserSource | null;
};

export type MeResponse = {
  id: number;
  email: string;
  name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  preferences: UserPreferences;
  role: UserRole;
  created_at: number;
};

export type SessionMeta = {
  token: string;
  createdAt: number;
  lastSeen: number;
  ua: string;
};
