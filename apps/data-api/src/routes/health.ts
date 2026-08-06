import { Hono } from 'hono';
import type { Env } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/health', (c) => c.json({ status: 'ok', service: 'manga-data-api', ts: Date.now() }));
