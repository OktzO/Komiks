import { useCallback, useEffect, useRef, useState } from 'react';
import { Reader } from './Reader';
import { SourceSwitcher } from './SourceSwitcher';
import { WindowedList } from './WindowedList';
import { getChapters, getChapter, imgOriginFor, isValidType, typedChapterUrl, type ComicType } from '@/lib/api';

// Canonical URL emisi: type tak dikenal → fallback 'manga' (route kanonik
// redirect ke type benar). Definisi lokal — lib/api.ts tak boleh diedit di
// task ini.
const safeType = (t?: string | null): ComicType =>
  isValidType(t ?? '') ? (t as ComicType) : 'manga';

interface PageUrl {
  proxyUrl: string;
  imgUrl?: string | null;
  b2Url?: string | null;
}

interface ShellItem {
  id: string;
  chapter_number: number;
  title?: string | null;
}

// Immersive reader chrome. Top bar: back / (judul + chapter) / home. Bottom
// toolbar: ‹ › chapter · pengaturan / daftar / unduh (padat, gap-1, border
// sesuai isi, di tengah). Rail kanan: gulir atas / autoscroll / gulir bawah.
// Sembunyi saat scroll ke bawah; muncul hanya lewat tap (stage / pill,
// tap lagi → sembunyi lagi). Semua gerak transform+opacity saja (GPU
// compositor, `will-change: transform`) → ringan saat scroll panjang.
//
// ⭐ Async-first: `pages=null` (server budget habis — source scrape dingin) →
// shell + skeleton tampil instan, self-fetch getChapter lewat candidates
// (urutan chosen→kanonik, sama dgn logika server). seriesTitle='' → self-fetch
// getSeries. Semua kandidat gagal → panel error (bukan 404 server — data bisa
// tiba telat tanpa berarti tidak ada).
export function ReaderShell({
  source,
  slug,
  chapterId,
  chapterNumber,
  chapterTitle,
  seriesTitle,
  seriesType,
  type,
  pages: initialPages,
  fetchCandidates,
  apiUrl,
}: {
  source: string;
  slug: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle?: string | null;
  seriesTitle: string;
  seriesType?: string | null;
  type?: string;
  pages: PageUrl[] | null;
  fetchCandidates?: string[];
  apiUrl: string;
}) {
  const [hidden, setHidden] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<'scroll' | 'page'>('scroll');
  const [chapters, setChapters] = useState<ShellItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [autoScroll, setAutoScroll] = useState(false);
  const [lazyPages, setLazyPages] = useState<PageUrl[] | null>(initialPages);
  const [lazyFailed, setLazyFailed] = useState(false);
  const [lazySeries, setLazySeries] = useState<{ title?: string; type?: string | null } | null>(null);
  const scrollState = useRef({ y: 0, dir: 0 });
  const autoRaf = useRef<number | null>(null);

  const pages = lazyPages ?? [];

  // Self-fetch pages saat server telat pulang (budget habis).
  useEffect(() => {
    if (initialPages !== null || !fetchCandidates || fetchCandidates.length === 0) return;
    let alive = true;
    (async () => {
      for (const src of fetchCandidates) {
        try {
          const got = await getChapter(src, chapterId);
          if (alive && got && got.pages && got.pages.length > 0) {
            setLazyPages(got.pages.map((pg) => ({ ...pg })));
            return;
          }
        } catch { /* kandidat berikutnya */ }
      }
      if (alive) setLazyFailed(true);
    })();
    return () => { alive = false; };
  }, [initialPages, fetchCandidates, chapterId]);

  // Self-fetch judul series bila server tidak sempat.
  useEffect(() => {
    if (seriesTitle || !source || !slug) return;
    let alive = true;
    import('@/lib/api').then(({ getSeries }) => {
      getSeries(source, slug)
        .then((s) => { if (alive && s?.title) setLazySeries({ title: s.title, type: s.type }); })
        .catch(() => {});
    });
    return () => { alive = false; };
  }, [seriesTitle, source, slug]);

  const dispSeriesTitle = seriesTitle || lazySeries?.title || slug;
  const dispSeriesType = seriesType ?? lazySeries?.type ?? null;

  useEffect(() => {
    let alive = true;
    getChapters(source, slug)
      .then((list) => { if (alive) setChapters(list); })
      .catch(() => {});
    return () => { alive = false; };
  }, [source, slug]);

  // Hide on scroll-down only. Reveal tidak otomatis saat scroll-up — chrome
  // hanya muncul lewat tap (stage / pill toolbar). Passive listener; state
  // hanya berubah saat arah berubah → tidak re-render per scroll event.
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const dir = y > scrollState.current.y ? 1 : y < scrollState.current.y ? -1 : 0;
      scrollState.current = { y, dir };
      if (dir <= 0 || y < 90) return;
      setHidden(true);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Autoscroll: rAF loop, kecepatan proporsional viewport. Berhenti otomatis
  // di dasar halaman; ikon rail berubah jadi pause saat aktif.
  const stopAutoScroll = useCallback(() => {
    if (autoRaf.current !== null) { cancelAnimationFrame(autoRaf.current); autoRaf.current = null; }
    setAutoScroll(false);
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(t - last, 50) / 1000;
      last = t;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (window.scrollY >= max - 2) { stopAutoScroll(); return; }
      window.scrollBy(0, window.innerHeight * 0.28 * dt);
      autoRaf.current = requestAnimationFrame(tick);
    };
    autoRaf.current = requestAnimationFrame(tick);
    return () => { if (autoRaf.current !== null) { cancelAnimationFrame(autoRaf.current); autoRaf.current = null; } };
  }, [autoScroll, stopAutoScroll]);

  // Hentikan autoscroll saat user menyentuh scroll manual.
  useEffect(() => {
    if (!autoScroll) return;
    const onManual = () => stopAutoScroll();
    window.addEventListener('wheel', onManual, { passive: true });
    window.addEventListener('touchstart', onManual, { passive: true });
    return () => {
      window.removeEventListener('wheel', onManual);
      window.removeEventListener('touchstart', onManual);
    };
  }, [autoScroll, stopAutoScroll]);

  useEffect(() => {
    if (!sheetOpen && !settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSheetOpen(false); setSettingsOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen, settingsOpen]);

  // Tap pada pill (bukan tombol dalam) → toggle bar; tombol dalam berhenti
  // propagasi supaya tidak ikut tertoggle.
  const toggleChrome = useCallback(() => {
    setHidden((h) => !h);
    setSheetOpen(false);
    setSettingsOpen(false);
  }, []);

  const scrollBy = (dir: 1 | -1) => {
    window.scrollBy({ top: window.innerHeight * 0.8 * dir, behavior: 'smooth' });
  };
  const toggleAutoScroll = () => setAutoScroll((a) => !a);

  const chapterUrl = (id: string) => typedChapterUrl(safeType(type), slug, id);
  // Next/prev dari daftar chapter asli (bukan tebakan slug-chapter-N):
  // tetangga terdekat berdasarkan chapter_number, tahan gap + urutan apa pun.
  const nextCh = chapters
    .filter((c) => c.chapter_number > chapterNumber)
    .sort((a, b) => a.chapter_number - b.chapter_number)[0];
  const prevCh = chapters
    .filter((c) => c.chapter_number < chapterNumber)
    .sort((a, b) => b.chapter_number - a.chapter_number)[0];
  const prevUrl = prevCh ? chapterUrl(prevCh.id) : null;
  const nextUrl = nextCh ? chapterUrl(nextCh.id) : null;
  const maxNum = chapters.length
    ? Math.max(0, ...chapters.map((c) => c.chapter_number ?? 0))
    : 0;
  const nextDisabled = maxNum > 0 && chapterNumber >= maxNum;

  // Unduh halaman yang sedang terlihat (mode scroll: halaman paling bawah
  // viewport; mode page: halaman aktif).
  const downloadCurrent = useCallback(() => {
    const p = pages[activeIdx];
    if (!p) return;
    const url = p.imgUrl ? `${imgOriginFor(p.imgUrl)}${p.imgUrl}` : `${apiUrl}${p.proxyUrl}`;
    const ext = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? '').toLowerCase();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}-chapter-${chapterNumber}-${activeIdx + 1}${ext ? `.${ext}` : ''}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [pages, activeIdx, apiUrl, slug, chapterNumber]);

  const icon = (d: React.ReactNode) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
  );
  const ChevronLeft = icon(<path d="m15 18-6-6 6-6" />);
  const ChevronRight = icon(<path d="m9 18 6-6-6-6" />);
  const ArrowLeft = icon(<><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>);
  const HomeIcon = icon(<><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>);
  const ListIcon = icon(<><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>);
  const GearIcon = icon(<><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>);
  const DownloadIcon = icon(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>);
  const ChevronUp = icon(<path d="m18 15-6-6-6 6" />);
  const ChevronDown = icon(<path d="m6 9 6 6 6-6" />);
  const PlayIcon = icon(<polygon points="6 3 20 12 6 21 6 3" />);
  const PauseIcon = icon(<><path d="M7 4h3v16H7z" /><path d="M14 4h3v16h-3z" /></>);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  // Tap pada area baca → toggle chrome (muncul; tap lagi → sembunyi) + popup
  // tertutup. Chrome tidak muncul otomatis saat scroll-up, hanya lewat tap.
  const onStageClick = useCallback(() => {
    setSheetOpen(false);
    setSettingsOpen(false);
    setHidden((h) => !h);
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 pt-6 pb-28">
      {/* ── Top bar: kembali / judul + chapter / beranda ── */}
      <div className={`reader-top ${hidden ? 'reader-hidden' : ''}`}>
        <div className="nav-island reader-top-inner">
          <button type="button" aria-label="Kembali ke halaman sebelumnya" onClick={() => history.back()} className="rbtn shrink-0">{ArrowLeft}</button>
          <div className="min-w-0 flex-1 px-2 text-center">
            <p className="truncate text-[13px] font-medium leading-tight">{dispSeriesTitle}</p>
            <p className="truncate text-[10px] uppercase tracking-wider text-muted">
              Chapter {chapterNumber}{chapterTitle ? ` · ${chapterTitle}` : ''} · {dispSeriesType ?? 'manga'}
            </p>
          </div>
          <a href="/" aria-label="Kembali ke beranda" className="rbtn shrink-0">{HomeIcon}</a>
        </div>
      </div>

      {/* ── Toolbar bawah: ‹ › chapter · pengaturan / daftar / unduh ── */}
      <div className={`reader-bottom ${hidden ? 'reader-hidden' : ''}`}>
        <div
          className="nav-island reader-toolbar"
          onClick={(e) => { if (e.target === e.currentTarget) toggleChrome(); }}
        >
          <div className="flex items-center justify-center gap-1">
            {prevUrl ? (
              <a href={prevUrl} aria-label="Chapter sebelumnya" onClick={stop} className="rbtn">{ChevronLeft}</a>
            ) : (
              <span className="rbtn rbtn-disabled" aria-hidden="true">{ChevronLeft}</span>
            )}
            <div className="relative reader-settings-anchor">
              <button
                type="button"
                aria-label="Pengaturan"
                aria-expanded={settingsOpen}
                onClick={(e) => { stop(e); setSettingsOpen((o) => !o); setSheetOpen(false); }}
                className={`rbtn ${settingsOpen ? 'bg-bg-secondary text-primary' : ''}`}
              >
                {GearIcon}
              </button>
              {settingsOpen && (
                <div className="reader-settings nav-island">
                  <p className="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted">Mode baca</p>
                  {(['scroll', 'page'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={(e) => { stop(e); setMode(m); setSettingsOpen(false); }}
                      className={`rbtn-mode flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-sm transition-colors ${
                        mode === m ? 'bg-bg-secondary text-primary' : 'text-secondary hover:bg-bg-secondary/60'
                      }`}
                    >
                      {m === 'scroll' ? 'Scroll' : 'Per halaman'}
                      {mode === m && <span className="text-accent">●</span>}
                    </button>
                  ))}
                  <SourceSwitcher
                    currentSource={source}
                    sourceId={slug}
                    canonicalSlug={slug}
                    chapterNumber={chapterNumber}
                    apiUrl={apiUrl}
                    mode="reader"
                    type={type}
                  />
                  <p className="px-1 pt-2 text-[11px] text-muted">Halaman {activeIdx + 1} / {pages.length}</p>
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Daftar chapter"
              onClick={(e) => { stop(e); setSheetOpen((o) => !o); setSettingsOpen(false); }}
              className="rbtn"
            >
              {ListIcon}
            </button>
            <button
              type="button"
              aria-label="Unduh halaman ini"
              onClick={(e) => { stop(e); downloadCurrent(); }}
              className="rbtn"
            >
              {DownloadIcon}
            </button>
            {nextUrl && !nextDisabled ? (
              <a href={nextUrl} aria-label="Chapter selanjutnya" onClick={stop} className="rbtn shrink-0">{ChevronRight}</a>
            ) : (
              <span className="rbtn rbtn-disabled" aria-hidden="true">{ChevronRight}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Rail kanan: gulir atas / autoscroll / gulir bawah (autohide sama) ── */}
      <div className={`reader-rail ${hidden ? 'reader-hidden' : ''}`}>
        <div className="nav-island reader-rail-inner">
          <button type="button" aria-label="Gulir ke atas" onClick={() => scrollBy(-1)} className="rbtn">{ChevronUp}</button>
          <button
            type="button"
            aria-label={autoScroll ? 'Hentikan autoscroll' : 'Autoscroll'}
            aria-pressed={autoScroll}
            onClick={(e) => { stop(e); toggleAutoScroll(); }}
            className={`rbtn ${autoScroll ? 'bg-accent text-zinc-950' : ''}`}
          >
            {autoScroll ? PauseIcon : PlayIcon}
          </button>
          <button type="button" aria-label="Gulir ke bawah" onClick={() => scrollBy(1)} className="rbtn">{ChevronDown}</button>
        </div>
      </div>

      {/* ── Bottom sheet: daftar chapter (slide dari bawah) ── */}
      <div className={`reader-backdrop ${sheetOpen ? 'open' : ''}`} onClick={() => setSheetOpen(false)}>
        <div className={`reader-sheet ${sheetOpen ? 'open' : ''}`} onClick={stop} role="dialog" aria-label="Daftar chapter">
          {sheetOpen && (
            <div className="flex min-h-0 flex-col">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">Daftar Chapter</p>
                <button type="button" aria-label="Tutup daftar" onClick={() => setSheetOpen(false)} className="rbtn h-8 w-8 text-xs">✕</button>
              </div>
              <SourceSwitcher
                currentSource={source}
                sourceId={slug}
                canonicalSlug={slug}
                chapterNumber={chapterNumber}
                apiUrl={apiUrl}
                embedded
                type={type}
              />
              <div className="sheet-list -mx-1 mt-2">
                {chapters.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted">Memuat daftar chapter…</p>
                ) : (
                  <WindowedList total={chapters.length} renderItem={(i) => {
                    const c = chapters[i];
                    const isCurrent = c.id === chapterId;
                    return (
                      <a
                        key={c.id}
                        href={chapterUrl(c.id)}
                        onClick={() => setSheetOpen(false)}
                        className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-colors ${
                          isCurrent
                            ? 'bg-bg-secondary text-primary'
                            : 'text-secondary hover:bg-bg-secondary/60 hover:text-primary'
                        }`}
                      >
                        <span className="truncate">
                          {isCurrent && <span className="mr-1.5 text-accent">●</span>}
                          Chapter {c.chapter_number}
                        </span>
                        {c.title && <span className="ml-3 truncate text-xs text-muted">{c.title}</span>}
                      </a>
                    );
                  }} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="reader-stage" onClick={onStageClick}>
        {lazyPages === null && !lazyFailed ? (
          <div className="flex flex-col items-center gap-3" aria-busy="true" aria-label="Memuat halaman">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton w-full max-w-xl" style={{ height: '70vh', opacity: 1 - i * 0.15 }} />
            ))}
            <p className="text-xs text-muted font-mono mt-1">memuat halaman…</p>
          </div>
        ) : lazyFailed ? (
          <div className="mx-auto mt-10 max-w-sm rounded-xl border border-border-default bg-card p-6 text-center">
            <p className="text-sm text-primary font-medium mb-1">Halaman tidak bisa dimuat</p>
            <p className="text-xs text-secondary mb-4">Sumber mungkin sedang gangguan — coba lagi sebentar.</p>
            <div className="flex justify-center gap-2">
              <button type="button" onClick={() => location.reload()} className="rounded-lg border border-border-default px-4 py-2 text-sm hover:bg-bg-secondary transition-colors">Coba lagi</button>
              <a href={`/${type}/${slug}`} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-[color:var(--accent-ink)] hover:opacity-90 transition-opacity">Kembali ke komik</a>
            </div>
          </div>
        ) : (
          <Reader
            source={source}
            pages={pages}
            apiUrl={apiUrl}
            nextChapterId={nextCh?.id ?? null}
            mode={mode}
            onModeChange={setMode}
            onActivePage={setActiveIdx}
          />
        )}
      </div>
    </main>
  );
}

export default ReaderShell;
