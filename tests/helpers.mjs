import { readFile, mkdir, mkdtemp, writeFile, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Gateway, inspectBuild } from '../dist/gateway/index.js';
import { OwnedProfiles } from '../dist/profile/index.js';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const fixtureRoot = join(root, 'examples/notes');
export const expected = JSON.parse(await readFile(join(root, 'fixtures/expected/notes.json'), 'utf8'));
export async function output(label) {
  await mkdir(join(root, 'artifacts/tests'), { recursive: true });
  return mkdtemp(join(root, `artifacts/tests/${label}-`));
}
export function cli(args, options = {}) {
  const child = spawn(process.execPath, [join(root, 'dist/cli/main.js'), ...args], { cwd: root, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error(`CLI test timed out: ${args.join(' ')}`)); }, 120_000);
    child.once('error', reject); child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done, waitFor: async text => {
    for (let n = 0; n < 400; n++) { if (stderr.includes(text)) return; await new Promise(res => setTimeout(res, 25)); }
    throw new Error(`Progress did not reach ${text}: ${stderr}`);
  } };
}
export async function copyCase(label, change = () => {}, hookSuffix = '') {
  const dir = await output(label); const example = join(dir, 'example'); await cp(fixtureRoot, example, { recursive: true });
  const cfg = JSON.parse(await readFile(join(example, 'upgrade-case.json'), 'utf8')); change(cfg);
  const file = join(example, 'upgrade-case.json'); await writeFile(file, JSON.stringify(cfg));
  if (hookSuffix) await writeFile(join(example, 'upgrade.hooks.mjs'), hookSuffix);
  return { dir, file, cfg, out: join(dir, 'run') };
}
export async function lowFixture(oldDir = 'v1', nextDir = 'v2') {
  const profiles = new OwnedProfiles(); await profiles.prepare();
  const gateway = new Gateway(await inspectBuild(join(fixtureRoot, 'dist', oldDir)), await inspectBuild(join(fixtureRoot, 'dist', nextDir)), 'low-fixture'); await gateway.listen();
  const owned = [];
  return { gateway, profiles, async open(kind = 'upgrade', reuse) {
    const profile = reuse ?? await profiles.create(kind); if (!reuse) owned.push(profile);
    const page = await profile.launch(10_000); await page.goto(gateway.origin); await page.waitForSelector('[data-app-ready="true"]');
    return { page, profile };
  }, async close() {
    for (const profile of owned) { await profile.close(); await profiles.remove(profile); } await gateway.close(); await profiles.cleanup();
  } };
}
// Independent native-browser observation, deliberately does not call the production probe/evaluator.
export async function nativeInventory(page) {
  return page.evaluate(async () => {
    const result = {};
    for (const meta of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(meta.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      try {
        const stores = {};
        for (const name of db.objectStoreNames) stores[name] = await new Promise((res, rej) => {
          const tx = db.transaction(name, 'readonly'), keys = tx.objectStore(name).getAllKeys(), values = tx.objectStore(name).getAll();
          tx.oncomplete = () => res({ keys: keys.result, values: values.result }); tx.onabort = () => rej(tx.error);
        });
        result[meta.name] = { version: db.version, stores };
      } finally { db.close(); }
    }
    return { databases: result, localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])) };
  });
}
