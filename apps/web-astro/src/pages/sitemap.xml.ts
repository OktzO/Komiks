import type { APIRoute } from 'astro';
import { API_URL } from '@/lib/api';

export const prerender = false;

const SITE = 'https://oktzz.xyz';

// CDN cache 1 jam (≈ Next.js revalidate: 3600) — lama fresh sama, tapi via
// Cloudflare edge cache, bukan ISR build.
export const GET: APIRoute = async () => {
  const staticEntries = [
    { url: `${SITE}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE}/search`, changeFrequency: 'daily', priority: 0.5 },
    { url: `${SITE}/login`, changeFrequency: 'monthly', priority: 0.3 },
  ];

  let seriesEntries: Array<{ url: string; lastModified?: string; changeFrequency: string; priority: number }> = [];
  try {
    const res = await fetch(`${API_URL}/api/series?limit=200`, {
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const items: { slug: string; source: string; type?: string; updated_at?: number }[] = await res.json();
      seriesEntries = items.map((s) => ({
        url: `${SITE}/${s.type ?? 'manga'}/${s.slug}`,
        lastModified: s.updated_at ? new Date(s.updated_at * 1000).toISOString() : undefined,
        changeFrequency: 'weekly',
        priority: 0.7,
      }));
    }
  } catch {
    // sitemap gracefully degraded — static entries only
  }

  const entries = [...staticEntries, ...seriesEntries];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url>
    <loc>${e.url}</loc>
    ${'lastModified' in e && e.lastModified ? `<lastmod>${e.lastModified}</lastmod>` : ''}
    <changefreq>${e.changeFrequency}</changefreq>
    <priority>${e.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600',
    },
  });
};
