// Shared retry with capped backoff and Komiku-aware retryable detection.
//
// Komiku.org sits behind a Cloudflare DDoS-guard edge that intermittently
// returns 502/503/520/521/522 and stalls (10-30s) on bot-like traffic.
// Retrying these with growing backoffs is the only way to ride out the
// rate-limit window without burning CPU.
//
// ponytail: setTimeout-based sleep charges CPU time on CF Workers (10ms on
// Free plan). Backoffs are capped low; upgrade path = use `cloudflare:schedulers`
// `scheduler.wait()` once a binding is configured. For now prefer < 3 attempts
// in hot paths (image proxy) and keep sleep minimal.
export const retryUpstream = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      last = e;
      const msg = String(e);
      if (i >= attempts - 1) break;
      if (isRetryable(msg)) {
        // Exponential backoff for rate-limit / DDoS-guard stalls.
        // Base 300ms doubles each attempt — at attempt 3 that's ~900ms,
        // well under the typical Komiku DDoS-guard release window.
        await sleep(300 * Math.pow(2, i));
      } else {
        await sleep(100 * (i + 1));
      }
    }
  }
  throw last;
};

/**
 * Whether an error string indicates a transient upstream condition worth
 * retrying. Covers:
 * - 403 Forbidden (intermittent WAF / CF Worker IP block)
 * - 429 Too Many Requests
 * - 5xx server errors (502/503/504)
 * - CF origin errors 520/521/522/523/524 (origin unreachable / timeout)
 * - AbortError (timeout)
 * - FetchError / connection reset
 */
export const isRetryable = (msg: string): boolean => {
  if (!msg) return false;
  if (msg.includes('AbortError') || msg.includes('aborted')) return true;
  if (/network|fetch failed|connection (reset|refused)|econnreset/i.test(msg)) return true;
  // Status code in error message: "komiku getSeriesDetail 502"
  const m = msg.match(/\b(403|429|500|502|503|504|520|521|522|523|524)\b/);
  if (!m) return false;
  const code = Number(m[1]);
  return code === 403 || code === 429 || code >= 500;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export { sleep };
