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
