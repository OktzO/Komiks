import { ChapterList } from '@/components/ChapterList';
import { getChapters, getMangaSources } from '@/lib/api';

export async function ChapterSection({ slug, canonicalSlug, chaptersPromise, sourcesPromise, source, sourceSlug }: {
  slug: string;
  canonicalSlug: string;
  chaptersPromise: Promise<Awaited<ReturnType<typeof getChapters>>>;
  sourcesPromise: Promise<Awaited<ReturnType<typeof getMangaSources>> | null>;
  source: string;
  sourceSlug: string;
}) {
  const [chapters, srcs] = await Promise.all([chaptersPromise, sourcesPromise]);
  let list = chapters;
  let notice: string | null = null;
  const rec = srcs?.recommendedSource;
  if (rec && rec !== source) {
    const target = srcs!.sources.find((l) => l.source === rec);
    if (target?.hasChapterList) {
      const alt = await getChapters(rec, target.sourceSlug, 'id').catch(() => null);
      if (alt && alt.length > list.length) {
        list = alt;
        notice = `Menampilkan dari ${rec} — chapter terbanyak (${alt.length}).`;
      }
    }
  }
  if (list.length === 0) return <div className="text-secondary text-sm">Chapter belum tersedia — coba lagi nanti.</div>;
  return (
    <section>
      {notice && <p className="text-xs text-muted mb-2">{notice}</p>}
      <ChapterList chapters={list} source={rec ?? source} slug={canonicalSlug} />
    </section>
  );
}
