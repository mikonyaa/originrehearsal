import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { caseSchema, loadCase } from '../../dist/config/index.js';
import { Checks, canonical, deepFreeze, localJSON } from '../../dist/sdk/index.js';
import { combinedOutcome } from '../../dist/runner/index.js';
import { assertIdentity } from '../../dist/runner/evidence.js';
import { Gateway, inspectBuild } from '../../dist/gateway/index.js';
import { renderHTML, escapeHTML } from '../../dist/report/index.js';
import { fixtureRoot, output, copyCase } from '../helpers.mjs';

test('strict schema rejects ambiguous IDs, invalid limits/paths, duplicate names and unknown fields', async () => {
  const good = JSON.parse(await readFile(join(fixtureRoot, 'upgrade-case.json'), 'utf8'));
  assert.equal(caseSchema.safeParse(good).success, true);
  for (const mutate of [c => c.new.buildId = c.old.buildId, c => c.limits.phaseTimeoutMs = 0, c => c.limits.maxRecordsPerStore = 1.5, c => c.storage.localStorageKeys.push('ui-prefs'), c => c.storage.indexedDB.push(c.storage.indexedDB[0]), c => c.userDataDir = '/normal/Chrome']) {
    const config = structuredClone(good); mutate(config); assert.equal(caseSchema.safeParse(config).success, false);
  }
  for (const hooks of ['https://example.com/hook.mjs', 'data:text/javascript,seed', './hook.ts']) {
    const { file } = await copyCase('bad-hooks', c => c.hooks = hooks); await assert.rejects(loadCase(file), /local .mjs/);
  }
  const { file } = await copyCase('bad-app-path', c => c.app.path = '//localhost:1/'); await assert.rejects(loadCase(file), /gateway origin/);
  const missing = await copyCase('missing-build', c => c.new.dir = './missing'); await assert.rejects(loadCase(missing.file), /ENOENT/);
});
test('SDK refuses empty contracts and invalid subjects; allowed deletion is explicit', () => {
  assert.throws(() => new Checks(['indexedDB/notes/scratch']).finish(), /Empty storage contract/);
  const allowed = new Checks(['indexedDB/notes/scratch']); allowed.allowedAbsent('remove', 'indexedDB/notes/scratch', { state: 'missing' }, 'Transient by specification'); assert.equal(allowed.finish()[0].outcome, 'PASS');
  const required = new Checks(['indexedDB/notes/scratch']); required.requiredPresence('retain', 'indexedDB/notes/scratch', { state: 'missing' }, 'Required by a different specification'); assert.equal(required.finish()[0].outcome, 'VIOLATION');
  assert.throws(() => required.equal('other', 'cookies/auth', 1, 1, 'Not selected'), /outside selected/);
  assert.throws(() => required.equal('retain', 'indexedDB/notes/scratch', 1, 1, 'duplicate'), /Duplicate/);
  const nullable = new Checks(['indexedDB/notes/notes']); nullable.preservedFields('nullable', 'indexedDB/notes/notes', [{ id: 'a', value: null }], [{ id: 'a' }], ['value']); assert.equal(nullable.finish()[0].outcome, 'VIOLATION');
  assert.throws(() => new Checks(['localStorage/key']).equal('infinite', 'localStorage/key', Infinity, 1, 'Invalid value'), /finite/);
  assert.throws(() => localJSON({ localStorage: { broken: { state: 'present', value: '{bad' } } }, 'broken'), /not valid JSON/);
  assert.throws(() => localJSON({ localStorage: { empty: { state: 'present', value: '' } } }, 'empty'), /present but is not valid JSON/);
});
test('immutable values and explicit logical fingerprint canonicalization', () => {
  const value = deepFreeze({ values: [{ id: 'a', value: 2 }] }); assert.throws(() => value.values[0].value = 3, TypeError);
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  const checks = new Checks(['localStorage/key']); assert.throws(() => checks.fingerprint({ a: 1 }, []), /normalization/);
});
test('outcome priority and identity never accept stale code, origin or profile substitutions', () => {
  assert.equal(combinedOutcome(['PASS', 'VIOLATION', 'UNSUPPORTED', 'ERROR']), 'ERROR');
  assert.equal(combinedOutcome(['VIOLATION', 'UNSUPPORTED']), 'UNSUPPORTED');
  const evidence = { origin: 'http://127.0.0.1:1234', profileId: 'owned', userDataDirConfirmed: true, backendConfirmed: true, appConfirmed: true, expectedAppId: 'new', executedAppId: 'new' };
  for (const change of [{ origin: 'http://localhost:1234' }, { origin: 'http://127.0.0.1:1235' }, { profileId: 'fresh' }, { userDataDirConfirmed: false }, { appConfirmed: false, executedAppId: 'old' }]) assert.throws(() => assertIdentity({ ...evidence, ...change }, evidence.origin, evidence.profileId));
});
test('gateway path safety, immutable hashes, MIME, read-only endpoint and explicit SPA fallback', async () => {
  const dir = await output('gateway'); await writeFile(join(dir, 'index.html'), 'safe index'); await writeFile(join(dir, 'app.js'), 'safe JS');
  const build = await inspectBuild(dir); assert.equal(build.hash, (await inspectBuild(dir)).hash);
  const gateway = new Gateway(build, build, 'unit-run', true); await gateway.listen();
  try {
    const fetchRaw = path => new Promise((res, rej) => { const req = request({ hostname: '127.0.0.1', port: new URL(gateway.origin).port, path }, response => { response.resume(); res(response.statusCode); }); req.on('error', rej); req.end(); });
    for (const path of ['/%2e%2e/secret', '/..%2Fsecret', '/%5C..%5Csecret', '/%00', '/%xx']) assert.equal(await fetchRaw(path), 400);
    assert.equal((await fetch(`${gateway.origin}/folder`)).status, 404);
    assert.equal((await fetch(`${gateway.origin}/route`, { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal((await fetch(`${gateway.origin}/missing.js`, { headers: { Accept: 'text/html' } })).status, 404);
    assert.equal((await fetch(`${gateway.origin}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${gateway.origin}/`)).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${gateway.origin}/__originrehearsal__/switch`)).status, 404);
    assert.equal((await fetch(`${gateway.origin}/__originrehearsal__/phase?challenge=hello`, { method: 'POST' })).status, 405);
    assert.equal((await gateway.observe()).challenge.length, 36);
    await writeFile(join(dir, 'app.js'), 'changed JS'); assert.equal((await fetch(`${gateway.origin}/app.js`)).status, 500); await assert.rejects(gateway.assertImmutable(), /changed/);
  } finally { await gateway.close(); }
  const other = await output('symlink'); await writeFile(join(other, 'index.html'), 'safe'); await symlink(join(dir, 'app.js'), join(other, 'escape.js')); await assert.rejects(inspectBuild(other), /symlinks/);
});
test('HTML escapes hostile values including closing script tags', () => {
  assert.equal(escapeHTML('</script><img onerror="x">'), '&lt;/script&gt;&lt;img onerror=&quot;x&quot;&gt;');
  const run = { schemaVersion: 1, toolVersion: '0.1.0', runId: 'x', caseId: '</script><img src=x onerror=alert(1)>', outcome: 'ERROR', exitCode: 2, origin: 'javascript:alert(1)', environment: { node: 'n', playwright: 'p', chromium: 'c', os: 'o', arch: 'a' }, seed: {}, coverage: { complete: false, localStorageKeys: [], indexedDB: [] }, digests: {}, diagnostics: [{ outcome: 'ERROR', phase: '<script>', reason: '<img onerror=alert(1)>' }], events: [], limitations: [], cleanup: {}, startedAt: '', finishedAt: '' };
  const html = renderHTML(run); assert.equal(html.includes('<img src=x'), false); assert.equal(html.includes('href="javascript:'), false); assert.equal((html.match(/<script>/g) ?? []).length, 1);
});
