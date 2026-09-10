import Link from 'next/link';
import { safeType, typedUrl } from '@/lib/api';
import { SourceBadge } from './SourceBadge';
import { CoverImage } from './CoverImage';
import { TypeBadge } from './TypeBadge';

export function MangaCard({
  manga,
  sources,
  status,
  type,
}: {
  manga: { id: string; title: string; cover: string | null; slug: string };
  source?: string;
  sources?: string[];
  status?: string | null;
  type?: string | null;
}) {
  return (
    <Link href={typedUrl(safeType(type), manga.slug)} prefetch={false} className="group block">
      <div className="aspect-[3/4] w-full overflow-hidden rounded border border-subtle bg-card relative">
        <CoverImage src={manga.cover} alt={manga.title} title={manga.title} className="h-full w-full" zoom />
        <div className="absolute top-1.5 left-1.5 z-10">
          {sources && sources.length > 0 && <SourceBadge sources={sources} size="sm" />}
        </div>
        <div className="absolute bottom-1.5 left-1.5 z-10">
          <TypeBadge type={type ?? status} />
        </div>
      </div>
      <div className="mt-2">
        <div className="text-sm text-primary line-clamp-2 group-hover:text-accent">{manga.title}</div>
      </div>
    </Link>
  );
}
