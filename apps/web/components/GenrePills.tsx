import Link from 'next/link';

export const POPULAR_GENRES = [
  { name: 'Action', label: 'Aksi', count: '5k+' },
  { name: 'Adventure', label: 'Petualangan', count: '3k+' },
  { name: 'Fantasy', label: 'Fantasi', count: '4k+' },
  { name: 'Isekai', label: 'Isekai', count: '2.5k+' },
  { name: 'Romance', label: 'Romansa', count: '2k+' },
  { name: 'Comedy', label: 'Komedi', count: '2.8k+' },
  { name: 'School Life', label: 'Sekolah', count: '1.5k+' },
  { name: 'Drama', label: 'Drama', count: '2.2k+' },
  { name: 'Horror', label: 'Horor', count: '900+' },
  { name: 'Sci-Fi', label: 'Sci-Fi', count: '1.2k+' },
  { name: 'Mystery', label: 'Misteri', count: '1.1k+' },
  { name: 'Slice of Life', label: 'Slice of Life', count: '1.8k+' },
];

export function GenrePills() {
  return (
    <section className="mb-14">
      <div className="flex items-center justify-between mb-3">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">Jelajah Kategori & Genre</p>
        <Link href="/search" prefetch={false} className="text-xs text-secondary hover:text-accent font-mono transition-colors">
          Filter Lanjutan →
        </Link>
      </div>

      <div
        className="flex gap-2.5 overflow-x-auto pb-2.5 snap-x"
        style={{ scrollbarWidth: 'thin' }}
        aria-label="Kategori Genre Komik"
      >
        {POPULAR_GENRES.map((g) => (
          <Link
            key={g.name}
            href={`/search?genre=${encodeURIComponent(g.name)}`}
            prefetch={false}
            className="group shrink-0 snap-start flex items-center gap-2 rounded-full border border-border-subtle bg-card/60 px-4 py-2 text-xs text-secondary hover:text-primary hover:border-border-default hover:bg-bg-secondary hover:scale-[1.02] transition-all"
          >
            <span className="font-medium">{g.name}</span>
            <span className="text-[10px] font-mono text-muted group-hover:text-secondary transition-colors">
              {g.count}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
