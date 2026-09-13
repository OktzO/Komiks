import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

// Tailwind via PostCSS (tailwind.config.ts + postcss.config.mjs) — Tanpa
// @astrojs/tailwind (deprecated utk Astro 7). Kompat config v3 existing.
export default defineConfig({
  output: 'server',
  site: 'https://oktzz.xyz',
  adapter: cloudflare({
    imageService: 'passthrough',
  }),
  integrations: [react()],
  vite: {
    css: {
      postcss: './postcss.config.mjs',
    },
    ssr: {
      external: ['@manga-platform/shared'],
    },
  },
});
