/*
  Keys PUBLIC_* ter-expose ke client (import.meta.env), sisanya server-only
  (dipakai SSR fetch — tidak pernah bocor ke browser bundle).
  PUBLIC_API_URL kosong saat build-time tidak masalah: nilai di-set di
  dashboard Cloudflare Pages (production env), dev fallback localhost:8787.
*/
