# Design: B2 Storage Expansion (akun 3 & 4) + CF akun-4 + Region Fix

Date: 2026-08-16
Status: Approved (user: "kau atur aja sendiri" / "aktifkan sekarang" / "lanjutkan, add juga & taruh di env")

## Objective

Expand image storage from 2 B2 accounts to 4, register CF akun-3 worker as live LB origin, add CF akun-4 credentials to env, and correct the stale Boltz bucket region that would break uploads.

## Current State (verified)

### B2 accounts
| # | keyName | keyId | bucket | region (SigV4 probe) | auth |
|---|---------|-------|--------|----------------------|------|
| 1 | Kom | `005336d7589ff330000000003` (appKey `K0058cx...`) | `manga-oktz-assets` | `us-east-005` (200) | ✓ |
| 2 | Boltz | `005b86aeb2be76b0000000005` (appKey `K005Q1/...`) | `manga-oktz-assets-2` | `us-east-005` (200) — **.dev.vars said eu-central-003, wrong** | ✓ |
| 3 | Kom (new) | `0043b500e7326f40000000001` (appKey `K00<REDACTED>`, api004) | `manga-images-kom` (new, allPrivate) | `us-west-004` (200) | ✓ |
| 4 | Manga (new) | `005e0a76e4467490000000001` (appKey `K00<REDACTED>`, api005) | `manga-images-akun4` (new, allPrivate) | `us-east-005` (200) | ✓ |

Notes:
- `b2_create_bucket` supports **no `region` field** (`unknown field ...: region`) — bucket default region = account region (api004 → us-west-004, api005 → us-east-005).
- Public buckets (`allPublic`) on akun-4 → `no_payment_history` (401). Private buckets work — reads use `b2PresignedGet` (SigV4) in `s3Upload.ts`, so private is fully compatible.
- Names are globally unique in B2: `manga-images` exists elsewhere; `manga-images-manga` was held by a straggler bucket on akun-3 (deleted), then still claimed → used `manga-images-akun4` instead.
- Bucket names: akun-1/2 are `manga-oktz-assets` / `manga-oktz-assets-2` (NOT `manga-images` as in old docs/.dev.vars — .dev.vars is stale).

### CF accounts
| # | email | account_id | token (.env) |
|---|-------|-----------|-------------|
| 1 | oktzoffc@gmail.com | `4ce21aec2dd478bf380b7b59990a9165` | `cfut_<REDACTED>` |
| 2 | tzok5555@gmail.com | `6a0bdfb8bccff744bd738a57502d0380` | `cfut_<REDACTED>` |
| 3 | dwikaoktyffan@gmail.com | `ddc6f3527032c6e929fddb587f438ca4` | `cfut_<REDACTED>` |
| 4 | **Oktznih@outlook.com** (new) | `9befea142865276dab131815c729cd8f` | `cfut_<REDACTED>` (provided 2026-08-16) |

- The `cfut_` key provided by user is a **Cloudflare API token, not a B2 key** (verified: B2 authorize fails in both positions; CF accounts API returns SUCCESS with account id `9befea14...`). All 3 legacy CF tokens also start `cfut_`. B2 app keys look like `K00...`. Stored as CF akun-4; exact role TBD (candidate for a future 4th worker / origin).
- CF akun-3 worker (`manga-api-3.dwikaoktyffan.workers.dev`) is deployed & healthy but **not yet in `lb_origins`** (only ori_main + ori_tzok5555 registered; loader `/api/origins` returns 2 origins).

## Design

### 1. B2 config JSON (secret `B2_ACCOUNTS` on all 3 workers)
Order = hash-pick index `[-1, -2, ...]`. Dedup by keyId in `resolveB2Accounts` (B2_CONFIG first, then B2_ACCOUNTS). We keep **single source of truth: `B2_ACCOUNTS` with all 4 entries**, `B2_CONFIG` left as legacy Kom entry (consistent with B2_ACCOUNTS[0]).

```json
[
  {"name":"kom","bucket":"manga-oktz-assets","keyId":"005336d7589ff330000000003","appKey":"K00<REDACTED>","region":"us-east-005","host":"s3.us-east-005.backblazeb2.com"},
  {"name":"boltz","bucket":"manga-oktz-assets-2","keyId":"005b86aeb2be76b0000000005","appKey":"K00<REDACTED>","region":"us-east-005","host":"s3.us-east-005.backblazeb2.com"},
  {"name":"kom-3","bucket":"manga-images-kom","keyId":"0043b500e7326f40000000001","appKey":"K00<REDACTED>","region":"us-west-004","host":"s3.us-west-004.backblazeb2.com"},
  {"name":"manga-4","bucket":"manga-images-akun4","keyId":"005e0a76e4467490000000001","appKey":"K00<REDACTED>","region":"us-east-005","host":"s3.us-east-005.backblazeb2.com"}
]
```

Boltz region fix is a **real bug fix**: SigV4 probe shows bucket `manga-oktz-assets-2` answers only under `us-east-005`; with `eu-central-003` in config, every Boltz upload would fail signature validation.

### 2. .env additions (root)
```env
# akun-4: Oktznih@outlook.com
CF_TOKEN_AKUN4=cfut_<REDACTED>
CF_ACCOUNT_ID_AKUN4=9befea142865276dab131815c729cd8f

# akun B2 ke-3
B2_KEY_ID_3=0043b500e7326f40000000001
B2_KEY_NAME_3=Kom
B2_APP_KEY_3=K00<REDACTED>

# akun B2 ke-4
B2_KEY_ID_4=005e0a76e4467490000000001
B2_KEY_NAME_4=Manga
B2_APP_KEY_4=K00<REDACTED>
```

### 3. Secret sync to all 3 workers
`wrangler secret put B2_ACCOUNTS` (config files: `wrangler.toml` akun-1, `wrangler.origin.toml` akun-2, `wrangler.origin3.toml` akun-3) using per-account CF tokens (as in `scripts/sync-secrets.sh`). Keep `B2_CONFIG` unchanged. No code change → no deploy needed for storage; secrets apply at next request.

### 4. Origin registration akun-3
Insert `lb_origins` row for `manga-api-3.dwikaoktyffan.workers.dev` (priority 2, pattern `ori_akun3`), verify CORS/`ALLOWED_ORIGINS` already include it (PEER_URLS does), then check `/api/origins` lists 3 origins.

### 5. Verification
- SigV4 PUT probe (`probe-<ts>.txt`) against `manga-images-kom` (us-west-004) & `manga-images-akun4` (us-east-005) then DELETE; ensures keys can write privately.
- After secret sync: `curl /api/health` on akun-2/3 + upload a chapter image via worker path (scrape/identify) to confirm hash-pick over 4 accounts doesn't 400.
- Origin: `/api/origins` returns 3 entries.

## Non-goals
- Do NOT create public buckets on akun-4 (payment history missing).
- Do NOT rename existing buckets.
- CF akun-4 role (new worker / origin / unused) — decision deferred, credentials stored.