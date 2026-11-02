/**
 * Drive the built app in a real phone-sized browser and take screenshots.
 *
 * Not part of the test suite (it needs a running server and a downloaded
 * browser), but it is the only way to check the thing people actually look at.
 *
 *   cd server && python -m app.main            # or any built instance
 *   node web/scripts/shots.mjs [baseUrl] [outDir]
 */

import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8099';
const OUT = process.argv[3] ?? 'shots';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['Pixel 7'],
  serviceWorkers: 'allow',
});
const page = await context.newPage();

async function shot(name) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${OUT}/${name}.png`);
}

console.log('list screen');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.card__title');
await shot('1-list');

console.log('detail screen');
await page.locator('.card').first().click();
await page.waitForSelector('.timeline');
await shot('2-detail');

console.log('write action, with the network cut');
await context.setOffline(true);
await page.waitForTimeout(500);
await page.getByRole('button', { name: /file report/i }).click();
await page.getByRole('button', { name: 'Blocked' }).click();
await page
  .getByLabel(/notes/i)
  .fill('Approach road impassable after the storm. Turned back at the rail crossing.');
await page.getByLabel(/your name/i).fill('A. Yadegar');
await shot('3-sheet-offline');

await page.getByRole('button', { name: /save to outbox/i }).click();
await page.waitForSelector('.timeline__item[data-pending="true"]');
await shot('4-detail-queued-offline');

console.log('outbox, still offline');
await page.getByRole('link', { name: /outbox/i }).click();
await page.waitForSelector('.card--queued');
await shot('5-outbox-offline');

console.log('back online: the queue drains by itself');
await context.setOffline(false);
await page.waitForSelector('.empty', { timeout: 15000 });
await shot('6-outbox-drained');

await page.getByRole('link', { name: /sites/i }).click();
await page.waitForSelector('.card__title');
await shot('7-list-synced');

await browser.close();
console.log('done');
