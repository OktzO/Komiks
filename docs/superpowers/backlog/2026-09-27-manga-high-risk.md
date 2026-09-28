# High-risk manga backend backlog

Surfaced by the Task 4 adapter audit (`packages/sources/{komiku,bacakomik,thrive,manhwaindo,shinigami,webtoon}/`,
`apps/api-cf/src/lib/`). Nothing in this document was changed by the audit, and nothing is changed by the
re-verification pass that produced the current revision.

**This revision re-verified every claim below against the code on `feat/novel-module`.** Line references that had
drifted were corrected, and three claims that had become false were withdrawn — see §6. Treat any reference here as
a starting point to re-confirm, because this document has now been wrong about line numbers twice.

Two rules still govern the list:

1. **Anything that alters what a manga parser emits is off-limits** until proven otherwise. Manga parsing is
   production traffic. A "cleanup" that changes a chapter id or a cover URL is a regression, not a refactor.
2. The items in §2 are structurally protected. They are listed with what would have to be *true* before they
   could move, not with a plan to move them.

## 0. Verified baseline

Re-measured on `feat/novel-module` at the time of writing, against the **current working tree**:

| Suite | Command | Result |
|---|---|---|
| `apps/api-cf` | `npm test` (`tsx --test test/*.test.mjs`) | **422 / 422 pass, 0 fail** |
| `packages/sources` | `npm test` | **71 / 71 pass, 0 fail** across all 9 test files |
| `packages/db` | `npm test` | **82 / 82 pass, 0 fail** (7 files) |
| `packages/db` | `npm run test:sqlite` | `admin-inventory.test.mjs` — **not runnable on local Node 20**; needs Node 22, so it lives in a separate script that the existing `node22` CI job runs (not a third job) |
| `tsc --noEmit` | per package | clean in `packages/sources`, `packages/db`, `packages/shared`, `packages/lb`, `apps/api-cf` |

---

# Ordering table — the 30-second read

Ordered by *what unblocks the most per session*, not by severity. "Size" is sessions at one sitting.

| # | Item | What it is | Why now / why not | Size |
|---|---|---|---|---|
| 1 | **Komiku fixture corpus + test harness** (§3.1) | `packages/sources/komiku/` has no `fixtures/` dir and no test file — the one adapter with zero executed coverage | **Now.** Nothing about komiku can be touched safely without it, and it blocks #2 and #6. Cheapest high-value item in the list | 1 session, low |
| 2 | **`this`-dependent methods → closures** (§3.2) | `packages/sources/shinigami/index.ts:171`, `packages/sources/webtoon/index.ts:305,306,354` bind `this` | **Now.** Latent, not active. The test harness to de-risk it **already exists** — extend and convert | 0.5 session, low |
| 3 | **Robots KV cache: use the handle already in scope** (§3.3 + §3.4) | All six manga `checkRobots` pass `null` for KV, so the 24 h cache never engages | **Now, and the stated blocker is false.** The adapters already close over `env`; no interface change is needed | 1 session, low-med |
| 4 | **Sharding key-format contract** (§2.4) | `ownerFor` hashes the *string form* of the key, invisibly at the call site | **Now, cheap.** 12 production call sites, and a placement test already exists. Doc + test, no logic change | 1 session, low |
| 5 | **AES-GCM versioned blob layout** (§2.5) | `packages/lb/crypto.ts` stores `[iv\|ct]` with no version byte, key is a bare `SHA-256` digest | **Now.** Independent and unblocked. Until it lands, `LB_ENCRYPTION_KEY` rotation is unrecoverable, not merely expensive | 2 sessions, med |
| 6 | **`KOMIKU_SELECTORS` made load-bearing** (§3.5) | The selector map is decorative; parsing is hardcoded regex | **Not yet.** Blocked on #1. Highest blast radius in the list — the only item that can change parser output | 2–3 sessions, high |
| 7 | **D1 core schema** (§2.1) | `packages/db/schema.sql` + 21 migrations; FTS5 `series_search` fed by 3 triggers | **Not scheduled.** No proposed change. Listed so the next audit does not re-derive it | n/a — don't start |
| 8 | **Consistent-hash ring wiring** (§2.2) | `buildRing`/`ringPick` in `r2-routing.ts` — a capability, deliberately not wired | **Not scheduled.** It is a storage migration, not a refactor. Zero production dependents today | n/a — don't start |
| 9 | **Session ECDSA keyring** (§2.3) | `auth.ts` signs with ECDSA P-256, verifies against a `kid` keyring | **Not scheduled.** Working as designed; the open question is rotation, which is a runbook, not a code change | n/a — don't start |

**Dropped — do not spend a session:** §4.1 (orphan tests, already fixed), §3.6 (komiku dedup, behaviour-preserving),
§4.2 (five redundant casts, zero behaviour change). Reasons in §5.

---

# 1. What the audit did and did not establish

Rule 1 above is the reason §2 and §3 are split. §2 items are load-bearing on live traffic and are not proposed
changes. §3 items are real work with a bounded blast radius, sized for scheduling. §4 is a short list of things
that are not worth a session.

---

# 2. Protected areas — flagged, never modified

## 2.1 D1 core schema

**What it is.** `packages/db/schema.sql` (383 lines) plus **21 numbered migrations** in
`packages/db/migrations/` (`0001_manga_data.sql` … `0021_novel_module.sql`, plus the unnumbered
`backfill_entity_decode.sql`). Holds the live `series` / `chapters` / `chapter_pages` / `sessions` tables.
`series_search` is an **FTS5 virtual table**, `packages/db/schema.sql:299`, fed by three triggers
(`series_search_ai` `:305`, `series_search_ad` `:309`, `series_search_au` `:312`).
Migration `0021_novel_module.sql` added the `novel_series` / `novel_chapters` pair.

**Why it is risky — the concrete failure mode.** D1 is SQLite. Any `ALTER TABLE` that touches a `CHECK`
constraint, a column type, or a referenced FK forces a full table rebuild **on the live production database,
under reader traffic**. **Nine** of the existing migrations already use `ALTER TABLE` (`0001`, `0002`, `0005`,
`0006`, `0007`, `0009`, `0010`, `0013`, `0020`), so the pattern is established and the risk is proven rather
than hypothetical.

The specific silent failure: `series_search` is a *separate* FTS table kept in sync by triggers. An `ALTER` on
`series` that rebuilds the table does **not** re-fire the row triggers, so `series_search` retains rows for
deleted series and misses rows for inserted ones. The result is **not an error** — the query still succeeds
(`apps/api-cf/src/routes/search.ts:56`, `packages/db/index.ts:246`) and simply returns wrong series. Blast
radius: every search result on the site, with no signal anywhere.

**What is load-bearing on it today.**
- Production read path: `apps/api-cf/src/routes/search.ts:56` and `packages/db/index.ts:246` both join
  `series_search f JOIN series s ON s.id = f.rowid WHERE series_search MATCH ?1`.
- Internal admin tooling: `apps/api-cf/src/routes/internal.ts:53,260` name `series_search` in an allowlist.
- `scripts/smoke-db.mjs:50` exercises the same join.
- **No test anywhere reads the FTS index.** Verified: a repo-wide search for `series_search` across `.mjs` and
  `.ts` returns only the two production call sites, the admin allowlist, the smoke script, and this document.
  Zero `.test.mjs` files mention it. So the most dangerous failure mode above is the one with no test.

**What would have to be true first.**
- [ ] A migration rehearsal against a production-shaped copy carrying the real row counts.
- [ ] An FTS5 rebuild in the same migration —
      `INSERT INTO series_search(series_search) VALUES('rebuild')` — and a test that queries `series_search`
      directly. The rebuild statement does not currently exist anywhere in the repo.
- [ ] A documented rollback. D1 migrations are forward-only; a bad `ALTER` is not `git revert`-able.
- [ ] Confirmation that no reader request depends on a column mid-rebuild.

**Sequence and size.** Never bundle a schema change with a parser change. Ship schema + backfill + FTS rebuild
as one release with the rebuild verified in staging, then any parser change in a separate release. Commit
`56abe22` ("scope the fillSeriesGaps guard per column") is the model: a data-layer fix, landed alone. There is
no proposed change today, so this item is not scheduled — it is recorded so the next audit does not re-derive it.

## 2.2 Consistent-hash ring in `packages/shared/src/r2-routing.ts`

**What it is.** A vnode-based consistent-hash ring for B2 account selection. The capability block is the file's
own header comment, `packages/shared/src/r2-routing.ts:52-69`; `buildRing` is at `:99` and `ringPick` at `:130`
in a 143-line file. The header states in Indonesian that live routing stays `murmur3_32 % N`.

**Why it is risky — the concrete failure mode.** Wiring it is **not a refactor, it is a storage migration**.
Objects already uploaded to B2 sit at the position `murmur3_32 % N` chose. Switching to ring placement remaps
every key, so existing `/img` URLs resolve to a different account. The image proxy's redirect indirection does
not save you, because the *key* is the thing that moved. The asymmetry is the entire point of the ring: a
rebalance under `% N` moves ~all keys, under the ring it moves ~1/N — which is why the cutover must be a staged
data move rather than a deploy.

**What is load-bearing on it today. Nothing.** Verified: `buildRing` and `ringPick` have **zero production
callers**. The only references in the repo are `packages/shared/test/r2-routing.test.mjs:17-78`. This is the
single most important fact about this item — the risk is entirely in the *act of wiring it*, not in the code as
it stands, so the code can be refactored freely right up until someone changes a caller.

**The blast radius is larger than the ring itself.** The ring would replace **two** live selectors, and this
backlog previously named only one:
- Shard placement: `ownerFor` / `backupOwnerFor` (§2.4).
- B2 account placement: `pickB2AccountIdx` at `apps/api-cf/src/lib/b2Config.ts:90`, with four production call
  sites — `apps/api-cf/src/lib/novelCover.ts:70`, `apps/api-cf/src/routes/identify.ts:73`,
  `apps/api-cf/src/routes/reader.ts:359` and `:1121`, `apps/api-cf/src/routes/admin/scrape.ts:180`.
  The ring's own header comment at `packages/shared/src/r2-routing.ts:55` names this function explicitly.

**What would have to be true first.**
- [ ] `vnodesPerNode` pinned and identical in every worker build. The header says this already; a drift here
      silently changes placement *per worker*, which is worse than not wiring it at all.
- [ ] A dual-write or read-fallback period: resolve on the ring, fall back to `% N` on miss, so a mis-placed
      object is still served while it is copied.
- [ ] A backfill copying every existing object to its ring position, verified by byte count and sampled hash.
- [ ] Ring tests extended beyond the current N=1/2/5 to N across the real account count.

**Sequence and size.** Do not attempt alongside anything else. Own release, own rollback plan, and only after
§2.4 is understood well enough to reason about partial failure. **Not scheduled** — a multi-release storage
migration, not a single session.

## 2.3 Session token signing — ECDSA P-256 with a `kid` keyring

> **Correction (fix round 1, still in force).** This entry previously opened with "There is no AES-GCM and no
> symmetric token encryption anywhere in this codebase." **That was false and is withdrawn.** AES-GCM *is*
> present, in `packages/lb/crypto.ts`, encrypting Cloudflare API tokens at rest — see §2.5. The claim was a
> codebase-wide negative drawn from a grep covering only `apps/api-cf/src` and `packages/sources`. Original
> wording preserved at commit `3711164`.

**What it is.** `apps/api-cf/src/lib/auth.ts:88-93` signs with **ECDSA, SHA-256**, producing
`b64url(payload).b64url(sig)`. `verifyToken` at `apps/api-cf/src/lib/auth.ts:96` parses the payload, reads its `kid`, and looks the
public key up in a keyring. `apps/api-cf/src/lib/context.ts:97` exposes `sha256Hex` — a plain digest, used for
hashing, not encryption. The token is **signed, not encrypted**: the payload is readable by anyone holding the
cookie. This is deliberate, and `docs/DEPLOY.md` records the choice as "cross-account, no shared secret".

**Scope.** An ECDSA P-256 signing keypair loaded from the `AUTH_SIGNING_KEY` Worker secret
(`apps/api-cf/src/lib/auth.ts:54-63`), with a `kid`-addressed public keyring enabling rotation (`apps/api-cf/src/lib/auth.ts:31-42`), used for the
session cookie (`apps/api-cf/src/lib/auth.ts:275` signing, `apps/api-cf/src/lib/auth.ts:285-287` verifying) and the OAuth state cookie
(`apps/api-cf/src/lib/auth.ts:342` signing, `apps/api-cf/src/lib/auth.ts:349` verifying).

**Why it is risky — the concrete failure mode.** A key rotation invalidates every outstanding session and
every in-flight OAuth flow. The mechanism that makes it all-or-nothing is visible in the code: the `kid` is
resolved **before** the signature is checked. `apps/api-cf/src/lib/auth.ts:112` rejects a payload with no `kid`; `apps/api-cf/src/lib/auth.ts:114`
looks the key up; only `apps/api-cf/src/lib/auth.ts:122` verifies. So the keyring — not the signature — is the authority on token
validity. An incorrect keyring update locks out every user simultaneously, with no partial failure and no
graceful degradation. Sessions are also the root of trust for the service gate
(`apps/api-cf/src/lib/serviceGate.ts:135` checks for `__Host-session=`), so a bad rotation takes down the
authenticated surface too.

**What is load-bearing on it today.** Every authenticated request. `verifyToken` is reached from
`getSessionUser` (`apps/api-cf/src/lib/auth.ts:287`, called on the session path) and `verifyStateCookie` (`apps/api-cf/src/lib/auth.ts:349`, called on
every OAuth callback). `SESSION_TTL` is 7 days (`apps/api-cf/src/lib/auth.ts:71`) and `STATE_TTL` is 10 minutes (`apps/api-cf/src/lib/auth.ts:74`).
A keyring that loses a `kid` therefore has a 7-day tail of tokens to invalidate, not 10 minutes.

**What would have to be true first.**
- [ ] Overlapping validity: the new public key is published *before* the private key starts signing, so a token
      signed under either `kid` verifies for the full `exp` window.
- [ ] The old public key retained for at least `SESSION_TTL` (7 days) after the last old-key signature.
- [ ] A test that a token signed under `kid=A` still validates while `kid=B` is the active signer, and that an
      unknown `kid` is rejected.

**Sequence and size.** Independent of §2.5 — different mechanism, different key, different blast radius (users
vs Cloudflare accounts). `LB_ENCRYPTION_KEY` is scoped to Cloudflare tokens only and is deliberately no longer
used for the session cookie, so rotating one does not disturb the other. **Not scheduled**: the mechanism works
as designed and nothing needs changing. The open question is *how to rotate*, which is a runbook for an
incident, not a code change. The three preconditions above are what that runbook would assert.

## 2.4 Sharding logic (`ownerFor` / `backupOwnerFor`)

**What it is.** `apps/api-cf/src/lib/peers.ts:141-145` and `:147-152`. `ownerFor(env, key)` is
`peers[murmur3_32(key) % peers.length]`; `backupOwnerFor` walks to `(owner.index + 1) % peers.length`. This is
the live router for both D1 shard ownership and session rows.

**Why it is risky — the concrete failure mode.** The hash input is the *string form of the key* —
`String(userId)` at `apps/api-cf/src/lib/userShard.ts:6` takes `String(userId)`; `apps/api-cf/src/lib/storageEviction.ts:26`
takes a raw `chapterId`. The function's contract is
therefore invisible at the call site. Change how a key is formatted and you have silently moved every user's
rows to a different peer: nothing throws, reads simply start missing. Worse, `getPeers` **deliberately does not
throw** on malformed config — `apps/api-cf/src/lib/peers.ts:41-44` states this in a comment, because this is the hot routing path
and bad config must still serve traffic. So a broken topology degrades to "everything is owned by self"
(`apps/api-cf/src/lib/peers.ts:143`) rather than raising an alert. There is also a hard warning at `apps/api-cf/src/lib/peers.ts:38-39` that
`PEER_URLS` must be identical across all workers, or placement diverges per worker.

**What is load-bearing on it today. More than this backlog previously recorded.** Twelve production call sites
across six files, all verified:

| File:line | Key |
|---|---|
| `apps/api-cf/src/lib/userShard.ts:6` | `String(userId)` |
| `apps/api-cf/src/lib/auth.ts:132` | `String(userId)` — session owner |
| `apps/api-cf/src/lib/auth.ts:139, 167, 188, 216, 231` | `String(p.userId)` — session backup owner |
| `apps/api-cf/src/lib/storageEviction.ts:26` | `chapterId` |
| `apps/api-cf/src/lib/novelIngest.ts:438, 461` | `CATALOG_CRAWL_KEY`, series id |
| `apps/api-cf/src/lib/novelShard.ts:93` | `seriesId` |
| `apps/api-cf/src/routes/reader.ts:263, 287, 322, 341` | `chapterId` — the reader hot path |
| `apps/api-cf/src/routes/novel.ts:165, 213` | `slug` |
| `apps/api-cf/src/routes/admin/novel.ts:45` | `CATALOG_CRAWL_KEY` |

Note the three different key shapes already in use (`String(userId)`, `chapterId`, `slug`). A format change to
any one of them relocates real data.

**What would have to be true first.**
- [x] *Already satisfied.* A characterization test **does** assert placement, not just topology shape:
      `apps/api-cf/test/peers.test.mjs:52-58` pins `ownerFor` into `[0, len)` and the matching URL, `:60-62`
      pins stability, `:64-71` pins distribution, `:73-85` covers N=1, `:87-95` covers N=2. This was an open
      question in the previous revision of this document; it is now answered.
- [ ] An explicit, documented key-format per call site, so the hash input is never re-derived by accident.
- [ ] A rehearsal against a copy of the real peer topology showing the same distribution.

**Sequence and size.** If §2.2 is ever attempted, this must not move at the same time — both touch key→owner
placement, and a regression in either is a data-availability incident, not a parse bug. **Not scheduled as a
logic change**, because no change is proposed. The item reduces to writing the key-format contract down, which
is item #4 in the ordering table: **1 session, low difficulty**, and it is worth doing precisely because the
test already exists and the remaining work is documentation.

## 2.5 Cloudflare API token encryption at rest — AES-GCM (`packages/lb/crypto.ts`)

> **Added in fix round 1, still in force.** The original version of this document asserted that no AES-GCM
> existed anywhere in the codebase. That was wrong — this mechanism exists, is deployed, and holds production
> data. A "never modify this" list that tells a reader a mechanism is *absent* is worse than a thin list, because
> the reader concludes the area is safe to change.

**What it is.** `packages/lb/crypto.ts` (43 lines) implements authenticated symmetric encryption of Cloudflare
API tokens using Web Crypto:

- `deriveKey` (`packages/lb/crypto.ts:9`) — `SHA-256(LB_ENCRYPTION_KEY)` imported raw as a 256-bit **AES-GCM** key.
- `encryptToken` (`packages/lb/crypto.ts:20`) — fresh 12-byte random IV per call (`IV_LEN` at `:7`), returns
  `[12-byte iv | ciphertext+tag]`.
- `decryptToken` (`packages/lb/crypto.ts:33`) — splits the IV back off, rejects blobs shorter than `IV_LEN + 1` (`:37`).

The plaintext token is never persisted. Callers: `packages/lb/accounts.ts:204` (store), `packages/lb/accounts.ts:257`
(load), `packages/lb/provision.ts:219`. The ciphertext lands in D1 `lb_accounts.encrypted_token`
(`packages/db/index.ts:433`). Covered by `packages/lb/test/crypto.test.mjs` (random-IV, tamper-rejects,
wrong-key-rejects) and `packages/lb/test/accounts.test.mjs:426-428`. `docs/DEPLOY.md:106` records it as
deployed, keyed from the `LB_ENCRYPTION_KEY` Worker secret.

**Why it is risky — the concrete failure mode.** The key is a bare **SHA-256 digest of the secret** — no salt,
no stretching KDF, and, critically, **no key id in the stored blob** (`packages/lb/crypto.ts:4` documents the layout as
`[12-byte iv | ciphertext+tag]` and nothing else). Three consequences:

- **Rotation is unrecoverable, not merely expensive.** Nothing in the stored layout identifies which key
  produced it, so changing `LB_ENCRYPTION_KEY` makes every previously stored token permanently
  undecryptable. `decryptToken` throws `OperationError` on the GCM tag check. Recovery means re-provisioning
  every LB account by hand.
- **A wrong key is indistinguishable from tampering.** Both surface as the same `OperationError`
  (`packages/lb/test/crypto.test.mjs:37` and `:45` assert exactly this). There is no diagnostic separating "someone rotated the
  secret" from "someone edited the row".
- **These are live Cloudflare credentials.** The B2 image pipeline writes to storage under them. Losing them is
  an outage with an external cause, not a failed fetch.

**What is load-bearing on it today.** `packages/lb/accounts.ts:204, 257` are the store and load paths for every
LB account; `packages/lb/provision.ts:219` is the auto-provisioning path. Downstream, those tokens authorise the B2 writes
behind `/img`, so the dependency chain runs from this file to every stored cover and page image.

**What would have to be true first.**
- [ ] A version/key-id byte prepended to the stored layout, plus a decrypt path that tries the current key and
      falls back — so rotation stops being a hard cutover.
- [ ] A re-encryption pass (decrypt with old key, encrypt with new) run *before* the old key is retired, with a
      row-count reconciliation proving no row was left behind.
- [ ] A salt or a real KDF if the secret is ever reused or low-entropy. The current construction is only
      defensible because the input is a high-entropy generated secret (`docs/DEPLOY.md:23` calls for a 32-byte
      random string).

**Sequence and size.** Independent of §2.3 and §2.4 — different key, different blast radius. Because rotation is
currently unrecoverable, the versioned-layout change must land and be exercised *before* any key rotation, never
together with one. **2 sessions, medium difficulty.** Unblocked, and it is the only item in §2 with real
schedulable work attached to it.

---

# 3. Adapter findings that are not low risk

Real, in the audit's territory, and deliberately not fixed. Unlike §2 these are sized and ordered.

## 3.1 Komiku has no fixture corpus and no test file — blocks everything else komiku

**What it is.** `packages/sources/komiku/` contains `client.ts`, `index.ts`, `selectors.ts` and **no
`fixtures/` directory**. `packages/sources/test/` contains no `komiku.test.mjs`. The five adapters that *do* have
fixtures are `bacakomik` (4 files), `manhwaindo` (4), `shinigami` (5), `thrive` (3), plus
`packages/sources/test/fixtures` (3 novelid files).

**Why it is risky.** It is not risky to change; it is *impossible* to change safely. The two komiku items below
(§3.5, §3.6) both name a fixture corpus as their safety net. That corpus does not exist, so the previous
revision of this document pointed at a precondition that was not merely unmet but entirely absent.

**What is load-bearing on it.** Two orphaned test files do exercise komiku — `packages/sources/test/single-fetch.test.mjs`
(pins the single-fetch `getSeriesDetail` contract) and `packages/sources/test/status.test.mjs` (pins
`mapStatusText`, including "no Status row → unknown, not ongoing"). Both pass when run (2 and 5 tests). They are
now wired into `packages/sources/package.json:16`, so komiku is no longer at zero — but the coverage is inline
HTML strings, not saved upstream fixtures, so it cannot serve as a differential corpus.

**What would have to be true first.** Nothing. This *is* the first step.

**Sequence and size.** **1 session, low difficulty.** Capture komiku search / detail / chapter-list HTML into
`packages/sources/komiku/fixtures/`, mirroring the layout the other adapters use, and add a `komiku.test.mjs`
that pins current `parseSearchHtml` and `parseChapterList` output. Do this before §3.5 or §3.6.

## 3.2 `this`-dependent methods in shinigami and webtoon

**What it is.** `packages/sources/shinigami/index.ts:171` and `packages/sources/webtoon/index.ts:305, 306, 354` call sibling methods through
`this`. `packages/sources/thrive/index.ts:73` is the counter-example: it moved `fetchDetail` into a closure precisely because
detached invocation (`const d = adapter.getSeriesDetail; d()`) drops `this`, and that was recorded as a
healthCheck failure.

**Why it is risky — the concrete failure mode.** Every call site today goes through the adapter object, so
`this` binds. The hazard is latent: the first caller that destructures — `const detail = adapter.getSeriesDetail`
— gets `this === undefined` and a `TypeError` inside the adapter. That failure is a 500 on the reader path, and
it reproduces on exactly the endpoint that already regressed once this way.

**What is load-bearing on it.** `packages/sources/webtoon/index.ts:305-306` is inside `getSeriesDetail`, which is the
single-fetch method the reader calls; `:354` is inside `scrapeUrl`. So the `this` chain sits directly on the
hot read path for the largest adapter.

**What would have to be true first.**
- [x] *Already satisfied, partially.* `apps/api-cf/test/thrive-bind.test.mjs` is exactly the harness this item
      needs — it detaches `getSeriesDetail` (`:20-34`) and `listChapters` (`:36+`) and asserts a network error
      rather than a `TypeError`, with a comment recording the `apps/api-cf/src/routes/reader.ts` detached-
      invocation regression that caused it (that comment cites a line number from the incident, not from the
      current file). The previous revision claimed no such test existed; that was wrong. It covers thrive only.

**Sequence and size.** **0.5 session, low difficulty.** Extend `thrive-bind.test.mjs` to the two `this`-dependent
adapters, confirm red, convert to closures, confirm green.

## 3.3 The robots.txt KV cache never engages on the manga side

**What it is.** Every `fetchRobots` in the manga clients writes a 24 h KV entry (`expirationTtl: 86400` —
`packages/sources/komiku/client.ts:45`, `packages/sources/bacakomik/client.ts:76`, `packages/sources/thrive/client.ts:61`, `packages/sources/manhwaindo/client.ts:73`,
`packages/sources/shinigami/client.ts:76`), but every manga call site passes `null` for the KV handle:

| Adapter | `checkRobots` | `fetchRobots` call |
|---|---|---|
| komiku | `packages/sources/komiku/index.ts:343` | `packages/sources/komiku/index.ts:344` → `fetchRobots(null)` |
| bacakomik | `packages/sources/bacakomik/index.ts:242` | `packages/sources/bacakomik/index.ts:243` → `fetchRobots(null)` |
| thrive | `packages/sources/thrive/index.ts:216` | `packages/sources/thrive/index.ts:217` → `fetchRobots(null)` |
| manhwaindo | `packages/sources/manhwaindo/index.ts:237` | `packages/sources/manhwaindo/index.ts:238` → `fetchRobots(null)` |
| shinigami | `packages/sources/shinigami/index.ts:175` | `packages/sources/shinigami/index.ts:176` → `fetchRobots(null)` |
| webtoon | `packages/sources/webtoon/index.ts:358` | `packages/sources/webtoon/index.ts:359` → `fetchRobots()`; `packages/sources/webtoon/client.ts:105` takes **no KV parameter at all** |

Net effect: robots.txt is refetched from upstream on every `checkRobots` call, which is the opposite of what the
code reads like.

**The previous revision's stated blocker is false, and is withdrawn.** It claimed that
`checkRobots?(url: string)` in `packages/sources/index.ts:37` "takes no environment handle, so there is nowhere
to get a KV namespace from", that fixing it "requires changing that interface", and that `packages/sources/index.ts`
is owned by another task and therefore out of scope. All three are wrong:

1. The interface does not need changing. `packages/sources/novel.ts:34` defines a **separate**
   `NovelSourceAdapter`, and the novel adapters solve exactly this problem by closing over `env` at the factory
   boundary: `novelidAdapter = (env?: NovelidEnv) => {...}` (`packages/sources/novelid/index.ts:35`, with `KV?: KVNamespace` at
   `:21-23`), passing `fetchRobots(env?.KV ?? null)` at `packages/sources/novelid/index.ts:28, 133` and
   `packages/sources/noveltoon/index.ts:41, 105`.
2. **The robots cache is not dead in the codebase — it is dead on the manga side only.** For `novelid` and
   `noveltoon` the 24 h KV cache *does* engage today, because they pass a real handle. The previous headline,
   "dead code in all six adapters", understated this by ignoring two adapters that the novel module added.
3. The manga adapters are **already** factories holding the handle. `packages/sources/index.ts:42-47` wires
   `komikuAdapter(env)`, `bacakomikAdapter(env)`, `thriveAdapter(env)`, `manhwaindoAdapter(env)` and
   `webtoonAdapter(env)`; the factories are declared at `packages/sources/komiku/index.ts:157`, `packages/sources/bacakomik/index.ts:131`,
   `packages/sources/thrive/index.ts:73`, `packages/sources/manhwaindo/index.ts:133`, `packages/sources/webtoon/index.ts:204`. Only `shinigamiAdapter` takes no
   argument (`packages/sources/shinigami/index.ts:105`).

This is the same error class as the withdrawn AES-GCM claim: a codebase-wide negative drawn from a narrow grep,
stating that a mechanism does not work when it does. Two of the three claims in this entry have now been
corrected, and the entry is downgraded from "blocked on another team" to "half a session".

**Why it is not low risk anyway.** Changing the *call* is trivial; changing the *interface* is what the previous
revision thought was required, and that would have touched `SourceAdapter` — used by six production adapters.
The safe shape is the novel one: keep the interface, thread the existing closure `env` into the robots fetch.
The one genuine behaviour change is that the cache starts working, which means a robots policy change now takes
up to 24 h to be observed instead of being live. That is a deliberate trade, and it is the one to state in the
commit message.

**What would have to be true first.**
- [ ] A decision on `shinigamiAdapter`'s factory signature — the only one of the six that cannot currently see
      `env`. `packages/sources/index.ts:46` already calls it as `() => shinigamiAdapter()`, so widening it is
      a one-line change at that call site.
- [ ] Agreement that 24 h staleness for robots is acceptable, given the cache key is per-source.

**Sequence and size.** **1 session, low-medium difficulty.** Coupled to §3.4 — do them together, see §5.

## 3.4 `RobotsResult` / `isPathAllowed` / `fetchRobots` are duplicated eight times

**What it is.** Near-identical copies in eight `client.ts` files: `komiku`, `bacakomik`, `thrive`, `manhwaindo`,
`shinigami`, `webtoon`, `novelid`, `noveltoon`. (`gooddreamer` has neither.) Measured body sizes: 29, 28, 28,
28, 11, 21, 29 and 28 lines respectively. The previous revision said "five-and-a-half" and listed six files —
that count was correct when written and is now stale by two, because the novel module added `novelid` and
`noveltoon`.

**Why it is not low risk — and why the copies have *already* diverged in two ways, not one.** The previous
revision noted only the signature difference. There is a second: the **call convention**. A shared
`fetchRobots` must pick one signature *and* one KV-passing convention, and today the two are inconsistent —
`novelid`/`noveltoon` pass a live handle, the six manga pass `null`, and `webtoon` takes no argument. Deduping
first would relocate that inconsistency into a shared module where it looks deliberate, and would make the
§3.3 fix land in the wrong place.

**What is load-bearing on it.** `isPathAllowed` gates every upstream fetch in the six manga adapters
(`packages/sources/komiku/index.ts:344`, and the equivalent call in each). Getting a shared `isPathAllowed` wrong does not fail
loudly — it either blocks legal paths (a total fetch outage for that source) or allows disallowed ones (a
robots-compliance breach). Blast radius is the full upstream surface of all six sources.

**What would have to be true first.** §3.3 must be answered first, so the shared function is written once with
the correct convention rather than three times with three conventions.

**Sequence and size.** Fold into §3.3, once the interface question is answered. **1 session combined, not 2.**

## 3.5 `KOMIKU_SELECTORS` is decorative — the parser ignores it

**What it is.** `packages/sources/komiku/selectors.ts` (22 lines) defines a full selector map.
`parseSearchHtml` accepts it as `_sel` at `packages/sources/komiku/index.ts:35` and **never reads it**; the three call sites —
`packages/sources/komiku/index.ts:170`, `:203`, `:253` — all pass it into a parameter that is ignored. Actual parsing is
hardcoded regexes plus `html.split('<div class="bge">')` at `packages/sources/komiku/index.ts:36`.

**Why it is not low risk — the concrete failure mode.** Making the parser honour the selectors means replacing
regex extraction with selector-driven extraction. That changes what `parseSearchHtml` returns for any page
whose markup the two approaches disagree about. The specific downstream damage: the three call sites are the
cover-fallback path (`packages/sources/komiku/index.ts:194-201` and `:244-260`), which is the **only** way a komiku series gets
a cover when the detail page's `itemprop` returns null (`packages/sources/komiku/index.ts:190-191`). A wrong series from
`parseSearchHtml` writes a wrong cover URL into D1 for every chapter-less series page. This is the only item in
this document that can change production parser output.

**What is load-bearing on it.** Two live paths: the cover fallback above, and `parseSearchHtml` at
`packages/sources/komiku/index.ts:170` (the `search()` implementation). Both are on the manga read path.

**What would have to be true first.**
- [x] *Satisfied by §3.1 — which does not exist yet.* The previous revision said to "run both implementations
      over every fixture in `komiku/fixtures/`". There is no such directory. Until §3.1 lands, this item cannot
      start.
- [ ] A fixture-by-fixture differential comparison requiring byte-identical `Series[]` from both
      implementations before adopting the new one.

**Sequence and size.** **2–3 sessions, high difficulty.** Blocked on §3.1. Highest blast radius in the document;
do not schedule it in the same sitting as anything else.

## 3.6 `komiku.scrapeUrl` duplicates `parseChapterList`

> **Corrected in fix round 1, still in force.** This entry previously claimed the two code paths had *silently
> diverged* and that consolidating them would change persisted chapter ids, requiring a data migration. **That
> was wrong.** The divergence does not exist.

The chapter-id extraction in `parseChapterList` was `href.split('/').filter(Boolean).pop() ?? ''` followed by
`.replace(/\/$/, '')`, while `scrapeUrl` used the first part only. That looked like an asymmetry. It is not:
`filter(Boolean)` already discards the empty trailing segment produced by a href like `/foo-chapter-12/`, so
`pop()` can never return a string ending in `/`, and the `.replace` was **unreachable dead code**.
`/x-chapter-12/`, `/x-chapter-12` and `/x-chapter-12.5/` all yielded byte-identical ids through both paths.

**Resolution.** The dead strip is removed (commit `eae035b`). With it gone both paths compute the id with the
same expression — `packages/sources/komiku/index.ts:72` and `:310`/`:327` are now all
`href.split('/').filter(Boolean).pop() ?? ''`.

**What is load-bearing on it.** Chapter ids are persisted in D1. A behaviour-preserving dedup touches nothing;
this is why the item is **dropped** rather than scheduled — see §5.

## 3.7 Redundant `as unknown as SourceAdapter` casts

`packages/sources/index.ts:43-47` carries five `as unknown as SourceAdapter` casts. Verified: all six adapters
satisfy the interface without them. The casts suppress real type checking for no reason. `index.ts` is shared
territory, and removing them is a zero-behaviour-change edit. **Dropped** — see §5.

---

# 4. Lower-severity notes

## 4.1 Orphaned test files — already fixed, dropped

**Previously reported as an open finding. This is now resolved in the working tree and needs no session.**

- `packages/sources/package.json:16` now invokes all 9 test files. The three that used to be orphaned —
  `shinigami.test.mjs`, `single-fetch.test.mjs`, `status.test.mjs` — are wired in and pass (5, 2 and 5 tests).
  Sources is now 71/71.
- `packages/db/package.json:17` invokes 7 of 8 files. The eighth, `admin-inventory.test.mjs`, is split into
  `test:sqlite` (`packages/db/package.json:18`) because `node:sqlite` requires Node 22 while the main job runs
  Node 20; it is invoked in a separate CI job at `.github/workflows/tests.yml`. Db is now 82/82 on the default
  script.
- (The previous revision also had these counts wrong: it said `packages/db/test` "holds 7 while its script
  invokes 2". It holds 8 and now invokes all 8.)

## 4.2 Other notes, no action

- **`packages/sources/index.ts` is clean** with respect to the audit checklist: no inline upstream URLs, no
  parsing rules, no secrets. Recorded because the brief asked for it and the answer is "nothing to do".
- **Duplicated chapter-mapping closures in thrive.** `thrive/index.ts` repeats the same
  `chapterlist.map(...)` in `listChapters` (`:153`), `getSeriesDetail` (`:170`), `scrapeUrl` (`:203`) and the
  fixture helper (`:261`). All four confirmed. Output is identical today, so this is not a correctness issue,
  but it is four copies that must be edited together if the mapping ever changes. A `toChapters()` helper is
  the obvious fix; skipped because the rule is already in the right file.
- **`packages/sources/komiku/index.ts:197`** has anomalous 11-space indentation inside the cover-fallback block, inconsistent
  with the parallel block at `:247`. Cosmetic; left alone to keep fix diffs minimal.

---

# 5. Coupling, and what to drop

**Coupled — schedule together, or you will waste a session:**

- **§3.1 → §3.5 and §3.1 → §3.6.** Both komiku items name a fixture corpus as their safety net and it does not
  exist. Doing either first means improvising an ad-hoc harness. Do §3.1 first; it is one session and it
  converts two blocked items into scheduled ones.
- **§3.3 + §3.4.** Already coupled, and the coupling is *stronger* than the previous revision stated: there are
  now three call conventions across eight copies (live handle / `null` / no parameter), so the dedup and the
  cache fix are one piece of work. Budget 1 session for both, not 2.
- **§2.2 + §2.4.** Both touch key→owner placement. Already stated; unchanged.

**Independent — can run in any order, in any combination:** §2.3, §2.5, and (once unblocked) §3.2.

**Recommended to drop:**

- **§3.6 (komiku dedup).** With the dead strip already removed by `eae035b`, the two copies are provably
  equivalent. Consolidating them changes no id, no URL, no chapter. It is a dedup, not a risk item, and
  spending a session on it means not spending one on §3.1, which gates more. Fold it into whatever session
  builds the fixture corpus, if at all.
- **§3.7 (five redundant casts).** Zero behaviour change, and `packages/sources/index.ts` is shared territory.
  This belongs in a routine cleanup, not a risk session.
- **§4.1 (orphan tests).** Already fixed in the working tree. Nothing to schedule.

---

# 6. Corrections made in this revision

Every claim below was re-checked against the code on `feat/novel-module`. Recorded because this document has now
been wrong about its own content more than once, and a correction nobody can find is a correction that will be
reintroduced.

**Claims withdrawn (previously false):**

1. **§3.3 — "the robots KV cache is dead code in all six adapters" and "there is nowhere to get a KV
   namespace from".** Both false. `packages/sources/novelid/index.ts:28, 133` and `packages/sources/noveltoon/index.ts:41, 105` pass a real KV
   handle and the cache **does** engage for them. The `SourceAdapter` interface does not need changing —
   the novel adapters demonstrate the pattern (close over `env` at the factory boundary) with the interface
   untouched. Same error class as the withdrawn AES-GCM claim.
2. **§3.2 — "the fix is only safe together with a test that pins both invocation styles, which does not exist
   today."** False. `apps/api-cf/test/thrive-bind.test.mjs` is that test, for thrive.
3. **§2.4 — "`peers.test.mjs` exists; confirm it actually asserts placement, not just topology shape."**
   Resolved: it does, at `apps/api-cf/test/peers.test.mjs:52-95`.

**Line references corrected (drift):**

| Item | Said | Actual |
|---|---|---|
| §1.3 (old) | `apps/api-cf/src/lib/context.ts:92` = `sha256Hex` | `apps/api-cf/src/lib/context.ts:97` |
| §3.5 (old) | komiku call sites `169, 202, 252` | `170, 203, 253` |
| §2.4 (old) | `apps/api-cf/src/lib/novelIngest.ts:239` as an `ownerFor` call site | `:239` is `env: Env` inside `refreshSeries`; the real calls are `apps/api-cf/src/lib/novelIngest.ts:438, 461` |
| §2.4 (old) | 4 `ownerFor` callers | 12 production call sites across 6 files (table in §2.4) |
| §2.2 (old) | ring at "lines 71-130+" | header `:52-69`; `buildRing` `:99`; `ringPick` `:130`; file is 143 lines |
| §2.2 (old) | ring replaces sharding only | also replaces `pickB2AccountIdx` (`apps/api-cf/src/lib/b2Config.ts:90`, 4 call sites) — named in the ring's own header at `packages/shared/src/r2-routing.ts:55` |
| §3.4 (old) | "five-and-a-half" copies across 6 files | 8 copies across 8 files |
| §3.5 (old) | fixtures in `komiku/fixtures/` | no such directory; no `komiku.test.mjs` either |
| §4 (old) | `console.*` in `peers.ts`, `serviceGate.ts`, `storageEviction.ts`, `dbWrite.ts` | also `novelIngest.ts` and `novelCover.ts` |
| §4 (old) | log shape at `packages/sources/novel.ts:100` | `packages/sources/novel.ts:107-113` (`console.error(JSON.stringify({ source, entityId, stage, error }))` at `:113`) |
| §4.1 (old) | db "holds 7 while its script invokes 2" | holds 8, invokes 8 |

**Baseline corrected:** was "api-cf 334/337, sources 51/51, db 35/35". Now **api-cf 422/422, sources 71/71,
db 82/82**, and `tsc --noEmit` confirmed clean in all five packages rather than only at the root.

**Confirmed still true** (re-verified, not assumed): `schema.sql` 383 lines, 21 numbered migrations,
`series_search` FTS5 at `packages/db/schema.sql:299`, triggers at `:305`/`:309`/`:312`, 9 migrations using `ALTER TABLE`,
and no test reading the FTS index end-to-end. `apps/api-cf/src/lib/auth.ts:88-93`, `:96`, `:83`, `:132`, `:275`, `:285-287`,
`:342`, `:349`; `kid` resolved before signature verification at `:112`/`:114`/`:122`;
`apps/api-cf/src/lib/serviceGate.ts:135`; `SESSION_TTL` 7d at `apps/api-cf/src/lib/auth.ts:71`. `packages/lb/crypto.ts:9`/`:20`/`:33`, `packages/lb/accounts.ts:204`/`:257`,
`packages/lb/provision.ts:219`, `docs/DEPLOY.md:106`. `apps/api-cf/src/lib/peers.ts:141-145`/`:147-152`, `:41-44`. `packages/sources/komiku/index.ts:35` and `:36`.
thrive map closures at `:153`/`:170`/`:203`/`:261`. `packages/sources/komiku/index.ts:197` indentation. `selectors.ts` 22 lines.
All six manga adapters emit no `console.*` in `.ts` source. No literal secrets; `apps/api-cf/src/lib/turnstile.ts:15` and
`apps/api-cf/src/lib/adminInventory.ts:14,17` are third-party service origins. No SQL interpolation in `apps/api-cf/src/lib/` or
`apps/api-cf/src/routes/`. Every real `fetch(...)` carries `AbortSignal.timeout` or a `timeout:` option.

---

# 7. Confirmed-clean (recorded so the next audit does not re-check it)

- **Timeouts.** Every network call across all six adapters and their clients carries an explicit
  `AbortSignal.timeout(...)` or `timeout:` option. Re-verified with a parenthesis-balanced scan of all 70 call
  sites; zero unqualified network calls. (Wrapper *function* names such as `fetchHtml` and `fetchRobots` are
  not network calls and are excluded.)
- **Secrets.** No literal API key, token, password, or bearer value in any adapter or in
  `apps/api-cf/src/lib/`. The hardcoded URLs in `apps/api-cf/src/lib/` are all third-party service origins that
  belong where they are (`apps/api-cf/src/lib/turnstile.ts:15` Cloudflare, `apps/api-cf/src/lib/adminInventory.ts:14,17` Cloudflare + Backblaze).
- **SQL interpolation.** No template-literal or `+`-concatenated SQL anywhere in `apps/api-cf/src/lib/` or
  `apps/api-cf/src/routes/`. All statements are parameterised via `.bind(...)`.
- **`SourceAdapter` conformance.** All six manga adapters satisfy the interface without casts (see §3.7).
- **Log shape.** The `{ source, entityId, stage, error }` shape is defined at `packages/sources/novel.ts:107-113`
  and used by the novel adapters. The six manga adapters emit **no** `console.*` calls at all — they throw, and
  the caller logs — so there is nothing in that territory to unify. The `console.*` lines in
  `apps/api-cf/src/lib/` are config/topology/gate/eviction events with no `source` and no `entityId`; forcing the
  scrape-log shape onto them would be a category error, not a unification.
