import { useCallback, useEffect, useRef } from 'react';
import { nextRefreshAfter, refreshSettled, type RefreshSlot } from './adminInventory';

export type AdminRefresh = (forceRefresh?: boolean) => void;

type RefreshState = { slot: RefreshSlot; load: (forceRefresh: boolean) => Promise<void> };

/**
 * One loader per admin page. The first load runs even while the tab is
 * hidden, the interval and the visibility handler skip hidden tabs, and the
 * slot state machine never overlaps a load nor drops a forced refresh that
 * arrives mid-flight.
 */
export const useAdminRefresh = (
  load: (forceRefresh: boolean) => Promise<void>,
  enabled: boolean,
  intervalMs = 30000
): AdminRefresh => {
  const state = useRef<RefreshState>({ slot: { inFlight: false, queued: false }, load });

  useEffect(() => {
    state.current.load = load;
  }, [load]);

  const run = useCallback<AdminRefresh>((forceRefresh = false) => {
    const fire = (force: boolean) => {
      void state.current.load(force).finally(() => {
        const after = refreshSettled(state.current.slot);
        state.current.slot = after.slot;
        if (after.start) fire(true);
      });
    };
    const decision = nextRefreshAfter(state.current.slot, forceRefresh === true);
    state.current.slot = decision.slot;
    if (decision.start) fire(forceRefresh === true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    run(false);
    const interval = setInterval(() => {
      if (document.hidden) return;
      run(false);
    }, intervalMs);
    const onVisibility = () => {
      if (document.hidden) return;
      run(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, run]);

  return run;
};
