// Source badge: icon-only. No text label — accessibility via title/alt.
// Icons are local static assets in /sources/ (favicons per source).

export type SourceKey = 'komiku' | 'bacakomik' | 'thrive' | 'manhwaindo' | 'shinigami' | 'webtoon';

export const SOURCE_ORDER: SourceKey[] = ['komiku', 'bacakomik', 'thrive', 'manhwaindo', 'shinigami', 'webtoon'];

const SOURCE_ICONS: Record<string, string> = {
  komiku: '/sources/komiku.png',
  bacakomik: '/sources/bacakomik.jpg', // file asli JPEG — extension harus cocok
  thrive: '/sources/thrive.png',
  manhwaindo: '/sources/manhwaindo.png',
  shinigami: '/sources/shinigami.png',
  webtoon: '/sources/webtoon.png',
};

export const SOURCE_LABELS: Record<string, string> = {
  komiku: 'Komiku',
  bacakomik: 'BacaKomik',
  thrive: 'Thrive',
  manhwaindo: 'ManhwaIndo',
  shinigami: 'Shinigami',
  webtoon: 'Webtoon',
};

// `primary` = source yang sedang dipakai halaman ini. Ditampilkan paling kiri
// dengan ring accent supaya badge landing/detail/reader terbaca sama: set
// sumber identik, yang beda hanya mana yang aktif.
export function SourceBadge({ sources, size = 'sm', primary }: { sources?: string[]; size?: 'sm' | 'md'; primary?: string | null }) {
  if (!sources || sources.length === 0) return null;
  const dim = size === 'md' ? 'h-6 w-6' : 'h-4 w-4';
  const stable: string[] = SOURCE_ORDER.filter((s) => sources.includes(s));
  const ordered = primary && stable.some((s) => s === primary)
    ? [primary, ...stable.filter((s) => s !== primary)]
    : stable;
  const shown = ordered.slice(0, 3);
  const overflow = ordered.length - shown.length;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {shown.map((s) => (
        <span
          key={s}
          title={`${SOURCE_LABELS[s] ?? s}${s === primary ? ' (aktif)' : ''}`}
          className={`${dim} inline-block overflow-hidden rounded-full bg-white/5 shrink-0 ${
            s === primary ? 'ring-2 ring-accent' : 'ring-1 ring-white/15'
          }`}
        >
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

export default SourceBadge;
