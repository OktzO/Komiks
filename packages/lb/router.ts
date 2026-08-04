// LB routing helpers: settings read + healthy origin selection.
// getHealthyOrigin returns the highest-priority enabled origin whose
// last_health_status is 'healthy' or null (never-checked treated as usable),
// or null when LB mode is off / no enabled origin matches.
import type { Db } from '@manga-platform/db';
import type { LbSettings, LbOrigin } from '@manga-platform/shared/types';

export interface LbSettingsEnv {
  DB: unknown;
}

export const getLbSettings = async (db: Db): Promise<LbSettings | null> =>
  db.getLbSettings();

export interface HealthyOrigin {
  url: string;
  priority: number;
}

export const getHealthyOrigin = async (db: Db): Promise<HealthyOrigin | null> => {
  const settings = await db.getLbSettings();
  if (!settings || settings.mode !== 'on') return null;
  const origins = await db.listOrigins();
  const usable = origins
    .filter((o) => o.enabled === 1)
    .filter((o) => o.last_health_status === 'healthy' || o.last_health_status === null)
    .sort((a, b) => b.priority - a.priority);
  const pick = usable[0] as LbOrigin | undefined;
  return pick ? { url: pick.origin_url, priority: pick.priority } : null;
};
