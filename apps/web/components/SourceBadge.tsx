// Source badge: icon-only. No text label — accessibility via title/alt.
// Icons are local static assets in /public/sources/ (favicons per source).

export type SourceKey = 'komiku' | 'bacakomik' | 'thrive' | 'manhwaindo';

export const SOURCE_ORDER: SourceKey[] = ['komiku', 'bacakomik', 'thrive', 'manhwaindo'];

const SOURCE_ICONS: Record<string, string> = {
  komiku: '/sources/komiku.png',
  bacakomik: '/sources/bacakomik.png',
  thrive: '/sources/thrive.png',
  manhwaindo: '/sources/manhwaindo.png',
};

export const SOURCE_LABELS: Record<string, string> = {
  komiku: 'Komiku',
  bacakomik: 'BacaKomik',
  thrive: 'Thrive',
  manhwaindo: 'ManhwaIndo',
};

export function SourceBadge({ sources, size = 'sm' }: { sources?: string[]; size?: 'sm' | 'md' }) {
  if (!sources || sources.length === 0) return null;
  const dim = size === 'md' ? 'h-6 w-6' : 'h-4 w-4';
  const ordered = SOURCE_ORDER.filter((s) => sources.includes(s));
  const shown = ordered.slice(0, 3);
  const overflow = ordered.length - shown.length;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {shown.map((s) => (
        <span
          key={s}
          title={SOURCE_LABELS[s] ?? s}
          className={`${dim} inline-block overflow-hidden rounded-full ring-1 ring-white/15 bg-white/5 shrink-0`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={SOURCE_ICONS[s]} alt={SOURCE_LABELS[s] ?? s} className="h-full w-full object-cover" loading="lazy" />
        </span>
      ))}
      {overflow > 0 && (
        <span title={`+${overflow} sumber lagi`} className={`${dim} inline-flex items-center justify-center rounded-full bg-bg-secondary text-[10px] text-secondary ring-1 ring-white/15`}>
          +{overflow}
        </span>
      )}
    </span>
  );
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}