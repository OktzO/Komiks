import { CanonicalReader } from '../../../_shared/CanonicalReader';

export default async function ManhuaChapter({ params }: { params: Promise<{ slug: string; chapterId: string }> }) {
  const { slug, chapterId } = await params;
  return <CanonicalReader type="manhua" slug={slug} chapterId={chapterId} />;
}
