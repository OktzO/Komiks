#!/usr/bin/env bash
# Deploy worker via raw CF REST API (fallback when wrangler CLI token is account-scoped)
# Usage: CF_API_TOKEN=xxx ./scripts/deploy-worker-api.sh [akun1|akun2]
set -euo pipefail

ENV="${1:-akun1}"

if [ "$ENV" = "akun1" ]; then
  export CF_API_TOKEN="***REMOVED***"
  ACCT="4ce21aec2dd478bf380b7b59990a9165"
  DB="76606365-0fa5-4c1e-9b55-18a8366ef92a"
  KV="6205fceab7b64f9d80f6f67e4189316b"
  NAME="manga-api"
elif [ "$ENV" = "akun2" ]; then
  export CF_API_TOKEN="***REMOVED***"
  ACCT="6a0bdfb8bccff744bd738a57502d0380"
  DB="(set via origin DB id)"
  KV="(origin KV id)"
  NAME="manga-api-2"
else
  echo "Usage: $0 [akun1|akun2]" >&2
  exit 1
fi

BUNDLE="/tmp/manga-api-worker.js"
echo "[$ENV] building ESM bundle..."
npx esbuild apps/api-cf/src/index.ts \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --tsconfig=apps/api-cf/tsconfig.json \
  --outfile="$BUNDLE"

echo "[$ENV] deploying via CF API (requires Workers Scripts:Edit token)..."
# NOTE: token must have Workers Scripts:Edit scope — account-scoped tokens
# cannot deploy via wrangler or PUT /scripts endpoint.
npx wrangler deploy --config apps/api-cf/wrangler.toml --env "$ENV"

echo "[$ENV] deploy attempted."
