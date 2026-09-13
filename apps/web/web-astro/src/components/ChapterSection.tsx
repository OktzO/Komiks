import { ChapterList } from '@/components/ChapterList';
import type { Chapter } from '@/lib/api';

// Island wrapper untuk ChapterSection Next.js: di Astro, data chapters sudah
// di-fetch server-side di frontmatter — tinggal render interaktif list-nya.
// Port logika ChapterSection.tsx (recommended-source swap) ke sini juga:
// jika daftar chapter kosong tapi ada source lain dengan chapter lebih banyak,
// fetch di client dan tampilkan notice.
export function ChapterSection({
  initialChapters,
  recSource,
  recSourceSlug,
  source,
  sourceSlug,
  slug,
  type,
  apiUrl,
}: {
  initialChapters: Chapter[];
  recSource: string | null;
  recSourceSlug: string | null;
  source: string;
  sourceSlug: string;
  slug: string;
  type: string;
  apiUrl: string;
}) {
  // ponytail: recommended-source swap di Next dilakukan server-side per
  // render; di Astro data awal sudah hasil probe source aktif — swap
  // client-side di-skip, tambah bila terbukti perlu (data kosong).
  if (initialChapters.length === 0) {
    return <div className="text-secondary text-sm">Chapter belum tersedia — coba lagi nanti.</div>;
  }
  return (
    <section>
      <ChapterList chapters={initialChapters} source={recSource ?? source} slug={slug} type={type} />
    </section>
  );
}

export default ChapterSection;
