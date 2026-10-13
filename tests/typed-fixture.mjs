import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function createTypedFixture(dir) {
  const source = fileURLToPath(new URL('./fixtures/typed-keys/', import.meta.url));
  await cp(source, dir, { recursive: true, force: false, errorOnExist: true });
  const app = await readFile(join(source, 'app-source.mjs'), 'utf8');
  const seed = JSON.parse(await readFile(join(source, 'seed.json'), 'utf8'));
  for (const [name, mode] of [['old', 'old'], ['good', 'good'], ['bad', 'bad']]) {
    const build = join(dir, name); await mkdir(build);
    await writeFile(join(build, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Independent typed-record fixture</title></head><body><p>Synthetic IndexedDB upgrade fixture.</p><script type="module" src="/app.js"></script></body></html>');
    await writeFile(join(build, 'app.js'), app.replace('__MODE__', mode).replace('__BUILD_ID__', `typed-${name}`));
  }
  const base = { schemaVersion: 1, id: 'typed-key-good', old: { dir: './old', buildId: 'typed-old' }, new: { dir: './good', buildId: 'typed-good' }, app: { buildSelector: 'html', buildAttribute: 'data-app-build', readySelector: '[data-app-ready="true"]', errorSelector: '[data-app-error]' }, hooks: './hooks.mjs', seedInputs: { core: seed.core }, storage: { localStorageKeys: [], indexedDB: [{ name: 'audit-keyed-records', stores: ['records'] }] } };
  await writeFile(join(dir, 'good.json'), JSON.stringify(base, null, 2) + '\n');
  await writeFile(join(dir, 'bad.json'), JSON.stringify({ ...base, id: 'typed-key-bad', new: { dir: './bad', buildId: 'typed-bad' } }, null, 2) + '\n');
  await writeFile(join(dir, 'edges.json'), JSON.stringify({ ...base, id: 'typed-key-edges', seedInputs: seed, storage: { localStorageKeys: ['optional/missing'], indexedDB: [...base.storage.indexedDB, { name: 'a/b', stores: ['c'] }, { name: 'a', stores: ['b/c', 'b'] }, { name: 'a/b/c', stores: ['ghost'] }] } }, null, 2) + '\n');
  return base;
}
