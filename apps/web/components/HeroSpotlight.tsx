import { SOURCE_ORDER, sourceLabel } from './SourceBadge';

export function HeroSpotlight() {
  return (
    <section className="relative overflow-hidden pt-12 pb-10 md:pt-20 md:pb-16 text-center">
      {/* Dynamic Ambient Background Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-32 mx-auto h-80 w-80 md:h-[450px] md:w-[650px] rounded-full radial-ambient opacity-80 blur-2xl"
      />

      <div className="relative z-10 max-w-4xl mx-auto px-4">
        {/* Top Tagline / Pill */}
        <div className="anim-rise inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass-pill mb-6">
          <span className="flex h-1.5 w-1.5 rounded-full bg-accent animate-ping" />
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-secondary">
            Katalog Komik Multi-Sumber
          </span>
        </div>

        {/* Main Headline */}
        <h1
          className="anim-rise font-display text-4xl sm:text-5xl md:text-7xl tracking-tight text-primary leading-[1.04] text-balance font-bold"
          style={{ animationDelay: '60ms' }}
        >
          Baca manga, manhwa,<br />
          <span className="text-secondary font-normal">dan manhua tanpa jeda.</span>
        </h1>

        {/* Subtitle */}
        <p
          className="anim-rise mt-5 text-sm sm:text-base md:text-lg text-secondary max-w-2xl mx-auto text-balance font-light leading-relaxed"
          style={{ animationDelay: '120ms' }}
        >
          Ribuan judul terjemahan Indonesia langsung dari 5 agregator independen. Ringan, cepat, bersih, dan tanpa iklan mengganggu.
        </p>

        {/* High-End Search Input */}
        <form
          action="/search"
          method="get"
          className="anim-rise mt-8 max-w-xl mx-auto"
          style={{ animationDelay: '180ms' }}
        >
          <div className="group relative flex items-center gap-2 rounded-full border border-border-default bg-card/75 px-4 py-2 sm:backdrop-blur-md shadow-lg transition-all focus-within:border-border-focus focus-within:ring-2 focus-within:ring-white/10 hover:border-border-default">
            <svg
              className="h-4 w-4 shrink-0 text-muted transition-colors group-focus-within:text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              name="q"
              type="search"
              placeholder="Cari judul, genre, atau kreator…"
              autoComplete="off"
              className="w-full bg-transparent text-sm sm:text-base text-primary placeholder:text-muted outline-none py-1.5"
            />
            <button
              type="submit"
              className="shrink-0 rounded-full bg-accent text-[color:var(--accent-ink)] px-5 py-1.5 text-xs sm:text-sm font-semibold hover:opacity-90 active:scale-95 transition-all shadow-sm"
            >
              Cari
            </button>
          </div>
        </form>

        {/* Feature & Social Proof Stats */}
        <div
          className="anim-rise mt-10 pt-6 border-t border-border-subtle/60 flex flex-wrap items-center justify-center gap-6 sm:gap-10 text-muted text-xs font-mono"
          style={{ animationDelay: '240ms' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-primary font-bold">5</span>
            <span>Sumber Terintegrasi</span>
          </div>
          <span className="h-3 w-px bg-border-subtle hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-primary font-bold">100%</span>
            <span>Bebas Pop-up Iklan</span>
          </div>
          <span className="h-3 w-px bg-border-subtle hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-primary font-bold">Edge CDN</span>
            <span>Akses Cepat & Stabil</span>
          </div>
        </div>
      </div>
    </section>
  );
}
