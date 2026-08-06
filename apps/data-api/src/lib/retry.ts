// Shared retry with exponential backoff. Promoted from apps/api-cf reader.ts.
export const retryUpstream = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      last = e;
      const msg = String(e);
      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
      } else if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
    }
  }
  throw last;
};
