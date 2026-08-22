import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";

// ISR (revalidate) butuh persistent cache lintas isolate — default "dummy"
// cache render ulang tiap request. Pakai KV incremental cache (binding
// NEXT_INC_CACHE_KV) supaya page yang sudah di-render diserve dari KV tanpa
// invoke web Worker lagi. Pembuatan KV namespace: lihat docs/DEPLOY.md.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
});
