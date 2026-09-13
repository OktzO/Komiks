import { safeType, typedUrl } from '@/lib/api';
import { CoverImage } from './CoverImage';
import { TypeBadge } from './TypeBadge';
import { SourceBadge } from './SourceBadge';

interface MangaItem {
  id: string;
  slug: string;
  title: string;
  cover_image?: string | null;
  cover?: string | null;
  source: string;
  sources?: string[];
  type?: string | null;
  status?: string | null;
  description?: string | null;
  popularity?: number;
}

interface BentoGridProps {
  items: any[];
}

const itemOf = (m: any): MangaItem => {
  const data = m.data ?? m;
  return {
    ...data,
    cover_image: data.cover_image || data.cover,
    sources: (m.sources as string[]) || (data.sources as string[]) || [data.source || 'komiku'],
  };
};

export function BentoGrid({ items }: BentoGridProps) {
  if (!items || items.length < 5) return null;

  const normalized = items.slice(0, 5).map(itemOf);
  const featured = normalized[0];
  const sideItems = normalized.slice(1, 5);

  return (
    <section className="mb-14">
      <div className="flex items-baseline justify-between mb-5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted">★ Pilihan Redaksi</span>
        </div>
        <a href="/search?sort=popular" className="text-xs sm:text-sm text-secondary hover:text-accent transition-colors">
          Lihat top rating →
        </a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Main Large Bento Item (7 Cols on desktop) */}
        <div className="lg:col-span-7">
          <a
            href={typedUrl(safeType(featured.type), featured.slug)}
            className="group block h-full bento-featured-card relative min-h-[320px] sm:min-h-[380px] p-6 flex flex-col justify-end"
          >
            {/* Background Cover Image with heavy gradient mask */}
            <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
              {featured.cover_image && (
                <img
                  src={featured.cover_image}
                  alt=""
                  className="w-full h-full object-cover opacity-25 filter blur-xl scale-110 transition-transform duration-700 group-hover:scale-125"
                  loading="lazy" referrerpolicy="no-referrer"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-bg-base via-bg-base/80 to-transparent" />
            </div>

            {/* Content Foreground */}
            <div className="relative z-10 flex flex-col sm:flex-row gap-5 items-start sm:items-end">
              <div className="w-28 sm:w-36 aspect-[3/4] shrink-0 rounded-lg overflow-hidden border border-border-default shadow-2xl bg-card">
                <CoverImage
                  src={featured.cover_image || null}
                  alt={featured.title}
                  title={featured.title}
                  className="h-full w-full"
                  zoom
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="bg-accent/15 text-accent border border-accent/30 text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded-full">
                    Trending #1
                  </span>
                  <TypeBadge type={featured.type} />
                  <SourceBadge sources={featured.sources} size="sm" />
                </div>

                <h3 className="font-display text-xl sm:text-2xl lg:text-3xl text-primary font-semibold tracking-tight leading-tight group-hover:text-accent transition-colors line-clamp-2 mb-2">
                  {featured.title}
                </h3>

                {featured.description && (
                  <p className="text-xs sm:text-sm text-secondary line-clamp-2 mb-4 leading-relaxed max-w-xl">
                    {featured.description}
                  </p>
                )}

                <div className="inline-flex items-center gap-2 text-xs font-medium text-primary bg-white/10 hover:bg-white/20 border border-white/15 px-4 py-2 rounded-full transition-all">
                  <span>Mulai Membaca</span>
                  <span className="font-mono text-muted group-hover:translate-x-1 transition-transform">→</span>
                </div>
              </div>
            </div>
          </a>
        </div>

        {/* 4 Secondary Bento Items (5 Cols on desktop, 2x2 grid) */}
        <div className="lg:col-span-5 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {sideItems.map((item, idx) => {
            return (
              <a
                key={`${item.source}-${item.slug}`}
                href={typedUrl(safeType(item.type), item.slug)}
                className="group bento-card p-3.5 flex flex-col justify-between"
              >
                <div className="flex gap-3">
                  <div className="w-16 h-22 shrink-0 aspect-[3/4] overflow-hidden rounded border border-border-subtle bg-bg-secondary">
                    <CoverImage
                      src={item.cover_image || null}
                      alt={item.title}
                      title={item.title}
                      className="h-full w-full"
                      zoom
                    />
                  </div>
                  <div className="min-w-0 flex-1 flex flex-col justify-between py-0.5">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[10px] font-mono text-muted">#{idx + 2}</span>
                        <TypeBadge type={item.type} />
                      </div>
                      <h4 className="text-xs sm:text-sm font-medium text-primary group-hover:text-accent transition-colors line-clamp-2 leading-snug">
                        {item.title}
                      </h4>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <SourceBadge sources={item.sources} size="sm" />
                      <span className="text-[11px] font-mono text-muted group-hover:text-primary transition-colors">
                        Buka →
                      </span>
                    </div>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default BentoGrid;
