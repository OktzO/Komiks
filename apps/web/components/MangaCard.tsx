import Link from 'next/link';
import { SourceBadge } from './SourceBadge';
import { CoverImage } from './CoverImage';

export function MangaCard({ manga, source = 'komiku', sources, status }: { manga: { id: string; title: string; cover: string | null; slug: string }; source?: string; sources?: string[]; status?: string | null }) {
  return (
    <Link href={`/${source}/s/${manga.slug}?id=${manga.id}`} prefetch={false} className="group block">
      <div className="aspect-[3/4] w-full overflow-hidden rounded border border-subtle bg-card">
        <CoverImage src={manga.cover} alt={manga.title} title={manga.title} className="h-full w-full" zoom />
      </div>
      <div className="mt-2">
        <div className="text-sm text-primary line-clamp-2 group-hover:text-accent">{manga.title}</div>
        {(status || (sources && sources.length > 0)) && (
          <div className="mt-1 flex items-center gap-2">
            {status && <span className="text-[11px] text-muted capitalize">{status}</span>}
            {sources && sources.length > 0 && <SourceBadge sources={sources} />}
          </div>
        )}
      </div>
    </Link>
  );
}