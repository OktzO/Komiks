# User Profile + Admin-Only Load Balancing Menu — Design Spec

**Date:** 2026-08-09
**Status:** Approved
**Scope:** Frontend `/profile` page, D1 user-profile columns, Worker `/api/user/*` routes, hamburger restructure, LB admin route rename

---

## Context

User profile & settings saat ini tidak ada. User hanya punya 4 link di hamburger (`Cari`, `Bookmark`, `Riwayat`, `Status`) + `Masuk`/`Keluar`. Tidak ada cara user untuk: edit display name / bio, atur preferensi (theme, bahasa, reader mode, default source), kelola sesi aktif di device lain, hapus data pribadi.

Load Balancing admin saat ini route terpisah (`/admin/settings/load-balancing`) — berdiri sendiri, tidak ada link dari hamburger. Hanya admin yang tau URL.

**Problems:**
1. Tidak ada profile UI — user yang login tidak bisa customize apa-apa.
2. Privacy: tidak ada cara lihat device yang sedang login atau logout jarak jauh.
3. Tidak ada cara hapus akun / hapus data pribadi (GDPR-ish).
4. LB admin route terpisah — user harus tau URL, tidak discoverable dari UI.
5. Admin (`oktzoffc@gmail.com`) punya 2 cara masuk (Google OAuth atau step-up password) tapi tidak jelas kapan pakai yang mana.

**User requirements (2026-08-09):**
1. Pindahkan pengaturan LB yang awalnya terpisah (`/admin/settings/load-balancing`) jadi 1 dengan akun admin utama (`oktzoffc@gmail.com`), tempatkan di hamburger menu entry "Load Balancing" (admin only).
2. Buat tampilan User Profile + Settings lengkap seperti web/app pada umumnya: profile (avatar, display name, bio), preferensi (theme, bahasa, default reader mode), privasi (bookmark/history visibility, hapus data), sesi aktif (device login, logout semua).
3. Login: hanya Google OAuth (sudah ada).
4. Single page `/profile` dengan section + sidebar anchor (mobile: top tabs).

---

## 1. Decisions (klarifikasi 2026-08-09)

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Login method | Hanya Google OAuth (existing). Tidak ada password manual. |
| 2 | Profile scope | Profile (avatar, display name, bio) + Preferences (theme, bahasa, default reader mode, default source) + Privacy (bookmark/history visibility, hapus data) + Sessions (device login, logout semua). |
| 3 | Page split | 1 halaman `/profile` dengan anchor sidebar (mobile: top tabs). |
| 4 | Avatar source | Pakai Google picture, simpan di kolom `users.avatar_url`. Backfill = NULL (fallback initial). |
| 5 | LB entry position | Route dedicated `/admin/load-balancing`, hamburger entry "Load Balancing" admin only. Tidak digabung ke /profile. |

---

## 2. Arsitektur & Routing

### Hapus / rename route

| Path | Aksi | Alasan |
|---|---|---|
| `/admin/settings/load-balancing` | **Hapus** | Rename ke `/admin/load-balancing`. |
| `/admin/settings` | Redirect → `/admin/load-balancing` (Next.js `redirect()` di page, atau `next.config.mjs` `redirects()`) | Backward-compat kalau ada link lama. |
| `apps/web/app/admin/settings/` (folder) | **Hapus** setelah kosong | Tidak ada page lain di situ. |

### Tambah route baru

| Path | Tipe | Catatan |
|---|---|---|
| `/profile` | Client page | Single-page, scroll-anchor, 5 section + 1 admin-only. |
| `/admin/load-balancing` | Client page (rename dari `/admin/settings/load-balancing`) | Page.tsx dipindah, heading internal diubah dari "Admin Load Balancing" → "Load Balancing". Logic identik. |

### Hamburger restructure (`Navbar.tsx`)

**Admin view (`role === 'admin'`):**
```
Cari
Bookmark
Riwayat
Status
─────
Load Balancing    ← /admin/load-balancing
Profile           ← /profile
Keluar
```

**User view:**
```
Cari
Bookmark
Riwayat
Status
─────
Profile           ← /profile
Keluar
```

**Non-login view (tidak ada perubahan):**
```
Cari
Bookmark
Riwayat
Status
─────
Masuk
```

Entry "Load Balancing" di-hide kalau `user?.role !== 'admin'`. Pakai helper `isAdmin = user?.role === 'admin'`.

---

## 3. Database Schema — Migration `0005_user_profile.sql`

**Incremental migration (tidak edit `schema.sql`).**

```sql
-- 0005_user_profile.sql
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_url   TEXT;
ALTER TABLE users ADD COLUMN bio          TEXT;
ALTER TABLE users ADD COLUMN preferences  TEXT NOT NULL DEFAULT '{}';
```

**Kolom baru `users`:**

| Kolom | Tipe | Default | Editable | Catatan |
|---|---|---|---|---|
| `display_name` | TEXT | NULL | ya | Nama tampil, beda dari `name` Google. Max 50 char (enforced di API). |
| `avatar_url` | TEXT | NULL | tidak | Diset saat OAuth callback dari `gUser.picture`. Backfill existing user = NULL (fallback initial). |
| `bio` | TEXT | NULL | ya | Bio singkat, max 280 char (enforced). |
| `preferences` | TEXT (JSON) | `'{}'` | ya | Lihat struktur di bawah. |

**`preferences` JSON shape:**
```ts
{
  theme: 'dark' | 'light' | 'system';          // default 'dark'
  language: 'id' | 'en';                        // default 'id'
  reader_mode: 'scroll' | 'page';               // default 'scroll'
  default_source: 'komiku' | 'bacakomik' | 'thrive' | 'manhwaindo' | null;  // default null
}
```

**Kolom `name` tetap immutable** (dari Google) — jadi fallback kalau `display_name` NULL.

### D1 helper baru (`packages/db/index.ts`)

Tambah ke interface `Db`:

```ts
updateUserProfile: (userId: number, params: {
  displayName?: string | null;
  bio?: string | null;
  preferences?: Record<string, unknown>;
}) => Promise<{ success: boolean }>;

deleteUserAccount: (userId: number) => Promise<{ success: boolean }>;
clearUserHistory: (userId: number) => Promise<{ success: boolean; deleted: number }>;
clearUserBookmarks: (userId: number) => Promise<{ success: boolean; deleted: number }>;
```

**`updateUserProfile`** — UPDATE partial dengan COALESCE (NULL = keep existing).
**`deleteUserAccount`** — `DELETE FROM users WHERE id = ?` (cascade FK hapus bookmarks + history otomatis).
**`clearUserHistory` / `clearUserBookmarks`** — DELETE WHERE user_id = ?, return row count.

### Session index di KV (Worker only, bukan D1)

Tambah secondary key saat `createSession`:

```
session:{token}                  -> {userId, createdAt, ua, ip}     TTL 7d  (existing)
session-user:{userId}:{token}    -> {token, createdAt, ua, ip}      TTL 7d  (new)
```

Update `apps/api-cf/src/lib/auth.ts`:
- `createSession` → put dua-duanya (idempotent).
- `getSessionUser` valid → fire-and-forget PUT `session-user:{userId}:{token}` dengan `lastSeen` (extend TTL).

Route `/api/user/sessions` → `c.env.CACHE_KV.list({prefix: 'session-user:{userId}:'})` → parse.

---

## 4. Worker API Routes (`/api/user/*`)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/api/user/me` | session | — | `MeResponse` (lihat bawah) |
| PATCH | `/api/user/me` | session | `{display_name?, bio?, preferences?}` (Zod validated) | `MeResponse` updated |
| DELETE | `/api/user/me` | session | `{confirm:'DELETE'}` | `{ok:true}` + clear session cookie |
| GET | `/api/user/sessions` | session | — | `{sessions: SessionMeta[], current: string}` |
| DELETE | `/api/user/sessions/:token` | session | — | `{ok}` / 404 kalau token bukan punya user |
| POST | `/api/user/sessions/revoke-all` | session | — | `{ok, revoked: number}` |
| DELETE | `/api/user/history` | session | — | `{ok, deleted: number}` |
| DELETE | `/api/user/bookmarks` | session | — | `{ok, deleted: number}` |

### Type definitions (`packages/shared/types.ts`)

```ts
export type UserPreferences = {
  theme: 'dark' | 'light' | 'system';
  language: 'id' | 'en';
  reader_mode: 'scroll' | 'page';
  default_source: 'komiku' | 'bacakomik' | 'thrive' | 'manhwaindo' | null;
};

export type MeResponse = {
  id: number;
  email: string;
  name: string | null;             // Google, immutable
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  preferences: UserPreferences;
  role: 'user' | 'admin';
  created_at: number;
};

export type SessionMeta = {
  token: string;
  createdAt: number;
  lastSeen: number;
  ua: string;
};
```

### Validation (Zod)

- `display_name`: string|null, max 50, normalize empty → null.
- `bio`: string|null, max 280.
- `preferences`: object dengan 4 field sesuai `UserPreferences` shape (semua optional di PATCH).
- PATCH body schema: `z.object({...}).strict()` — reject unknown field.

### Auth flow

- `GET /me` (existing) → extend return ke `MeResponse`. Existing front-end consumer (`fetchMe`) akan break — update `lib/api.ts` `AuthUser` interface.
- PATCH/DELETE/sessions/history/bookmarks → `requireSession` middleware (pakai `getSessionUser`, kalau null → 401).
- OAuth callback (`/api/auth/google/callback`) — UPDATE tambahkan `avatar_url = gUser.picture ?? NULL`. INSERT user baru juga simpan picture.

### LB admin route — tidak ada perubahan Worker

`/api/admin/lb/*` tetap. Auth check `requireAdmin` (session role=admin ATAU step-up header) tidak berubah. Hanya frontend page pindah.

---

## 5. Frontend — `/profile` page

### Layout

**Desktop (md+):** 2 kolom.
- Sidebar kiri 200px sticky: list anchor ke section.
- Konten kanan max-width 720px: section cards.

**Mobile (<md):** sticky horizontal tabs di atas konten (same pattern as reader top bar — `position:sticky top-{navheight}`). Sidebar hidden.

### Section list (anchor)

1. **`#profile`** — Profil Publik
   - Avatar (Google picture atau initial fallback 64px circle).
   - Display name (input text, max 50 char, char counter).
   - Bio (textarea, max 280 char, char counter).
   - "Simpan" button.

2. **`#account`** — Akun
   - Email (read-only input, dengan icon "verified" dari Google).
   - Name (read-only, label "Nama Google").
   - Tombol "Hapus akun" di danger zone → confirm modal `{type DELETE to confirm}`.

3. **`#preferences`** — Preferensi
   - Theme: segmented control (Dark / Light / System).
   - Bahasa UI: segmented (ID / EN).
   - Reader mode default: segmented (Scroll / Page).
   - Default source: dropdown 4 source + "Auto".
   - "Simpan" button.

4. **`#privacy`** — Privasi
   - Bookmark visibility: toggle private/public (placeholder — future feature).
   - History visibility: toggle private/public (placeholder).
   - "Hapus semua bookmark" → confirm modal.
   - "Hapus semua history" → confirm modal.

5. **`#sessions`** — Sesi Aktif
   - Daftar device: device label (parsed dari UA — "Chrome di macOS", "Safari di iPhone"), "Ini perangkat kamu" badge pada current, last seen relative ("2 jam lalu").
   - Per-row "Logout sesi ini" (disabled untuk current).
   - "Logout semua sesi lain" sticky button.

6. **`#admin`** — Admin (hanya render kalau `user?.role === 'admin'`)
   - Info card: "Pengaturan Load Balancing ada di menu → Load Balancing".
   - Link "Buka Load Balancing" → `/admin/load-balancing`.
   - (Tidak ada kontrol di sini.)

### Komponen (`apps/web/components/profile/`)

| File | Tanggung jawab |
|---|---|
| `Sidebar.tsx` | Desktop sticky sidebar anchor list. Active state via IntersectionObserver. |
| `MobileTabs.tsx` | Mobile sticky horizontal tabs. Scroll horizontal ke section on tap. |
| `ProfileSection.tsx` | Section 1 form. |
| `AccountSection.tsx` | Section 2 read-only fields + danger zone. |
| `PreferencesSection.tsx` | Section 3 form. |
| `PrivacySection.tsx` | Section 4 toggles + danger. |
| `SessionsSection.tsx` | Section 5 list + revoke. |
| `AdminSection.tsx` | Section 6 info link. |
| `Avatar.tsx` | Shared, render picture atau initial circle (size variant). |
| `ConfirmModal.tsx` | Reusable confirm dialog (untuk hapus akun / hapus data). |

### Visual style

- Pakai OKLCH dark palette existing. Tidak tambah warna baru.
- Section header: `text-lg font-medium text-primary`.
- Section card: `bg-card border border-subtle rounded-2xl p-5 sm:p-6`.
- Form input: `bg-base border border-border-default rounded-lg px-3 py-2`.
- Segmented control: 3 button group, active state `bg-bg-secondary text-primary`.
- Danger button: `text-error border border-error/30 hover:bg-error/10`.
- Sticky save bar mobile: `fixed bottom-0 inset-x-0 bg-glass-surface backdrop-blur border-t border-subtle p-3`.
- Anchor `scroll-margin-top: 80px` (di `globals.css`) supaya tidak tertutup nav-island saat scroll.

### `/admin/load-balancing` page (rename)

1. Move file `apps/web/app/admin/settings/load-balancing/page.tsx` → `apps/web/app/admin/load-balancing/page.tsx`.
2. Heading internal `<h1>Admin Load Balancing</h1>` → `<h1>Load Balancing</h1>`.
3. Auth flow tetap (step-up password ATAU session admin). Karena admin login via Google OAuth (`role=admin` di session) → step-up tidak perlu. Step-up hanya fallback legacy.
4. Tambah `apps/web/app/admin/settings/page.tsx`:
   ```tsx
   import { redirect } from 'next/navigation';
   export default function AdminSettingsRedirect() { redirect('/admin/load-balancing'); }
   ```
5. Tambah hamburger entry "Load Balancing" di `Navbar.tsx` (admin only).

### Frontend API client updates (`apps/web/lib/api.ts`)

- `AuthUser` interface → extend dengan field profile lengkap (matching `MeResponse`):
  ```ts
  interface AuthUser {
    id: number; email: string; role: string;
    name: string | null; display_name: string | null;
    avatar_url: string | null; bio: string | null;
    preferences: UserPreferences;
    created_at: number;
  }
  ```
- Tambah helpers:
  ```ts
  patchMe(patch: Partial<MeResponse>): Promise<MeResponse>
  deleteMe(confirm: string): Promise<void>
  listSessions(): Promise<{sessions: SessionMeta[], current: string}>
  revokeSession(token: string): Promise<void>
  revokeAllSessions(): Promise<{revoked: number}>
  clearHistory(): Promise<{deleted: number}>
  clearBookmarks(): Promise<{deleted: number}>
  ```

---

## 6. Error Handling & Edge Cases

| Skenario | Backend | UI |
|---|---|---|
| PATCH validation fail (bio > 280) | 400 `{error, field}` | Inline error di field. |
| PATCH network timeout | — | Toast "Gagal menyimpan. Coba lagi." |
| DELETE /me confirm salah | 400 `{error:'type DELETE to confirm'}` | Inline error di modal. |
| Sessions KV `list()` empty | 200 `{sessions:[]}` | Empty state "Tidak ada sesi lain". |
| Revoke token bukan punya user | 404 `{error:'not found'}` | Toast "Sesi tidak ditemukan". |
| Revoke current token | 410 `{error:'cannot revoke current'}` | Disabled button di current row. |
| Preferences JSON invalid | 400 (Zod) | Reset field ke previous value. |
| Email tidak di admin list | `role='user'` | Hamburger hide LB entry. |
| Klik `/admin/load-balancing` tanpa login | — | Page redirect ke `/login`. |
| Klik `/admin/load-balancing` non-admin | — | Page render "403 — bukan admin" + tombol "Masuk dengan akun admin". |
| `display_name` empty string | Backend normalize → NULL | UI show "kosongkan" hint. |
| Two-tab edit conflict | Last-write-wins | Tiap save fetch /me ulang. |
| Logout dari tab lain saat edit | Fetch 401 → force redirect `/login`. |

**Edge case OAuth:**
- User revoke Google app access → next login gagal, existing KV sessions valid sampai 7d. Re-login ambil alih role.

---

## 7. Testing

### Unit (D1 helpers)

**`packages/db/test/user-profile.test.mjs`** (tambah):
- `updateUserProfile` — update display_name + bio + preferences (JSON roundtrip).
- `deleteUserAccount` — cascade hapus bookmark + history.
- `clearUserHistory`, `clearUserBookmarks` — row count correct.
- Existing-user tanpa field baru (pre-migration) — PATCH insert NULL → no crash.

### Worker route smoke

**`scripts/smoke-user.mjs`** (tambah):
- Mock session (set cookie manual) → `GET /me` → expect field lengkap.
- `PATCH /me` dengan body invalid → 400.
- `PATCH /me` valid → field persist.
- `GET /sessions` → ada current token.
- `DELETE /sessions/:otherToken` → 200; `GET /sessions` → exclude.
- `DELETE /me` dengan confirm salah → 400; confirm benar → 200.

### E2E manual checklist

- [ ] Login `oktzoffc@gmail.com` → hamburger tampil entry "Load Balancing".
- [ ] Login user lain → hamburger tidak tampil entry "Load Balancing".
- [ ] `/profile` load → 5 section render + section "Admin" hanya untuk admin.
- [ ] `/profile` scroll ke `#sessions` via anchor → sidebar active sync.
- [ ] Save preference `theme:light` → reload page → nilai persist.
- [ ] Save display_name → tampil di navbar avatar / initial.
- [ ] Buka 2 tab login → revoke sesi di tab 1 → tab 2 next request redirect `/login`.
- [ ] Hapus semua history → `GET /api/user/history` return empty.
- [ ] Hapus akun → confirm modal → next request 401.
- [ ] `/admin/settings/load-balancing` (URL lama) → redirect ke `/admin/load-balancing`.

---

## 8. Migration Runbook

```bash
# Main D1 (akun 1)
npx wrangler d1 execute manga-db --remote \
  --file=packages/db/migrations/0005_user_profile.sql

# Akun 2 (LB origin)
CLOUDFLARE_ACCOUNT_ID=6a0bdfb8bccff744bd738a57502d0380 \
  npx wrangler d1 execute manga-db --remote \
  --file=packages/db/migrations/0005_user_profile.sql

# Local D1 (dev)
cd apps/api-cf && npx wrangler d1 execute manga-db --local \
  --file=packages/db/migrations/0005_user_profile.sql
```

Deploy order:
1. Apply migration (idempotent — ALTER TABLE ADD COLUMN kalau belum ada no-op).
2. Deploy Worker (route baru aktif).
3. Deploy Frontend (page baru + hamburger update).

Rollback: Worker routes bisa dimatikan tanpa hapus kolom (frontend tidak pakai). Kolom DB inert (NULL → ignored).

---

## 9. File-by-file Change Map

| File | Aksi |
|---|---|
| `packages/db/migrations/0005_user_profile.sql` | NEW (ALTER + seed LB 2 akun + 2 origin) |
| `packages/db/migrations/0006_lb_seed.sql` | NEW (alternative — split seed ke file terpisah) |
| `apps/api-cf/src/lib/lbAccounts.ts` atau routes/admin/lb.ts | Handle empty blob `encrypted_token` (skip decrypt untuk seeded akun) |
| `packages/db/index.ts` | Add 4 helpers (updateUserProfile, deleteUserAccount, clearUserHistory, clearUserBookmarks) |
| `packages/db/test/user-profile.test.mjs` | NEW |
| `packages/shared/types.ts` | Add UserPreferences, MeResponse, SessionMeta types |
| `apps/api-cf/src/lib/auth.ts` | Extend createSession + getSessionUser untuk `session-user:*` key |
| `apps/api-cf/src/routes/auth.ts` | OAuth callback: save `avatar_url = gUser.picture` |
| `apps/api-cf/src/routes/user.ts` | NEW (atau extend existing) — tambah 7 route baru |
| `apps/api-cf/src/index.ts` | Mount route user baru |
| `apps/web/app/admin/settings/load-balancing/page.tsx` | DELETE |
| `apps/web/app/admin/settings/page.tsx` | NEW — redirect |
| `apps/web/app/admin/load-balancing/page.tsx` | NEW (move + rename heading) |
| `apps/web/app/admin/` | Remove empty `settings/` folder |
| `apps/web/app/profile/page.tsx` | NEW — client page |
| `apps/web/components/profile/*.tsx` | NEW (8 files) |
| `apps/web/components/Avatar.tsx` | NEW (shared) |
| `apps/web/components/Navbar.tsx` | Restructure LINKS + admin-only LB entry |
| `apps/web/components/AuthForm.tsx` | No change (Google OAuth only) |
| `apps/web/lib/api.ts` | Extend AuthUser + 7 new helpers |
| `apps/web/app/globals.css` | Add `scroll-margin-top: 80px` untuk anchor section |
| `scripts/smoke-user.mjs` | NEW |

---

## 10. LB Seed Data (default 2 akun — akun 1 + akun 2 LB origin)

**Penjelasan:** LB "wadah besar" = akun CF 1 (main, R2+KV+D1) + akun CF 2 (origin LB, D1+KV saja, tanpa R2). Akun 2 bantu fetch/scrape + traffic distribution, tidak ganggu akun 1. Admin bisa tambah akun ke-3, ke-4, dst via panel (perbesar DB KV/D1, atasi limit Workers, tambah scrape paralel).

**Seed INSERT di migration `0005_user_profile.sql`** (atau file terpisah `0006_lb_seed.sql` — pilih satu):

```sql
-- Idempotent guard: pakai INSERT OR IGNORE / WHERE NOT EXISTS
-- 1. lb_settings: default 'on', implementation 'custom'
INSERT OR IGNORE INTO lb_settings (id, mode, implementation, steering_policy, health_check_interval_sec, health_check_timeout_ms, failure_threshold)
VALUES (1, 'on', 'custom', 'failover', 30, 3000, 2);

-- 2. lb_accounts: 2 entry
--    Akun 1: encrypted_token placeholder NULL (token di main Worker, dipakai in-process, tidak di-store)
--    Akun 2: encrypted_token NULL (auto-provisioned, token di Worker env vars, bukan DB)
--    Token terakhir4 disimpan untuk UI display
INSERT OR IGNORE INTO lb_accounts (id, provider, label, account_ref, encrypted_token, token_last4, status, created_at)
VALUES
  ('acc_main_oktz', 'cloudflare', 'Akun 1 (main)', '4ce21aec2dd478bf380b7b59990a9165', X'', '****', 'verified', unixepoch()),
  ('acc_origin_tzok5555', 'cloudflare', 'Akun 2 (LB origin)', '6a0bdfb8bccff744bd738a57502d0380', X'', '****', 'verified', unixepoch());

-- 3. lb_origins: 2 entry (satu per akun, weight=1 default)
INSERT OR IGNORE INTO lb_origins (id, account_id, origin_url, priority, weight, enabled, created_at)
VALUES
  ('ori_main', 'acc_main_oktz', 'https://manga-api.oktz.workers.dev', 0, 1, 1, unixepoch()),
  ('ori_tzok5555', 'acc_origin_tzok5555', 'https://manga-api-2.tzok5555.workers.dev', 1, 1, 1, unixepoch());
```

**Catatan teknis:**
- `encrypted_token` di-seed sebagai empty blob `X''` — Worker `getLbSettings()`/`listAccounts()` harus handle empty blob gracefully (skip decrypt, return `token_last4` saja). Untuk akun 1+2, token sebenarnya di **Worker env vars** (main: `CLOUDFLARE_API_TOKEN`, akun 2: di-deploy via auto-provision dengan secrets ALLOWED_ORIGINS + SCRAPE_API_KEY). DB hanya metadata.
- Kalau auto-provision akun 2 sudah pernah jalan, `INSERT OR IGNORE` no-op. ID `acc_origin_tzok5555` constant → bisa reference ulang.
- Akun-2 **tidak bisa R2** (akun CF tanpa CC tidak boleh R2). `ASSETS_R2` binding di Worker akun-2 di-skip saat deploy (existing behavior, lihat skill section "Gotchas — LB auto-provision").
- Fetch/scrape load distribution: Worker `getLbSettings().mode === 'on'` → `getHealthyOrigin()` round-robin antara 2 origins. Akun 2 punya MY_BROWSER binding → bisa handle BacaKomik/ManhwaIndo scrape (CF Bot Fight). Lihat frontend `apiWithFailover` `originSupports()` (skill section "Round-robin client-side").

**Front-end implication:** Panel LB langsung menampilkan 2 akun + 2 origins tanpa input manual. Tombol "Tambah Akun" / "+ Origin" tetap ada untuk ekspansi (akun 3, 4, dst).

---

## 11. Non-Goals (di-defer)

- Email change (ikat ke Google OAuth, tidak di-allow).
- Custom avatar upload (selalu Google picture, no R2).
- Light theme CSS variable (UI support, tapi tema terang di-skip di implementation ini).
- 2FA / TOTP.
- Session device fingerprint lebih akurat (cukup UA parsing).
- Bookmark/history public share feature (placeholder toggle saja).
- Profile publik page `/u/:id` (private by design).
- Notifikasi email.
