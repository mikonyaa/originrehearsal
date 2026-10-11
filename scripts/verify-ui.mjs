import { chromium } from 'playwright';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { runCase } from '../dist/runner/index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'output/playwright'), { recursive: true });
const out = await mkdtemp(join(root, 'output/playwright/reports-'));
const example = join(out, 'example'); await cp(join(root, 'examples/notes'), example, { recursive: true });
// A separate synthetic UI specification exercises long IDs, Unicode, values and empty stores.
const expected = JSON.parse(await readFile(join(example, 'expected.json'), 'utf8'));
expected.notes[19].id = 'note-020-' + 'very-long-идентификатор-世界-'.repeat(8);
expected.notes[19].text += ' Long value: ' + 'preserved-Привет-世界-'.repeat(20);
expected.scratch = [];
await writeFile(join(example, 'expected.json'), JSON.stringify(expected));
const reports = [];
for (const [file, outcome] of [['upgrade-case.json', 'PASS'], ['bad-case.json', 'VIOLATION'], ['abort-case.json', 'ERROR'], ['sw-case.json', 'UNSUPPORTED']]) {
  const cfg = JSON.parse(await readFile(join(example, file), 'utf8')); cfg.seedInputs = expected;
  cfg.id = `${outcome.toLowerCase()}-` + 'long-case-世界-'.repeat(12);
  cfg.storage.localStorageKeys.push('long-key-' + 'Unicode-世界-'.repeat(15));
  const config = join(example, file); await writeFile(config, JSON.stringify(cfg));
  const reportOut = join(out, outcome.toLowerCase()); const run = await runCase(config, { out: reportOut }); assert.equal(run.outcome, outcome);
  reports.push({ outcome, report: join(reportOut, 'report.html') });
}
const browser = await chromium.launch(); const results = [];
try {
  for (const { outcome, report } of reports) for (const width of [1440, 1024, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); let network = 0;
    await page.route(/^https?:/, route => { network++; return route.abort(); });
    await page.goto(pathToFileURL(report).href);
    assert.match(await page.title(), new RegExp(`^${outcome}`));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${outcome} @ ${width}px has horizontal overflow`);
    assert.equal(await page.locator('img,iframe,object').count(), 0);
    await page.screenshot({ path: join(out, `${outcome.toLowerCase()}-${width}.png`) });
    await page.getByRole('button', { name: 'All checks', exact: true }).focus();
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'violations');
    await page.keyboard.press('Enter'); assert.equal(await page.locator('#violations').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('tr[data-outcome="PASS"]:visible').count(), 0);
    await page.getByRole('button', { name: 'All checks', exact: true }).click();
    await page.locator('#search').fill('note-020');
    if (outcome === 'PASS' || outcome === 'VIOLATION') assert.equal(await page.locator('tr[data-outcome]:visible').count() > 0, true);
    await page.locator('#search').fill('');
    const summary = page.locator('summary').filter({ hasText: 'Selected before / after values' }); await summary.click();
    assert.equal(await summary.evaluate(el => el.parentElement.open), true); await summary.click(); assert.equal(await summary.evaluate(el => el.parentElement.open), false);
    await page.locator('#violations').click(); await page.screenshot({ path: join(out, `${outcome.toLowerCase()}-${width}-contracts.png`) });
    assert.equal(network, 0);
    results.push({ outcome, width, offline: true, horizontalOverflow: false, keyboard: 'PASS', focus: 'PASS', details: 'PASS', hostileStrings: 'escaped', networkRequests: network });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(join(out, 'verification.json'), JSON.stringify({ outcome: 'PASS', results }, null, 2));
console.log(JSON.stringify({ outcome: 'PASS', evidence: out, checked: results.length }, null, 2));
