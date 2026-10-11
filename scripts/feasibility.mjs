import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Gateway, inspectBuild } from '../dist/gateway/index.js';

const base = new URL('../examples/notes/dist/', import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'originrehearsal-feasibility-'));
const evidence = { schemaVersion: 1, profiles: [], scenarios: [], jsonRestore: false };
let context;
const old = await inspectBuild(new URL('v1/', base).pathname);
const next = await inspectBuild(new URL('v2/', base).pathname);
const gateway = new Gateway(old, next, 'feasibility');
try {
  await gateway.listen(); evidence.origin = gateway.origin;
  const browserOptions = { headless: true };
  for (const kind of ['good', 'bad']) {
    const profile = join(root, kind); await mkdir(profile, { mode: 0o700 });
    await gateway.switchTo('old');
    context = await chromium.launchPersistentContext(profile, browserOptions);
    const page = context.pages()[0]; await page.goto(gateway.origin);
    await page.waitForSelector('[data-app-ready="true"]');
    assert.equal(await page.locator('html').getAttribute('data-app-build'), 'notes-v1');
    await page.getByRole('button', { name: 'Load 20 synthetic notes' }).click();
    await page.waitForSelector('[data-saved="true"]');
    assert.equal(await page.locator('#count').textContent(), '20 saved notes');
    const oldOrigin = await page.evaluate(() => location.origin);
    const browser = context.browser(); evidence.chromium = browser.version();
    await context.close(); context = undefined;
    assert.equal(browser.isConnected(), false);
    evidence.profiles.push({ kind, browserClosed: true, sameUserDataDir: true, oldOrigin });
    if (kind === 'bad') {
      // Reuse the same single listening gateway, changing only the build root.
      gateway.next.root = (await inspectBuild(new URL('bad/', base).pathname)).root;
      gateway.next.hash = (await inspectBuild(gateway.next.root)).hash;
      gateway.next.files = (await inspectBuild(gateway.next.root)).files;
    }
    await gateway.switchTo('new'); const backend = await gateway.observe();
    context = await chromium.launchPersistentContext(profile, browserOptions);
    const afterPage = context.pages()[0]; await afterPage.goto(gateway.origin);
    await afterPage.waitForSelector('[data-app-ready="true"]');
    const appId = await afterPage.locator('html').getAttribute('data-app-build');
    assert.equal(appId, kind === 'good' ? 'notes-v2' : 'notes-v2-bad');
    assert.equal(await afterPage.evaluate(() => location.origin), oldOrigin);
    const rows = await afterPage.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('notes'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result; const tx = db.transaction('notes', 'readonly'); const read = tx.objectStore('notes').getAll();
        tx.oncomplete = () => { db.close(); resolve(read.result); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }));
    assert.equal(rows.length, kind === 'good' ? 20 : 5);
    assert.equal(rows[0].body, 'Note 01: Preserve this text — Привет, 世界.');
    evidence.scenarios.push({ kind, backend, executedAppId: appId, noteCount: rows.length, expectedOutcome: kind === 'good' ? 'PASS' : 'VIOLATION' });
    await context.close(); context = undefined;
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2));
} finally { if (context) await context.close(); await gateway.close(); await rm(root, { recursive: true, force: true }); }
