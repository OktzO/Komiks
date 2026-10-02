import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

// Tailwind via PostCSS (tailwind.config.ts + postcss.config.mjs) — Tanpa
// @astrojs/tailwind (deprecated utk Astro 7). Kompat config v3 existing.
export default defineConfig({
  output: 'server',
  site: 'https://oktzz.xyz',
  // Prefetch link saat hover/viewport → navigasi terasa instan (skeleton
  // + view transitions menutup gap sisanya).
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  adapter: cloudflare({
    imageService: 'passthrough',
  }),
  integrations: [react()],
  // The stylesheet is one 14 KB file and it blocks the first paint. Inlining it
  // into <head> deletes that round trip; the bytes ride along with the HTML the
  // browser is already downloading.
  build: { inlineStylesheets: 'always' },
  vite: {
    css: {
      postcss: './postcss.config.mjs',
    },
    ssr: {
      external: ['@manga-platform/shared'],
    },
  },
});
