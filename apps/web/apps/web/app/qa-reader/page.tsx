import { ReaderShell } from '@/components/ReaderShell';

const FAKE = Array.from({ length: 8 }, (_, i) => ({
  proxyUrl: `/fake/${i + 1}`,
  r2Url: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><rect width="100%" height="100%" fill="#1d1d1d"/><text x="50%" y="50%" fill="#888" font-size="60" text-anchor="middle">${i + 1}</text></svg>`)}`,
}));

export default function Qa() {
  return <ReaderShell source="komiku" slug="qa" chapterId="qa-chapter-1" chapterNumber={1} seriesTitle="QA Manga" pages={FAKE as any} apiUrl="http://localhost:2999" />;
}
