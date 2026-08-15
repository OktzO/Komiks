import { test } from '@playwright/test';
test('bookmark page: no 429 / portrait card / login redirect', async ({ page }) => {
  await page.goto('https://oktzz.xyz/bookmark');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  const t = await page.locator('main').textContent();
  console.log('HAS429:', /429/.test(t));
  console.log('GUEST_CTA:', /Masuk untuk lihat bookmark/.test(t));
  const cards = await page.locator('.aspect-\\[3\\/4\\]').count();
  console.log('PORTRAIT_CARDS:', cards);
  await page.screenshot({ path: '/tmp/bm-check.png', fullPage: true });
});
