import { CanonicalReader } from '../../../_shared/CanonicalReader';

export default async function ManhwaChapter({ params }: { params: Promise<{ slug: string; chapterId: string }> }) {
  const { slug, chapterId } = await params;
  return <CanonicalReader type="manhwa" slug={slug} chapterId={chapterId} />;
}
