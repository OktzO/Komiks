'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Reader } from './Reader';
import { SourceSwitcher } from './SourceSwitcher';
import { getChapters } from '@/lib/api';

interface PageUrl {
  proxyUrl: string;
  b2Url?: string | null;
}

interface ShellItem {
  id: string;
  chapter_number: number;
  title?: string | null;
}

// Immersive reader chrome. Top bar: back / (judul + chapter) / home. Bottom
// toolbar: prev·next chapter di tepi, di tengah: pengaturan (kiri), daftar
// chapter (tengah), unduh (kanan). Tap kanvas toolbar → tutup/buka; scroll ke
// bawah → sembunyi, ke atas → muncul. Semua gerak transform+opacity saja
// (GPU compositor, `will-change: transform`) → ringan saat scroll panjang.
export function ReaderShell({
  source,
  slug,
  chapterId,
  chapterNumber,
  chapterTitle,
  seriesTitle,
  seriesType,
  pages,
  apiUrl,
  nextChapterUrl,
}: {
  source: string;
  slug: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle?: string | null;
  seriesTitle: string;
  seriesType?: string | null;
  pages: PageUrl[];
  apiUrl: string;
  nextChapterUrl?: string | null;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<'scroll' | 'page'>('scroll');
  const [chapters, setChapters] = useState<ShellItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const scrollState = useRef({ y: 0, dir: 0 });

  useEffect(() => {
    let alive = true;
    getChapters(source, slug)
      .then((list) => { if (alive) setChapters(list); })
      .catch(() => {});
    return () => { alive = false; };
  }, [source, slug]);

  // Hide on scroll-down, reveal on scroll-up. Passive listener; state hanya
  // berubah saat arah berubah → tidak re-render per scroll event.
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const dir = y > scrollState.current.y ? 1 : y < scrollState.current.y ? -1 : 0;
      scrollState.current = { y, dir };
      if (dir === 0 || y < 90) return;
      setHidden(dir > 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

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

  const chapterUrl = (n: number) => `/${source}/s/${slug}/${slug}-chapter-${n}`;
  const prevUrl = chapterNumber > 1 ? chapterUrl(chapterNumber - 1) : null;
  const nextUrl = nextChapterUrl;
  const maxNum = chapters.length
    ? Math.max(0, ...chapters.map((c) => c.chapter_number ?? 0))
    : 0;
  const nextDisabled = maxNum > 0 && chapterNumber >= maxNum;

  // Unduh halaman yang sedang terlihat (mode scroll: halaman paling bawah
  // viewport; mode page: halaman aktif).
  const downloadCurrent = useCallback(() => {
    const p = pages[activeIdx];
    if (!p) return;
    const url = p.b2Url ?? `${apiUrl}${p.proxyUrl}`;
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
  const GearIcon = icon(<><circle cx="12" cy="12" r="3" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
  const DownloadIcon = icon(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  // Tap pada area baca → chrome muncul lagi + popup tertutup. Chrome hanya
  // hilang lewat scroll-bawah atau tap pill; tap konten selalu membangunkannya
  // (supaya reader pendek/statis tetap bisa memunculkan bar).
  const onStageClick = useCallback(() => {
    setSheetOpen(false);
    setSettingsOpen(false);
    setHidden(false);
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 pt-6 pb-28">
      {/* ── Top bar: kembali / judul + chapter / beranda ── */}
      <div className={`reader-top ${hidden ? 'reader-hidden' : ''}`}>
        <div className="nav-island reader-top-inner">
          <button type="button" aria-label="Kembali ke halaman sebelumnya" onClick={() => router.back()} className="rbtn shrink-0">{ArrowLeft}</button>
          <div className="min-w-0 flex-1 px-2 text-center">
            <p className="truncate text-[13px] font-medium leading-tight">{seriesTitle}</p>
            <p className="truncate text-[10px] uppercase tracking-wider text-muted">
              Chapter {chapterNumber}{chapterTitle ? ` · ${chapterTitle}` : ''} · {seriesType ?? 'manga'}
            </p>
          </div>
          <Link href="/" aria-label="Kembali ke beranda" className="rbtn shrink-0">{HomeIcon}</Link>
        </div>
      </div>

      {/* ── Toolbar bawah: ‹ › chapter · pengaturan / daftar / unduh ── */}
      <div className={`reader-bottom ${hidden ? 'reader-hidden' : ''}`}>
        <div
          className="nav-island reader-toolbar"
          onClick={(e) => { if (e.target === e.currentTarget) toggleChrome(); }}
        >
          <div className="flex flex-1 justify-start gap-1">
            {prevUrl ? (
              <Link href={prevUrl} aria-label="Chapter sebelumnya" onClick={stop} className="rbtn">{ChevronLeft}</Link>
            ) : (
              <span className="rbtn rbtn-disabled" aria-hidden="true">{ChevronLeft}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <div className="relative">
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
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-sm transition-colors ${
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
          </div>
          <div className="flex flex-1 justify-end gap-1">
            {nextUrl && !nextDisabled ? (
              <Link href={nextUrl} aria-label="Chapter selanjutnya" onClick={stop} className="rbtn shrink-0">{ChevronRight}</Link>
            ) : (
              <span className="rbtn rbtn-disabled" aria-hidden="true">{ChevronRight}</span>
            )}
          </div>
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
              />
              <div className="sheet-list -mx-1 mt-2">
                {chapters.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted">Memuat daftar chapter…</p>
                ) : (
                  chapters.map((c) => {
                    const isCurrent = c.id === chapterId;
                    return (
                      <Link
                        key={c.id}
                        href={`/${source}/s/${slug}/${c.id}`}
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
                      </Link>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="reader-stage" onClick={onStageClick}>
        <Reader
          pages={pages}
          apiUrl={apiUrl}
          nextChapterUrl={nextChapterUrl}
          mode={mode}
          onModeChange={setMode}
          onActivePage={setActiveIdx}
        />
      </div>
    </main>
  );
}