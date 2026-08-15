// Shared HTTP response-drain helper.
//
// Cloudflare Workers consider a `fetch` subrequest COMPLETE only once its
// response body is fully consumed (read to completion OR cancelled). Un-consumed
// bodies occupy a concurrent-subrequest slot (hard limit: 6 per request). When a
// Worker fails to drain a body and hits 6 in-flight fetches, the runtime's
// deadlock-avoidance cancels the least-recently-used request — visible as random
// 502s / timeouts / elevated billing (worker kept alive waiting on a body it
// will never read).
//
// Source: https://developers.cloudflare.com/workers/.../concurrent-subrequest-limit
//   "A fetch is only considered complete once the response body is fully consumed…"
//
// So: on every error / early-return path where we already have a Response but
// don't need its body, call drainResponse(res). On success paths that DO need
// the body, the body is consumed normally (no drain needed).

/** Best-effort drain of a Response body we no longer need. Never throws — */
export const drainResponse = async (res: Response): Promise<void> => {
  try {
    if (res.body?.cancel) await res.body.cancel().catch(() => {});
  } catch { /* ignored — best effort */ }
};

/**
 * Normalize a manga cover URL so the image CDN serves the ORIGINAL portrait
 * art instead of a cropped landscape thumbnail.
 *
 * Two problems this solves:
 * 1. Komiku's search HTML ships covers with `?resize=450,235` (landscape crop),
 *    which collapses portrait manga into a 1.91:1 strip.
 * 2. WordPress.com CDN (i2.wp.com) used by bacakomik/manhwaindo crops via
 *    `resize=w,h`.
 *
 * Heuristic:
 * - Decode HTML-encoded `&` (`&#038;`)` → `&` so query params are reliable.
 * - If the URL has `resize=w,h`, drop the whole querystring and re-add
 *   `?w=450` (WP.com) → original aspect ratio. For non-WP hosts (komiku
 *   thumbnail host) dropping the querystring serves full art too.
 */
export const sanitizeCoverUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const decoded = url.replace(/&#0?38;/g, '&').trim();
  const [base, hash] = decoded.split('#');
  const [origin, _oldQuery] = base.split('?');
  if (!hash) return origin;
  return `${origin}#${hash}`;
};
