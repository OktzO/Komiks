import { SourceSwitcher } from '@/components/SourceSwitcher';
import { API_URL, getMangaSources } from '@/lib/api';

export async function SourceSection({ slug, canonicalSlug, sourcesPromise, source, sourceSlug, type }: {
  slug: string;
  canonicalSlug: string;
  sourcesPromise: Promise<Awaited<ReturnType<typeof getMangaSources>> | null>;
  source: string;
  sourceSlug: string;
  type: string;
}) {
  const srcs = await sourcesPromise;
  if (!srcs || srcs.sources.length <= 1) return null;
  const total = srcs.sources.reduce((m, l) => Math.max(m, l.chapterCount ?? 0), 0);
  return (
    <section>
      <p className="text-xs text-muted mb-2">{srcs.sources.length} sumber · terbanyak {total} chapter</p>
      <SourceSwitcher currentSource={source} sourceId={sourceSlug} canonicalSlug={canonicalSlug} chapterNumber={0} apiUrl={API_URL} mode="detail" links={srcs.sources} recommendedSource={srcs.recommendedSource} />
    </section>
  );
}
