import { useEffect, useState } from 'react';
import { ChapterList } from '@/components/ChapterList';
import { getChapters, type Chapter } from '@/lib/api';

// ⭐ Async-first chapter section (pengganti streaming Suspense era Next.js):
// - initialChapters terisi (server fetch <= budget) → SSR HTML penuh, SEO link utuh.
// - initialChapters null (server kelewat budget) → skeleton shimmer tampil
//   instan, island fetch getChapters sendiri client-side lalu swap mulus.
// Hero/sinopsis/detail-info di page TIDAK menunggu ini — tampil duluan.
export function ChapterSection({
  initialChapters,
  source,
  sourceSlug,
  slug,
  type,
}: {
  initialChapters: Chapter[] | null;
  source: string;
  sourceSlug: string;
  slug: string;
  type: string;
}) {
  const [chapters, setChapters] = useState<Chapter[] | null>(initialChapters);
  const [loading, setLoading] = useState(initialChapters === null);

  useEffect(() => {
    if (initialChapters !== null || chapters !== null) return;
    let alive = true;
    getChapters(source, sourceSlug)
      .then((list) => { if (alive) { setChapters(list); setLoading(false); } })
      .catch(() => { if (alive) { setChapters([]); setLoading(false); } });
    return () => { alive = false; };
  }, [initialChapters, chapters, source, sourceSlug]);

  if (loading) {
    return (
      <div className="border border-border-default rounded-xl p-4" aria-busy="true" aria-label="Memuat daftar chapter">
        <div className="skeleton h-4 w-32 mb-3" />
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-10 w-full mb-2" />)}
      </div>
    );
  }

  if (!chapters || chapters.length === 0) {
    return <div className="text-secondary text-sm">Chapter belum tersedia — coba lagi nanti.</div>;
  }

  return (
    <section>
      <ChapterList chapters={chapters} source={source} slug={slug} type={type} />
    </section>
  );
}
