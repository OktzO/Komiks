import { useEffect, useMemo, useRef, useState } from 'react';
import { getNovelChapter, getNovelChapters, type NovelChapter, type NovelChapterBody } from '@/lib/api';
import { chapterNumberOf, chapterPageWalk, neighbourChapters, novelChapterUrl, sanitizeNovelHtml } from '@/lib/novelRoutes';

// Text reader for prose. Deliberately not a variant of Reader.tsx: that one
// reserves image aspect ratios to fight CLS, which is meaningless here — the
// body is a plain block and the only layout job is the measure.

const FONT_SIZES: readonly number[] = [15, 16, 17, 18, 20, 22];
const LINE_HEIGHTS: readonly number[] = [1.5, 1.7, 1.9, 2.1];
const PREFS_KEY = 'oktz_novel_prefs';
const PROGRESS_KEY = 'oktz_novel_progress';
const SAVE_EVERY_MS = 1000;
const LIMIT = 50;
// Chapter pages the neighbour walk will read before giving up (250 rows).
const NEIGHBOUR_PAGES = 5;

type Prefs = { fontSize: number; lineHeight: number };
type Progress = Record<string, { at: number; ratio: number }>;
// What the reader actually uses from a chapter. The API's NovelChapterBody is a
// superset (id, scraped_at), so a page can hand its fetch straight through.
type Body = Pick<NovelChapterBody, 'number' | 'title' | 'content'>;

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota — the reader still works, it just will not remember.
  }
};

const nearestTo = (values: readonly number[], target: number): number =>
  values.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), values[0]);

const clampIndex = (i: number, len: number): number => Math.min(len - 1, Math.max(0, i));

export function NovelReader({
  slug,
  chapterId,
  chapterNumber: chapterNumberProp,
  chapterTitle: chapterTitleProp,
  seriesTitle,
  initial,
}: {
  slug: string;
  chapterId: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  seriesTitle: string;
  initial: Body | null;
}) {
  const [body, setBody] = useState<Body | null>(initial);
  const [failed, setFailed] = useState(false);
  const [siblings, setSiblings] = useState<NovelChapter[]>([]);
  const [prefs, setPrefs] = useState<Prefs>({ fontSize: 17, lineHeight: 1.7 });
  const [panelOpen, setPanelOpen] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const ratioRef = useRef(0);
  const lastSavedAt = useRef(0);

  const chapterNumber = body?.number ?? chapterNumberProp ?? chapterNumberOf(chapterId);
  const chapterTitle = body?.title ?? chapterTitleProp;
  const progressKey = `${slug}/${chapterId}`;

  useEffect(() => {
    const stored = readJson<Partial<Prefs>>(PREFS_KEY, {});
    setPrefs({
      fontSize: nearestTo(FONT_SIZES, Number(stored.fontSize) || 17),
      lineHeight: nearestTo(LINE_HEIGHTS, Number(stored.lineHeight) || 1.7),
    });
  }, []);

  useEffect(() => {
    if (initial !== null) return;
    let alive = true;
    getNovelChapter(slug, chapterId)
      .then((c) => { if (alive) setBody({ number: c.number, title: c.title, content: c.content }); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [initial, slug, chapterId]);

  // Prev/next are read off the stored rows, never computed from the chapter
  // number. Ingest drops every chapter whose body fetch failed, so numbering has
  // gaps and a list page is a row-offset window: for a novel with chapters
  // 1-10 and 101-200, chapter 150 sits on page 2, while ceil(150 / 50) says 3.
  // The walk is bounded — see chapterPageWalk for what a longer series gets.
  useEffect(() => {
    let alive = true;
    chapterPageWalk(
      (page) => getNovelChapters(slug, { page, limit: LIMIT }).then((r) => r.data ?? []),
      chapterId,
      { limit: LIMIT, maxPages: NEIGHBOUR_PAGES },
    )
      .then((rows) => { if (alive) setSiblings(rows); })
      .catch(() => {});
    return () => { alive = false; };
  }, [slug, chapterId]);

  const { prev, next } = useMemo(
    () => neighbourChapters(siblings, body?.number ?? chapterNumberProp ?? chapterNumberOf(chapterId)),
    [siblings, body?.number, chapterNumberProp, chapterId],
  );

  const saveProgress = (ratio: number, force = false) => {
    ratioRef.current = ratio;
    const now = Date.now();
    if (!force && now - lastSavedAt.current < SAVE_EVERY_MS) return;
    lastSavedAt.current = now;
    const all = readJson<Progress>(PROGRESS_KEY, {});
    all[progressKey] = { at: now, ratio };
    writeJson(PROGRESS_KEY, all);
  };

  // Restore after the body exists, otherwise scrollHeight is the skeleton and
  // the saved position lands on top of it.
  useEffect(() => {
    if (!body) return;
    const saved = readJson<Progress>(PROGRESS_KEY, {})[progressKey]?.ratio ?? 0;
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: saved > 0.02 ? saved * max : 0 });
    });
  }, [progressKey, body]);

  useEffect(() => {
    let lastY = 0;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > lastY + 60) setChromeHidden(true);
      else if (y < lastY - 60) setChromeHidden(false);
      lastY = y;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      saveProgress(max > 0 ? Math.min(1, y / max) : 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      saveProgress(ratioRef.current, true);
    };
  }, [progressKey]);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanelOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen]);

  const setPref = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => {
      const next = { ...p, [key]: value };
      writeJson(PREFS_KEY, next);
      return next;
    });
  };

  const icon = (d: React.ReactNode) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
  );
  const ChevronLeft = icon(<path d="m15 18-6-6 6-6" />);
  const ChevronRight = icon(<path d="m9 18 6-6-6-6" />);
  const TextIcon = icon(<><path d="M4 7V4h16v3" /><path d="M12 4v16" /><path d="M9 20h6" /></>);
  const ListIcon = icon(<><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>);
  const ArrowLeft = icon(<><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>);

  const chapterUrl = (c: NovelChapter) => novelChapterUrl(slug, c.source_chapter_id);
  const bodyHtml = useMemo(() => sanitizeNovelHtml(body?.content), [body?.content]);

  return (
    <main className="mx-auto max-w-2xl px-4 pt-20 pb-32">
      <div className={`reader-top ${chromeHidden ? 'reader-hidden' : ''}`}>
        <div className="nav-island reader-top-inner">
          <a href={`/novel/${encodeURIComponent(slug)}`} aria-label="Kembali ke daftar bab" className="rbtn shrink-0">{ArrowLeft}</a>
          <div className="min-w-0 flex-1 px-2 text-center">
            <p className="truncate text-[13px] font-medium leading-tight">{seriesTitle}</p>
            <p className="truncate text-[10px] uppercase tracking-wider text-muted">
              Bab {chapterNumber ?? '—'}{chapterTitle ? ` · ${chapterTitle}` : ''}
            </p>
          </div>
          <a href="/novel" aria-label="Katalog novel" className="rbtn shrink-0">{ListIcon}</a>
        </div>
      </div>

      <div className={`reader-bottom ${chromeHidden ? 'reader-hidden' : ''}`}>
        <div className="nav-island reader-toolbar" onClick={(e) => { if (e.target === e.currentTarget) setChromeHidden((h) => !h); }}>
          <div className="flex items-center justify-center gap-1">
            {prev ? (
              <a href={chapterUrl(prev)} aria-label="Bab sebelumnya" onClick={(e) => e.stopPropagation()} className="rbtn">{ChevronLeft}</a>
            ) : (
              <span className="rbtn rbtn-disabled" aria-hidden="true">{ChevronLeft}</span>
            )}
            <button
              type="button"
              aria-label="Ukuran dan spasi teks"
              aria-expanded={panelOpen}
              onClick={(e) => { e.stopPropagation(); setPanelOpen((o) => !o); }}
              className={`rbtn ${panelOpen ? 'bg-bg-secondary text-primary' : ''}`}
            >
              {TextIcon}
            </button>
            {next ? (
              <a href={chapterUrl(next)} aria-label="Bab selanjutnya" onClick={(e) => e.stopPropagation()} className="rbtn shrink-0">{ChevronRight}</a>
            ) : (
              <span className="rbtn rbtn-disabled" aria-hidden="true">{ChevronRight}</span>
            )}
          </div>

          {panelOpen && (
            <div className="reader-settings nav-island" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-3 pb-2">
                <span className="text-[11px] text-muted">Ukuran teks</span>
                <div className="flex items-center gap-1">
                  <button type="button" aria-label="Perkecil teks" onClick={() => setPref('fontSize', FONT_SIZES[clampIndex(FONT_SIZES.indexOf(prefs.fontSize) - 1, FONT_SIZES.length)])} className="rbtn h-8 w-8 text-sm">A−</button>
                  <span className="w-8 text-center font-mono text-[11px] text-secondary">{prefs.fontSize}</span>
                  <button type="button" aria-label="Perbesar teks" onClick={() => setPref('fontSize', FONT_SIZES[clampIndex(FONT_SIZES.indexOf(prefs.fontSize) + 1, FONT_SIZES.length)])} className="rbtn h-8 w-8 text-sm">A+</button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-2">
                <span className="text-[11px] text-muted">Spasi baris</span>
                <div className="flex items-center gap-1">
                  <button type="button" aria-label="Rapatkan spasi baris" onClick={() => setPref('lineHeight', LINE_HEIGHTS[clampIndex(LINE_HEIGHTS.indexOf(prefs.lineHeight) - 1, LINE_HEIGHTS.length)])} className="rbtn h-8 w-8 text-sm">−</button>
                  <span className="w-8 text-center font-mono text-[11px] text-secondary">{prefs.lineHeight.toFixed(1)}</span>
                  <button type="button" aria-label="Lebarkan spasi baris" onClick={() => setPref('lineHeight', LINE_HEIGHTS[clampIndex(LINE_HEIGHTS.indexOf(prefs.lineHeight) + 1, LINE_HEIGHTS.length)])} className="rbtn h-8 w-8 text-sm">+</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <article style={{ fontSize: `${prefs.fontSize}px`, lineHeight: prefs.lineHeight }}>
        <h1 className="mb-5 text-xl font-semibold tracking-tight">
          Bab {chapterNumber ?? '—'}{chapterTitle ? `: ${chapterTitle}` : ''}
        </h1>

        {!body && !failed ? (
          <div aria-busy="true" aria-label="Memuat isi bab">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton mb-3 w-full" style={{ height: '1.4rem' }} />
            ))}
          </div>
        ) : failed ? (
          <div className="rounded-panel border border-border-default bg-card p-6 text-center">
            <p className="mb-1 text-sm font-medium">Isi bab tidak bisa dimuat</p>
            <p className="mb-4 text-xs text-secondary">Sumber mungkin sedang gangguan — coba lagi sebentar.</p>
            <div className="flex justify-center gap-2">
              <button type="button" onClick={() => location.reload()} className="rounded-inner border border-border-default px-4 py-2 text-sm transition-colors hover:bg-bg-secondary">Coba lagi</button>
              <a href={`/novel/${encodeURIComponent(slug)}`} className="rounded-inner bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90">Kembali ke novel</a>
            </div>
          </div>
        ) : (
          // Safe by construction, not by convention: sanitizeNovelHtml keeps
          // prose tags only, drops every attribute and escapes every text run,
          // so no URL, style or handler can reach the DOM.
          <div
            className="[&_p]:mb-4 [&_p]:indent-8 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-1.5 [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:font-semibold [&_h4]:mb-2 [&_h4]:font-semibold [&_hr]:my-6 [&_hr]:border-border-default [&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border-default [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-secondary"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        )}
      </article>

      <nav className="mt-12 flex items-center justify-between gap-3 border-t border-border-subtle pt-6" aria-label="Navigasi bab">
        {prev ? (
          <a href={chapterUrl(prev)} className="rounded-inner border border-border-default px-3 py-2 text-xs text-secondary transition-colors hover:border-accent-border hover:text-accent">
            ‹ Bab {prev.number}
          </a>
        ) : <span />}
        {next ? (
          <a href={chapterUrl(next)} className="rounded-inner border border-border-default px-3 py-2 text-xs text-secondary transition-colors hover:border-accent-border hover:text-accent">
            Bab {next.number} ›
          </a>
        ) : <span />}
      </nav>
    </main>
  );
}

export default NovelReader;
