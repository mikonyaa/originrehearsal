import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureStorage } from '../../dist/probes/index.js';
import { runCase } from '../../dist/runner/index.js';
import { expected, fixtureRoot, output, lowFixture, nativeInventory } from '../helpers.mjs';
import { join } from 'node:path';
const limits = { phaseTimeoutMs: 3000, maxRecordsPerStore: 1000, maxSnapshotBytes: 5000000 };
const selection = { localStorageKeys: ['missing', 'empty', 'ui-prefs'], indexedDB: [{ name: 'notes', stores: ['notes', 'missing-store'] }, { name: 'never-created', stores: ['store'] }] };
test('native probe is read-only: databases, versions, stores and records stay unchanged; missing stays missing', async () => {
  const fixture = await lowFixture();
  try {
    const { page } = await fixture.open(); await page.evaluate(async data => { await window.notesApp.seed(data); localStorage.setItem('empty', ''); }, expected);
    const before = await nativeInventory(page); const snapshot = await captureStorage(page, selection, limits); const after = await nativeInventory(page);
    assert.deepEqual(after, before); assert.equal(snapshot.complete, true); assert.equal(snapshot.indexedDB['never-created'].state, 'missing');
    assert.equal(snapshot.indexedDB.notes.version, 1); assert.equal(snapshot.indexedDB.notes.stores['missing-store'].state, 'missing');
    assert.equal(snapshot.localStorage.empty.state, 'present'); assert.equal(snapshot.localStorage.empty.value, ''); assert.equal(snapshot.localStorage.missing.state, 'missing');
    assert.deepEqual(snapshot.indexedDB.notes.stores.notes.records.map(row => row.value), expected.notes);
  } finally { await fixture.close(); }
});
test('probe connection closes and does not block a subsequent native database upgrade', async () => {
  const fixture = await lowFixture();
  try {
    const { page } = await fixture.open();
    await page.evaluate(() => new Promise((res, rej) => { const r = indexedDB.open('probe-only', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error); }));
    await captureStorage(page, { localStorageKeys: [], indexedDB: [{ name: 'probe-only', stores: ['s'] }] }, limits);
    const version = await page.evaluate(() => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Upgrade blocked')), 1500); const r = indexedDB.open('probe-only', 2);
      r.onblocked = () => rej(new Error('Probe left an open reader')); r.onerror = () => rej(r.error);
      r.onsuccess = () => { clearTimeout(timer); const version = r.result.version; r.result.close(); res(version); };
    })); assert.equal(version, 2);
  } finally { await fixture.close(); }
});
test('database disappearance between enumeration and open aborts accidental creation', async () => {
  const fixture = await lowFixture();
  try {
    const { page } = await fixture.open(); await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('vanishing', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error);
    }));
    await page.evaluate(() => {
      const original = indexedDB.databases.bind(indexedDB); window.originalDatabases = original;
      indexedDB.databases = async () => { const result = await original(); await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('vanishing'); r.onsuccess = res; r.onerror = () => rej(r.error); }); return result; };
    });
    const snapshot = await captureStorage(page, { localStorageKeys: [], indexedDB: [{ name: 'vanishing', stores: ['s'] }] }, limits);
    assert.equal(snapshot.indexedDB.vanishing.state, 'missing'); assert.match(snapshot.indexedDB.vanishing.reason, /creation was aborted/);
    assert.equal(await page.evaluate(async () => (await window.originalDatabases()).some(db => db.name === 'vanishing')), false);
  } finally { await fixture.close(); }
});
test('missing store and unreadable store have different states; timeout is an error', async () => {
  const fixture = await lowFixture();
  try {
    const { page } = await fixture.open(); await page.evaluate(() => { IDBDatabase.prototype.transaction = function() { throw new DOMException('Synthetic read denial', 'SecurityError'); }; });
    const snapshot = await captureStorage(page, selection, limits); assert.equal(snapshot.indexedDB.notes.stores.notes.state, 'error'); assert.equal(snapshot.indexedDB.notes.stores['missing-store'].state, 'missing'); assert.equal(snapshot.complete, false);
    await page.evaluate(() => { indexedDB.databases = () => new Promise(() => {}); });
    const timed = await captureStorage(page, selection, { ...limits, phaseTimeoutMs: 500 }); assert.equal(timed.indexedDB.notes.state, 'error'); assert.match(timed.indexedDB.notes.reason, /timed out/);
  } finally { await fixture.close(); }
});
test('native typed values and unsupported keys are detected before serialization', async () => {
  const fixture = await lowFixture();
  try {
    const { page } = await fixture.open();
    for (const type of ['date', 'map', 'set', 'blob', 'buffer', 'bigint', 'undefined', 'nan', 'cycle', 'array-key', 'date-key', 'buffer-key']) {
      await page.evaluate(type => new Promise((res, rej) => {
        const r = indexedDB.open('typed', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const db = r.result, tx = db.transaction('s', 'readwrite'), store = tx.objectStore('s'); store.clear(); const cycle = {}; cycle.self = cycle;
          const value = { date: new Date(), map: new Map([['k', 'v']]), set: new Set(['v']), blob: new Blob(['v']), buffer: new ArrayBuffer(1), bigint: 1n, undefined: undefined, nan: NaN, cycle }[type];
          const key = { 'array-key': ['a', 1], 'date-key': new Date(), 'buffer-key': new ArrayBuffer(1) }[type] ?? 'key';
          store.put(type.endsWith('-key') ? { value: 'valid' } : { value }, key); tx.oncomplete = () => { db.close(); res(); }; tx.onabort = () => { db.close(); rej(tx.error); };
        };
      }), type);
      const snapshot = await captureStorage(page, { localStorageKeys: [], indexedDB: [{ name: 'typed', stores: ['s'] }] }, limits);
      assert.equal(snapshot.complete, false, type); assert.equal(snapshot.indexedDB.typed.stores.s.state, 'unsupported', type); assert.equal('records' in snapshot.indexedDB.typed.stores.s, false);
    }
  } finally { await fixture.close(); }
});
test('record/byte limits do not produce truncated success; real typed upgrade returns UNSUPPORTED', async () => {
  const fixture = await lowFixture();
  try {
    const { page } = await fixture.open(); await page.evaluate(async data => window.notesApp.seed(data), expected);
    for (const override of [{ maxRecordsPerStore: 19 }, { maxSnapshotBytes: 256 }]) {
      const snapshot = await captureStorage(page, selection, { ...limits, ...override }); assert.equal(snapshot.complete, false); assert.equal(snapshot.problems.some(problem => problem.outcome === 'UNSUPPORTED'), true);
      assert.equal(snapshot.indexedDB.notes.state !== 'present' || snapshot.indexedDB.notes.stores.notes.state === 'unsupported', true);
    }
  } finally { await fixture.close(); }
  const out = await output('typed-upgrade'); const run = await runCase(join(fixtureRoot, 'typed-case.json'), { out });
  assert.equal(run.outcome, 'UNSUPPORTED'); assert.equal(run.exitCode, 3); assert.equal(run.control.outcome, 'PASS'); assert.deepEqual(run.upgrade.checks.upgrade, []);
});
