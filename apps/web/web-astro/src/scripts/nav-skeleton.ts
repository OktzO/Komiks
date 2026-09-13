// ── Instant nav: progress bar + skeleton saat pindah halaman ──
// ClientRouter (view transitions) sudah menampilkan halaman lama sampai
// yang baru siap (swap). Script ini menambah feedback instan:
// 1. Klik link internal → top progress bar muncul segera.
// 2. Render >250ms → skeleton shell target muncul di atas halaman lama
//    (halaman detail/reader punya pola skeleton sama dengan web lama).
// 3. Form search submit → SPA navigate + skeleton rows + tombol spinner.
// 4. Swap selesai / abort → bersih otomatis.
import { navigate } from 'astro:transitions/client';
;(() => {
  if (typeof window === 'undefined') return;

  const SKELETON_DELAY = 250;
  let progressEl: HTMLElement | null = null;
  let skeletonEl: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;

  const isInternalNav = (href: string): boolean => {
    try {
      const u = new URL(href, window.location.href);
      if (u.origin !== window.location.origin) return false;
      // exclude hash-link di halaman sama + download
      if (u.pathname === window.location.pathname && u.hash) return false;
      return !u.pathname.startsWith('/img/');
    } catch {
      return false;
    }
  };

  // Target route → tipe skeleton shell (pola web lama).
  // /{type}/{slug} → detail skeleton; /{type}/{slug}/{ch} → reader; /search → rows; sisanya → generic.
  const shellFor = (pathname: string): 'detail' | 'reader' | 'generic' | 'search' => {
    const segs = pathname.split('/').filter(Boolean);
    if (segs.length === 2 && ['manga', 'manhwa', 'manhua'].includes(segs[0])) return 'detail';
    if (segs.length === 3 && ['manga', 'manhwa', 'manhua'].includes(segs[0])) return 'reader';
    if (segs[0] === 'search') return 'search';
    return 'generic';
  };

  const showProgress = () => {
    if (progressEl) return;
    progressEl = document.createElement('div');
    progressEl.className = 'route-progress';
    progressEl.style.animation = 'none';
    progressEl.style.transform = 'scaleX(0.35)';
    progressEl.style.transition = 'transform 0.9s cubic-bezier(0.22, 1, 0.36, 1)';
    progressEl.style.opacity = '1';
    document.body.appendChild(progressEl);
    requestAnimationFrame(() => { if (progressEl) progressEl.style.transform = 'scaleX(0.75)'; });
  };

  const hideProgress = () => {
    if (progressEl) {
      const el = progressEl;
      progressEl = null;
      el.style.transform = 'scaleX(1)';
      el.style.opacity = '0';
      el.style.transition = 'transform 0.15s ease-out, opacity 0.25s ease-out';
      setTimeout(() => el.remove(), 300);
    }
  };

  const skeletonHTML = (kind: 'detail' | 'reader' | 'generic' | 'search'): string => {
    const row = (h: string) => `<div class="skeleton" style="height:${h};margin-bottom:12px"></div>`;
    const cover = `<div class="skeleton" style="width:144px;height:208px;border-radius:12px;flex-shrink:0"></div>`;
    if (kind === 'detail') {
      return `<div style="display:flex;gap:24px;align-items:flex-start">${cover}<div style="flex:1">${row('28px')}${row('16px')}${row('80px')}${row('80px')}${row('44px')}</div></div>`;
    }
    if (kind === 'reader') {
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:12px"><div class="skeleton" style="height:40px;width:100%;border-radius:12px"></div>${Array.from({ length: 3 }, (_, i) => `<div class="skeleton" style="width:100%;max-width:576px;height:70vh;border-radius:4px;opacity:${1 - i * 0.15}"></div>`).join('')}</div>`;
    }
    if (kind === 'search') {
      // Row = cover 72x104 + 2 baris teks — pola ResultRow halaman search.
      return row('40px') + Array.from({ length: 5 }, () =>
        `<div style="display:flex;gap:16px;padding:12px;border:1px solid var(--border-subtle);border-radius:var(--radius);margin-bottom:10px;background:var(--bg-card)"><div class="skeleton" style="width:72px;height:104px;border-radius:8px;flex-shrink:0"></div><div style="flex:1">${row('18px')}${row('14px')}</div></div>`
      ).join('');
    }
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px">${Array.from({ length: 10 }, () => `<div class="skeleton" style="aspect-ratio:3/4;border-radius:8px"></div>`).join('')}</div>`;
  };

  const showSkeleton = (kind: 'detail' | 'reader' | 'generic' | 'search') => {
    if (skeletonEl) return;
    skeletonEl = document.createElement('div');
    skeletonEl.id = 'nav-skeleton';
    skeletonEl.style.cssText = 'position:fixed;inset:0;z-index:90;background:var(--bg-base);opacity:0;transition:opacity 0.2s ease;overflow-y:auto;padding:96px 16px 32px';
    skeletonEl.innerHTML = `<div style="max-width:672px;margin:0 auto">${skeletonHTML(kind)}</div>`;
    document.body.appendChild(skeletonEl);
    requestAnimationFrame(() => { if (skeletonEl) skeletonEl.style.opacity = '1'; });
    document.documentElement.style.overflow = 'hidden';
  };

  const clearNavFx = () => {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    hideProgress();
    if (skeletonEl) {
      const el = skeletonEl;
      skeletonEl = null;
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
      document.documentElement.style.overflow = '';
    }
  };

  const onDocClick = (e: Event) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (!isInternalNav(href)) return;
    if (a.dataset.navSkip !== undefined) return;
    // sama-origin non-hash → nav interhal, tampilkan fx.
    startNavFx(href);
  };

  const startNavFx = (href: string) => {
    showProgress();
    const u = new URL(href, window.location.href);
    const kind = shellFor(u.pathname);
    showTimer = setTimeout(() => showSkeleton(kind), kind === 'search' ? 150 : SKELETON_DELAY);
  };

  // Form search: submit → SPA navigate + tombol spinner "Mencari…" + skeleton
  // row instan (pola ui-ux: loading→done feedback, cegah double-submit).
  const onDocSubmit = (e: Event) => {
    const form = e.target as HTMLFormElement | null;
    if (!form || !form.matches?.('form[data-search-form]')) return;
    const fd = new FormData(form);
    const q = String(fd.get('q') ?? '').trim();
    if (!q) return; // submit kosong → biarkan validasi native
    e.preventDefault();
    if (progressEl || skeletonEl) return; // sudah aktif (double submit) → blok
    const action = new URL(form.getAttribute('action') || window.location.pathname, window.location.href);
    action.search = '';
    const params = new URLSearchParams();
    params.set('q', q);
    action.search = `?${params}`;
    const btn = form.querySelector('button[type="submit"]') as HTMLElement | null;
    if (btn && !btn.dataset.busy) {
      btn.dataset.busy = '1';
      btn.style.opacity = '0.85';
      btn.style.pointerEvents = 'none';
      btn.innerHTML = '<span class="src-spinner" aria-hidden="true"></span><span style="margin-left:8px">Mencari…</span>';
    }
    startNavFx(action.href);
    navigate(action.href);
  };

  // ClientRouter swap selesai / batal / popstate → bersih.
  document.addEventListener('astro:after-swap', clearNavFx);
  document.addEventListener('astro:page-load', clearNavFx);
  window.addEventListener('popstate', () => setTimeout(clearNavFx, 0));
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('submit', onDocSubmit, true);
  // safety: bila fetch nav stuck >15s (network), jangan biarkan skeleton selamanya.
  setInterval(() => {
    if (skeletonEl && document.visibilityState === 'hidden') clearNavFx();
  }, 5000);
})();
