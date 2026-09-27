/*
  Keys PUBLIC_* ter-expose ke client (import.meta.env), sisanya server-only
  (dipakai SSR fetch — tidak pernah bocor ke browser bundle).
  PUBLIC_API_URL kosong saat build-time tidak masalah: nilai di-set di
  dashboard Cloudflare Pages (production env), dev fallback localhost:8787.
*/

// Astro v7 + @astrojs/cloudflare v14: runtime env binding (worker),
// pengganti locals.runtime.env (di-remove sejak Astro v6).
declare module "cloudflare:workers" {
  export const env: Record<string, string | undefined>;
}
