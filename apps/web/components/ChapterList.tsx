import Link from 'next/link';

export function ChapterList({ chapters, source, slug }: { chapters: { id: string; chapter_number: number; title?: string | null }[]; source: string; slug: string }) {
  return (
    <div className="divide-y divide-border-subtle border border-subtle rounded bg-card">
      {chapters.map((c) => {
        const rawId = c.id.includes(':') ? c.id.slice(c.id.lastIndexOf(':') + 1) : c.id;
        return (
          <Link key={c.id} href={`/${source}/s/${slug}/${rawId}?mangaId=${slug.split('--').pop()}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-elevated text-sm">
            <span className="text-primary">Ch. {c.chapter_number}{c.title ? ` — ${c.title}` : ''}</span>
            <span className="text-muted text-xs">Baca →</span>
          </Link>
        );
      })}
    </div>
  );
}
