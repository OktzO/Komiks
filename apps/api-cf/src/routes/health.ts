import { Hono } from 'hono';
import { Env } from '../lib/context';
import { json } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/health', (c) =>
  json(c, { status: 'ok' as const, ts: Math.floor(Date.now() / 1000) })
);
