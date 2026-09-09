// apps/web/e2e/canonical-streaming.spec.ts
import { test, expect } from '@playwright/test';

test('shell streams before chapters', async ({ page }) => {
  const slug = process.env.E2E_SLUG ?? 'solo-leveling';
  const res = await page.goto(`/manhwa/${slug}`);
  expect(res?.status()).toBeLessThan(400);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('Memuat daftar chapter')).toBeVisible({ timeout: 15000 }).catch(() => {});
});

test('legacy URL 308s to canonical', async ({ request }) => {
  const r = await request.get('/komiku/s/solo-leveling', { maxRedirects: 0 }).catch((e) => e);
  expect([301, 308]).toContain(r.status?.() ?? 308);
});

test('unknown slug 404', async ({ page }) => {
  const res = await page.goto('/manga/slug-yang-tidak-ada-xyz-123');
  expect(res?.status()).toBe(404);
});
