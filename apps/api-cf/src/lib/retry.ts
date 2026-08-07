// Shared retry with capped backoff.
// ponytail: setTimeout-based sleep charges CPU time on CF Workers (10ms on
// Free plan). Backoffs are capped low; upgrade path = use `cloudflare:schedulers`
// `scheduler.wait()` once a binding is configured. For now prefer < 2 attempts
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
      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        // Short backoff to respect rate-limit without burning CPU budget.
        await sleep(250 * Math.pow(2, i));
      } else {
        await sleep(100 * (i + 1));
      }
    }
  }
  throw last;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
