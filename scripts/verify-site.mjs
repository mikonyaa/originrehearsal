import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const [name, outcome] of [['good', 'PASS'], ['bad', 'VIOLATION']]) {
  const json = JSON.parse(await readFile(join(root, `site/reports/${name}.json`), 'utf8')); assert.equal(json.outcome, outcome); assert.equal(json.control.outcome, 'PASS'); assert.equal(json.seed.fingerprintsMatch, true); assert.equal(json.cleanup.ownedRootRemoved, true);
  assert.equal(json.upgrade.closure[0].processExited, true); assert.equal(json.upgrade.builds[1].appConfirmed, true);
}
const browser = await chromium.launch();
try {
  for (const width of [1440, 1024, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); await page.goto(pathToFileURL(join(root, 'site/index.html')).href);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const video = page.locator('video'); assert.equal(await video.getAttribute('controls'), '');
    await video.evaluate(el => el.play()); await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1); await video.evaluate(el => el.pause());
    assert.equal(await video.evaluate(el => el.duration > 20 && el.duration < 35), true);
    const detail = page.locator('summary'); await detail.click(); assert.equal(await detail.evaluate(el => el.parentElement.open), true);
    const link = page.getByRole('link', { name: 'Real VIOLATION report', exact: true }); await link.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); assert.equal(await link.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await link.click(); assert.match(await page.title(), /^VIOLATION/); await page.locator('#violations').click(); assert.equal(await page.locator('tr[data-outcome="PASS"]:visible').count(), 0);
    await page.close();
  }
} finally { await browser.close(); }
console.log('PASS: allowlisted static demo, real outcomes, video, direct report links and responsive controls.');
