# High-risk manga backend backlog

Surfaced by the Task 4 adapter audit (`packages/sources/{komiku,bacakomik,thrive,manhwaindo,shinigami,webtoon}/`,
`apps/api-cf/src/lib/`). Nothing in this document was changed.

Two rules govern this list:

1. **Anything here that would alter what a manga parser emits is off-limits** until proven otherwise. Manga parsing
   is production traffic. A "cleanup" that changes a chapter id or a cover URL is a regression, not a refactor.
2. The four areas in §1 are structurally protected. They are listed with what would have to be *true* before they
   could move, not with a plan to move them.

Audit baseline at time of writing: api-cf 334/337 pass (3 known pre-existing failures, unrelated to the adapters),
`packages/sources` 51/51, `packages/db` 35/35, `tsc --noEmit` clean.

---

## 1. Protected areas — flagged, never modified

### 1.1 D1 core schema

**What it is.** `packages/db/schema.sql` (383 lines) plus 21 numbered migrations in `packages/db/migrations/`.
Holds the live `series` / `chapters` / `chapter_pages` / `sessions` tables. `series_search` is an
**FTS5 virtual table** (`schema.sql:299`) fed by three triggers (`series_search_ai/ad/au`, `schema.sql:305-313`).
Migration `0021_novel_module.sql` added the `novel_series` / `novel_chapters` pair.

**Why it is risky.** D1 is SQLite. Any `ALTER TABLE` that touches a `CHECK` constraint, a column type, or a
referenced FK forces a full table rebuild — on the live production database, under reader traffic. The FTS5
triggers compound it: an `ALTER` on `series` and a stale `series_search` index produce silently wrong search
results rather than an error, and nothing in the test suite reads the FTS index end-to-end. Nine of the existing
migrations already use `ALTER TABLE`, so the pattern is established and the risk is proven, not hypothetical.

**What would have to be true to change it safely.**
- A migration rehearsal against a production-shaped copy with the row counts of the real tables.
- An FTS5 rebuild (`INSERT INTO series_search(series_search) VALUES('rebuild')`) in the same migration, plus a
  test that queries `series_search` directly, not just the `series` table.
- A documented rollback. D1 migrations are forward-only; a bad `ALTER` is not `git revert`-able.
- Confirmation that no reader request depends on a column mid-rebuild.

**Sequencing.** Never bundle a schema change with a parser change. Ship schema + backfill + FTS rebuild as one
release with the FTS rebuild verified in staging, then the parser change in a separate release. The 56b commit
`56abe22` ("scope the fillSeriesGaps guard per column") is the model: a bug fix in the data layer, landed alone.

### 1.2 Consistent-hash ring in `packages/shared/src/r2-routing.ts`

**What it is.** `buildRing()` / `ringPick()` (lines 71-130+) implement a vnode-based consistent-hash ring for
B2 account selection. The file's own header (lines 52-68) states it is a *capability, deliberately not wired*,
and that live routing stays `murmur3_32 % N`.

**Why it is risky.** Wiring it is not a refactor, it is a **storage migration**. Objects already uploaded to B2
sit at the position `murmur3_32 % N` chose. Switching to ring placement remaps every key: existing `/img` URLs
resolve to a different account, and the redirect indirection the image proxy already carries does not save you.
`% N` also has the property that a rebalance moves ~all keys; the ring moves ~1/N. That asymmetry is the whole
point of the ring and the whole reason the cutover must be a deliberate, staged data move, not a deploy.

**What would have to be true to change it safely.**
- `vnodesPerNode` pinned and identical in every worker build (the file already says this; a drift here silently
  changes placement per worker and is worse than not wiring it).
- A dual-write or read-fallback period: resolve on the ring, fall back to `% N` on miss, so a mis-placed object
  is still served while it is copied.
- A backfill that copies every existing object to its ring position, verified by byte count and sampled hash.
- The ring's own tests currently cover N=1/2/5; a real cutover wants N across the actual account count.

**Sequencing.** Do not attempt alongside anything else. This is its own release, with its own rollback plan, and
it should land only after §1.4 (sharding) is understood well enough to reason about partial failure.

### 1.3 Session token signing — ECDSA P-256 with a `kid` keyring

> **Correction (fix round 1).** This entry previously opened with "There is no AES-GCM and no symmetric token
> encryption anywhere in this codebase." **That was false and is withdrawn.** AES-GCM *is* present, in
> `packages/lb/crypto.ts`, encrypting Cloudflare API tokens at rest — see §1.5. The claim was a codebase-wide
> negative drawn from a grep that only covered `apps/api-cf/src` and `packages/sources`. The two mechanisms are
> unrelated and are documented separately. Original wording preserved in git history at `3711164`.

**What it is.** `apps/api-cf/src/lib/auth.ts:88-93` signs with **ECDSA, SHA-256**, producing
`b64url(payload).b64url(sig)`. `verifyToken` (line 96) parses the payload, reads its `kid`, and looks the public
key up in a keyring. `context.ts:92` exposes `sha256Hex` (a plain SHA-256 digest, used for hashing, not
encryption). The token is **signed, not encrypted** — the session payload is readable by anyone holding the
cookie. This is deliberate: the payload is cross-account, and `docs/DEPLOY.md` records the choice as
"cross-account, nol shared secret".

**Scope.** An ECDSA P-256 signing keypair loaded from `AUTH_SIGNING_KEY`, with a `kid`-addressed public keyring
enabling rotation, used for both the session cookie (`auth.ts:275, 285-287`) and the OAuth state cookie
(`auth.ts:342-349`).

**Why it is risky.** A key rotation invalidates every outstanding session and every in-flight OAuth flow. The
payload carries `exp` (`auth.ts:83`) but the `kid` is resolved *before* the signature is checked, so the keyring
is the authority on token validity — an incorrect keyring update locks out every user at once, with no partial
failure and no graceful degradation. Sessions are also the root of trust for the service gate
(`serviceGate.ts` checks `__Host-session=`), so a bad rotation takes down the authenticated surface too.

**What would have to be true to change it safely.**
- Overlapping validity: the new public key is published *before* the private key starts signing, so a token
  signed under either `kid` verifies for the full `exp` window.
- The old public key is retained for at least `SESSION_TTL` after the last old-key signature is issued.
- A test that verifies a token signed under `kid=A` still validates while `kid=B` is the active signer, and that
  an unknown `kid` is rejected.

**Sequencing.** Independent of §1.5 — different mechanism, different key, different blast radius (users vs
Cloudflare accounts). Either can move without the other. Note that `LB_ENCRYPTION_KEY` is scoped to Cloudflare
tokens only and is deliberately no longer used for the session cookie, so rotating one does not disturb the other.

### 1.4 Sharding logic (`ownerFor` / `backupOwnerFor`)

**What it is.** `apps/api-cf/src/lib/peers.ts:141-151`. `ownerFor(env, key)` is
`peers[murmur3_32(key) % peers.length]`; `backupOwnerFor` walks to `(owner.index + 1) % peers.length`. This is
the live router. Callers: `userShard.ts:6`, `auth.ts:132` (session owner), `storageEviction.ts:26`,
`novelIngest.ts:239`.

**Why it is risky.** The hash input is the *string form of the key* — `String(userId)`, `chapterId` — so the
function's contract is invisible at the call site. Change how a key is formatted and you have silently moved
every user's rows to a different peer; nothing throws, reads just start missing. It is on the hot routing path,
so a `getPeers` error must not throw (see the `peers.ts:40-44` comment — malformed config must still serve
traffic), which means a broken config degrades into "everything is owned by self" rather than an alert.

**What would have to be true to change it safely.**
- A characterization test pinning `ownerFor` output for a fixed peer list and key set, run before and after.
  `peers.test.mjs` exists; confirm it actually asserts placement, not just topology shape.
- An explicit, documented key-format per call site, so the hash input is never re-derived by accident.
- A rehearsal against a copy of the real peer topology showing the same distribution.

**Sequencing.** If §1.2 is ever attempted, this must not move at the same time. Both touch key→owner placement,
and a regression in either is a data-availability incident, not a parse bug.

### 1.5 Cloudflare API token encryption at rest — AES-GCM (`packages/lb/crypto.ts`)

> **Added in fix round 1.** The original version of this document asserted that no AES-GCM existed anywhere in
> the codebase. That was wrong — this mechanism exists, is deployed, and is production data. It is listed here
> because a "never modify this" list that tells a reader a mechanism is *absent* is worse than a thin list: the
> reader concludes the area is safe to change. See §1.3 for the correction note.

**What it is.** `packages/lb/crypto.ts` implements authenticated symmetric encryption of Cloudflare API tokens
using Web Crypto:

- `deriveKey` (line 9) — `SHA-256(LB_ENCRYPTION_KEY)` imported raw as a 256-bit **AES-GCM** key.
- `encryptToken` (line 19) — fresh 12-byte random IV per call, returns `[12-byte iv | ciphertext+tag]`.
- `decryptToken` (line 36) — splits the IV back off, rejects blobs shorter than `IV_LEN + 1`.

The plaintext token is never persisted. Callers: `accounts.ts:204` (store), `accounts.ts:257` (load),
`provision.ts:219`. The ciphertext lands in D1 `lb_accounts.encrypted_token`. Covered by
`packages/lb/test/crypto.test.mjs` (random-IV, tamper-rejects, wrong-key-rejects) and `accounts.test.mjs`.
`docs/DEPLOY.md:106` records it as deployed, keyed from the `LB_ENCRYPTION_KEY` Worker secret.

**Why it is risky.** The key is a bare **SHA-256 digest of the secret** — no salt, no stretching KDF, and no key
id stored in the blob. Three consequences:

- **Rotation is unrecoverable, not merely expensive.** The stored layout carries no version or key id, so
  changing `LB_ENCRYPTION_KEY` makes every previously stored token permanently undecryptable. `decryptToken`
  throws `OperationError` on the GCM tag check. Recovery means re-provisioning every LB account by hand.
- **A wrong key is indistinguishable from tampering.** Both surface as the same `OperationError`. There is no
  diagnostic that separates "rotated the secret" from "someone edited the row".
- **These are live Cloudflare credentials.** The B2 image pipeline writes to storage under them. Losing or
  corrupting them is an outage with an external cause, not just a failed fetch.

**What would have to be true to change it safely.**
- A version/key-id byte prepended to the stored layout, plus a decrypt path that tries the current key and
  falls back — so rotation stops being a hard cutover.
- A re-encryption pass (decrypt with old key, encrypt with new) run *before* the old key is retired, with a
  row-count reconciliation proving no row was left behind.
- A salt or a real KDF if the secret is ever reused or low-entropy; the current construction is only defensible
  because the input is a high-entropy generated secret.

**Sequencing.** Independent of §1.3 and §1.4 — different key, different blast radius (Cloudflare accounts vs
users vs row placement). Because rotation is currently unrecoverable, the versioned-layout change must land and
be exercised *before* any key rotation, never together with one.

---

## 2. Adapter findings that are NOT low risk

These are real, they are in my territory, and they were deliberately **not** fixed.

### 2.1 `KOMIKU_SELECTORS` is decorative — the parser ignores it

`packages/sources/komiku/selectors.ts` defines a full selector map. `parseSearchHtml` accepts it as `_sel`
(`komiku/index.ts:35`) and never reads it; all three call sites (lines 169, 202, 252) pass it into a parameter
that is ignored. Actual parsing is a set of hardcoded regexes and `html.split('<div class="bge">')`.

**Why it is not low risk.** Making the parser honour the selectors means replacing regex extraction with
selector-driven extraction. That changes what `parseSearchHtml` returns for any page whose markup the two
approaches disagree about. This is the single highest-value item in the list and the one most likely to look
like a harmless refactor. It needs a fixture-by-fixture differential comparison — run both implementations over
every fixture in `komiku/fixtures/` and require byte-identical `Series[]` before adopting the new one.

**Sequencing.** After a characterization test exists that pins current output on the full fixture corpus. Without
that harness this change should not start.

### 2.2 `komiku.scrapeUrl` duplicates `parseChapterList` — duplication is real, divergence is not

> **Corrected in fix round 1.** This entry previously claimed the two code paths had *silently diverged* and that
> consolidating them would change persisted chapter ids, requiring a data migration. **That was wrong.** The
> divergence does not exist.

The chapter-id extraction in `parseChapterList` was `href.split('/').filter(Boolean).pop() ?? ''` followed by
`.replace(/\/$/, '')`, while `scrapeUrl` used the first part only. That looked like an asymmetry in output. It is
not one: `filter(Boolean)` already discards the empty trailing segment produced by a href like
`/foo-chapter-12/`, so `pop()` can never return a string ending in `/`, and the `.replace` was **unreachable dead
code**. `/x-chapter-12/`, `/x-chapter-12` and `/x-chapter-12.5/` all yielded byte-identical ids through both
paths. Confirmed by brute force over the trailing-slash shapes, not by inspection.

**Resolution — the dead strip is now removed** (commit `eae035b`), which is the genuinely low-risk part of this
finding. With it gone, `parseChapterList` and `scrapeUrl` compute the id with the *same* expression.

**What remains, and why it is still not urgent.** The duplication itself is real: the regex, the title-cleanup
chain (`/^Baca\s+/`, `/\s+Bahasa Indonesia$/`, `/\s+Terbaru$/`) and the id extraction are written out twice. Now
that both copies are provably equivalent, consolidating them is a **behaviour-preserving** change needing no
migration — but it is a dedup, not one of the three sanctioned low-risk categories (inline-URL move, explicit
timeout, log-shape unification), so it is left alone rather than bundled into a fix round.

**Sequencing.** If deduped, do it as its own commit with the fixture suite as the safety net. A test asserting
id equality across both paths for trailing-slash hrefs is still worth adding, because the reason the two copies
*looked* divergent is that nobody could tell they were not — the test makes that verifiable instead of argued.

### 2.3 `this`-dependent methods in shinigami and webtoon

`shinigami/index.ts:171` and `webtoon/index.ts:305, 306, 354` call sibling methods through `this`.
`thrive/index.ts:74-76` carries an explicit comment that it moved `fetchDetail` to a closure precisely because
detached invocation (`const d = adapter.getSeriesDetail; d()`) drops `this` and that was recorded as a
healthCheck failure.

**Why it is not low risk.** Today every call site goes through the adapter object, so `this` binds. The hazard
is latent, not active. Converting to closures is behaviour-preserving *given current call sites* and
behaviour-breaking if any caller ever destructures — so the fix is only safe together with a test that pins
both invocation styles, which does not exist today.

**Sequencing.** Add the detached-invocation test first (cheap, no behaviour change), then convert.

### 2.4 robots.txt KV cache is dead code in all six adapters

Every `fetchRobots` implementation writes a 24h KV entry (`expirationTtl: 86400`) — but every call site passes
`null` for the KV handle: `komiku/index.ts:343`, `bacakomik/index.ts:243`, `thrive/index.ts:217`,
`manhwaindo/index.ts:238`, `shinigami/index.ts:176`. `webtoon/client.ts:105` does not accept a KV parameter
at all. Net effect: the cache never engages and robots.txt is refetched from upstream on every `checkRobots`
call, which is the opposite of what the code reads like.

**Why it is not low risk.** `checkRobots?(url: string): Promise<RobotsResult>` in `packages/sources/index.ts`
takes no environment handle, so there is nowhere to get a KV namespace from. Threading `env` through requires
changing that interface — and `packages/sources/index.ts` is owned by Task 2/3 and out of this task's scope.

**Sequencing.** Raise with the Task 2/3 owner, or land it as part of whatever change next touches the
`SourceAdapter` interface. Do not work around it inside an adapter.

### 2.5 `RobotsResult` / `isPathAllowed` / `fetchRobots` are duplicated five-and-a-half times

Byte-comparable copies across `komiku`, `bacakomik`, `thrive`, `manhwaindo`, `shinigami`, `webtoon` client.ts
files (~35 lines each), differing only in the base URL and cache key. `webtoon`'s `fetchRobots` also has a
different signature (no KV parameter), so the copies have already begun to diverge.

**Why it is not low risk** — and why it is still not urgent. The move itself is mechanical, but a shared
`fetchRobots` has to pick one cache-key namespace and one signature, and that decision interacts with §2.4
(the dead cache). Fixing the duplication and fixing the cache are the same piece of work; doing the dedup first
just relocates the dead code into a shared module where it looks more deliberate.

**Sequencing.** Fold into §2.4, once the interface question is answered.

---

## 3. Lower-severity notes (no action taken, not worth a commit on their own)

- **`packages/sources/index.ts:43-47` carries five `as unknown as SourceAdapter` casts that are not needed.**
  Verified: a scratch file assigning each of the six adapters directly to `SourceAdapter` typechecks clean under
  `tsc --noEmit`. The casts suppress real type checking for no reason. `packages/sources/index.ts` is owned by
  Task 2/3 and explicitly out of scope here — flagged, not touched. Removing them is zero-behaviour-change.
- **`packages/sources/index.ts` is clean** with respect to this audit's checklist: no inline upstream URLs, no
  parsing rules, no secrets. Recorded because the brief asked it to be checked and the answer is "nothing to do".
- **`fetchRobots(null)` also means `checkRobots` is uncached across all six** — see §2.4; no separate action.
- **Duplicated chapter-mapping closures.** `thrive/index.ts` repeats the same `chapterlist.map(...)` in
  `listChapters` (153), `getSeriesDetail` (170), `scrapeUrl` (203) and the fixture helper (261). Output is
  identical today, so this is not a correctness issue, but it is four copies that must be edited together if the
  mapping ever changes. A `toChapters()` helper would be the obvious fix; it was skipped because it is not a
  "move an inline rule into the per-source module" change — the rule is already in the right file.
- **`komiku/index.ts:196`** has anomalous 11-space indentation inside the cover-fallback block, inconsistent with
  the parallel block at line 246. Cosmetic; left alone to keep the fix diffs minimal.
- **Orphaned test files — suites that exist but never run.** `packages/sources/test/` holds 9 `.mjs` files while
  the `test` script invokes 6, so **`shinigami.test.mjs`, `single-fetch.test.mjs` and `status.test.mjs` are never
  executed**. `packages/db/test/` holds 7 while its script invokes 2, orphaning five. This matters more than a
  stray count usually would: `shinigami` is one of the six audited adapters and it carries the §2.3 `this`-
  dependency finding, so the one adapter with a known latent hazard is the one with **zero** executed coverage.
  `single-fetch` and `status` plausibly guard the `getSeriesDetail` single-fetch contract and `mapStatusText`
  respectively, both production parsing behaviour.
  **Not fixed here** — the fix means editing `package.json` test scripts, which is reviewed territory and outside
  this task's scope. Flagged for whoever owns the test scripts. Until then, treat the "51/51 sources passing"
  baseline as **6 files, not 9**.

---

## 4. Confirmed-clean (recorded so the next audit does not re-check it)

- **Timeouts.** Every `fetch(...)` and `page.goto(...)` across all six adapters and their clients already carries
  an explicit `AbortSignal.timeout(...)` or a `timeout:` option. Verified by scanning each call site; there were
  zero unqualified calls. There is nothing to make explicit.
- **Secrets.** No literal API key, token, password, or bearer value in any adapter or in `apps/api-cf/src/lib/`.
  The hardcoded URLs in `apps/api-cf/src/lib/` are all third-party service origins that belong where they are
  (`turnstile.ts:15` Cloudflare, `adminInventory.ts:14,17` Cloudflare + Backblaze).
- **SQL interpolation.** No template-literal or `+`-concatenated SQL anywhere in `apps/api-cf/src/lib/` or
  `apps/api-cf/src/routes/`. All statements are parameterised via `.bind(...)`.
- **`SourceAdapter` conformance.** All six manga adapters satisfy the interface without casts (see §3).
- **Log shape.** The `{ source, entityId, stage, error }` shape is defined in `packages/sources/novel.ts:100` and
  used by the novel adapters. The six manga adapters emit **no** `console.*` calls at all — they throw, and the
  caller logs. There is consequently nothing in this territory to unify to the four-key shape. The
  `console.*` lines in `apps/api-cf/src/lib/` (`peers.ts`, `serviceGate.ts`, `storageEviction.ts`, `dbWrite.ts`)
  are config/topology/gate/eviction events with no `source` and no `entityId`; forcing the scrape-log shape onto
  them would be a category error, not a unification.
