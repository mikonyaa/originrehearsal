import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { caseSchema } from '../dist/config/index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}schemas`, { recursive: true });
await writeFile(`${root}schemas/upgrade-case.schema.json`, JSON.stringify(z.toJSONSchema(caseSchema, { io: 'input' }), null, 2) + '\n');
const app = await readFile(`${root}examples/notes/app-source.mjs`, 'utf8');
const html = await readFile(`${root}examples/notes/index-source.html`, 'utf8');
const data = await readFile(`${root}fixtures/expected/notes.json`, 'utf8');
await writeFile(`${root}examples/notes/expected.json`, data);
for (const [dir, mode, id] of [
  ['v1', 'old', 'notes-v1'], ['v2', 'good', 'notes-v2'], ['bad', 'bad', 'notes-v2-bad'],
  ['mutant', 'mutant', 'notes-v2-mutant'], ['abort', 'abort', 'notes-v2-abort'],
  ['sw', 'sw', 'notes-v1-sw'], ['typed', 'typed', 'notes-v2-typed'],
]) {
  const path = `${root}examples/notes/dist/${dir}`; await mkdir(path, { recursive: true });
  await writeFile(`${path}/index.html`, html);
  await writeFile(`${path}/app.js`, app.replace('__BUILD_ID__', id).replace('__MODE__', mode));
  await writeFile(`${path}/dataset.json`, data);
  if (mode === 'sw') await writeFile(`${path}/sw.js`, `
self.addEventListener('install', event => event.waitUntil(caches.open('old-app').then(cache => cache.addAll(['/', '/app.js', '/dataset.json'])).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => { if (['/', '/app.js', '/dataset.json'].includes(new URL(event.request.url).pathname)) event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))); });\n`);
}
