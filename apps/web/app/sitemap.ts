import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://oktzz.xyz';
const API = process.env.NEXT_PUBLIC_API_URL ?? 'https://manga-api.oktz.workers.dev';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE}/search`, changeFrequency: 'daily', priority: 0.5 },
    { url: `${SITE}/login`, changeFrequency: 'monthly', priority: 0.3 },
  ];

  let seriesEntries: MetadataRoute.Sitemap = [];
  try {
    const res = await fetch(`${API}/api/series?limit=200`, { next: { revalidate: 3600 } });
    if (res.ok) {
      const items: { slug: string; source: string; updated_at?: number }[] = await res.json();
      seriesEntries = items.map((s) => ({
        url: `${SITE}/${s.source}/s/${s.slug}`,
        lastModified: s.updated_at ? new Date(s.updated_at * 1000) : undefined,
        changeFrequency: 'weekly',
        priority: 0.7,
      }));
    }
  } catch {
    // sitemap gracefully degraded — static entries only
  }

  return [...staticEntries, ...seriesEntries];
}
