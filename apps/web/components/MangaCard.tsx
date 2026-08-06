import Link from 'next/link';
import { SourceBadge } from './SourceBadge';

export function MangaCard({ manga, source = 'mangadex', sources }: { manga: { id: string; title: string; cover: string | null; slug: string }; source?: string; sources?: string[] }) {
  return (
    <Link href={`/${source}/s/${manga.slug}?id=${manga.id}`} className="group block">
      <div className="aspect-[3/4] w-full overflow-hidden rounded border border-subtle bg-card">
        {manga.cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={manga.cover} alt={manga.title} loading="lazy" className="h-full w-full object-cover transition-opacity duration-300" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted text-xs p-2 text-center">{manga.title}</div>
        )}
      </div>
      <div className="mt-2">
        <div className="text-sm text-primary line-clamp-2 group-hover:text-accent">{manga.title}</div>
        {sources && sources.length > 0 && <SourceBadge sources={sources} />}
      </div>
    </Link>
  );
}
