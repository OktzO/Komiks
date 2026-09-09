import { CanonicalReader } from '../../../_shared/CanonicalReader';

export default async function MangaChapter({ params }: { params: Promise<{ slug: string; chapterId: string }> }) {
  const { slug, chapterId } = await params;
  return <CanonicalReader type="manga" slug={slug} chapterId={chapterId} />;
}
