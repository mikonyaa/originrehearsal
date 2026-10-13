import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHTML } from '../../dist/report/index.js';

const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const snapshot = indexedDB => ({ capturedAt: '', origin: 'http://127.0.0.1:1234', complete: true, localStorage: {}, indexedDB, problems: [] });
const database = records => ({ state: 'present', version: 1, stores: { records: { state: 'present', records } } });
function renderedRows(before, after) {
  const run = { schemaVersion: 1, toolVersion: '0.1.0', runId: 'renderer-unit', caseId: 'renderer-unit', buildIds: { old: 'v1', new: 'v2' }, outcome: 'PASS', exitCode: 0, origin: before?.origin ?? '', environment: { node: 'test', playwright: 'test', chromium: 'test', os: 'test', arch: 'test' }, seed: { inputDigest: '', controlRunId: '', upgradeRunId: '', fingerprintsMatch: true }, coverage: { complete: true, localStorageKeys: [], indexedDB: [] }, digests: { config: '', hooks: '', old: '', new: '' }, diagnostics: [], events: [], limitations: [], cleanup: { gatewayClosed: true, ownedRootRemoved: true }, startedAt: '', finishedAt: '', upgrade: { runId: 'upgrade-unit', kind: 'upgrade', profileId: 'unit', outcome: 'PASS', before, after, builds: [], checks: { seed: [], cold: [], upgrade: [] }, events: [], closure: [], cleanup: { browserClosed: true, profileRemoved: true } } };
  const html = renderHTML(run);
  const section = html.split('<h2>Storage observations</h2>')[1].split('</table>')[0];
  const count = Number(section.match(/\((\d+) subjects\)/)[1]);
  const rows = [...section.matchAll(/<tr([^>]*)><td[^>]*><code>([\s\S]*?)<\/code><\/td><td[^>]*><pre>([\s\S]*?)<\/pre><\/td><td[^>]*><pre>([\s\S]*?)<\/pre><\/td><\/tr>/g)].map(([, attributes, subject, beforeJSON, afterJSON]) => ({ attributes, subject: decode(subject), before: JSON.parse(decode(beforeJSON)), after: JSON.parse(decode(afterJSON)) }));
  assert.equal(rows.length, count, 'Summary cardinality must equal the rendered row count');
  return { rows, html };
}

// These literal expected values do not use the report's identity/presence helpers.
test('renderer keeps number 1, string "1" and null as three distinct record subjects', () => {
  const records = [{ key: 1, value: 'NUMERIC_KEY_SENTINEL' }, { key: '1', value: 'STRING_KEY_SENTINEL' }, { key: 'nullable', value: null }];
  const before = snapshot({ 'audit-keyed-records': database(records) });
  const { rows } = renderedRows(before, before);
  assert.equal(rows.length, 5, 'one database + one store + all three records');
  for (const value of ['NUMERIC_KEY_SENTINEL', 'STRING_KEY_SENTINEL', null]) {
    const row = rows.find(row => row.before === value);
    assert.ok(row, `Missing observed ${JSON.stringify(value)}`);
    assert.deepEqual(row.after, value);
  }
  assert.match(rows.find(row => row.before === 'NUMERIC_KEY_SENTINEL').subject, /number.*1/);
  assert.match(rows.find(row => row.before === 'STRING_KEY_SENTINEL').subject, /string.*"1"/);
});
test('renderer preserves false, zero and empty string without absence substitution', () => {
  const before = snapshot({ db: database([{ key: 'false', value: false }, { key: 'zero', value: 0 }, { key: 'empty', value: '' }]) });
  const { rows } = renderedRows(before, before);
  assert.equal(rows.length, 5);
  for (const value of [false, 0, '']) assert.deepEqual(rows.find(row => row.before === value)?.after, value);
});
test('renderer distinguishes a present null from before-only and after-only records', () => {
  const before = snapshot({ db: database([{ key: 'nullable', value: null }, { key: 'removed', value: false }]) });
  const after = snapshot({ db: database([{ key: 'nullable', value: null }, { key: 'added', value: 0 }]) });
  const { rows } = renderedRows(before, after);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.find(row => row.before === null)?.after, null);
  assert.deepEqual(rows.find(row => row.before === false)?.after, { state: 'not-observed' });
  assert.deepEqual(rows.find(row => row.after === 0)?.before, { state: 'not-observed' });
});
test('renderer does not merge database, store or record subjects when names contain slashes', () => {
  const before = snapshot({
    'a/b': { state: 'present', version: 1, stores: { c: { state: 'present', records: [{ key: 'd/e', value: 'LEFT' }] } } },
    a: { state: 'present', version: 2, stores: { 'b/c': { state: 'present', records: [{ key: 'd/e', value: 'RIGHT' }] }, b: { state: 'present', records: [{ key: 'c', value: 'RECORD_NOT_STORE' }] } } },
    'a/b/c': { state: 'missing' },
  });
  const { rows } = renderedRows(before, before);
  assert.equal(rows.length, 9, 'three database + three store + three record subjects');
  for (const value of ['LEFT', 'RIGHT', 'RECORD_NOT_STORE']) assert.deepEqual(rows.find(row => row.before === value)?.after, value);
  assert.equal(rows.filter(row => row.attributes.includes('data-subject-kind="database"')).length, 3);
  assert.equal(rows.filter(row => row.attributes.includes('data-subject-kind="store"')).length, 3);
  assert.equal(rows.filter(row => row.attributes.includes('data-subject-kind="record"')).length, 3);
});
test('renderer preserves already-tagged missing, read-error and unsupported observations', () => {
  const before = snapshot({ missing: { state: 'missing' }, denied: { state: 'error', reason: 'read denied' }, typed: { state: 'unsupported', reason: 'binary key' }, db: { state: 'present', version: 1, stores: { missing: { state: 'missing' }, error: { state: 'error', reason: 'aborted' }, unsupported: { state: 'unsupported', reason: 'Date' } } } });
  before.localStorage = { absent: { state: 'missing' }, empty: { state: 'present', value: '' }, denied: { state: 'error', reason: 'SecurityError' } };
  const { rows } = renderedRows(before, before);
  assert.equal(rows.length, 10);
  for (const observation of [{ state: 'missing' }, { state: 'error', reason: 'read denied' }, { state: 'unsupported', reason: 'binary key' }, { state: 'error', reason: 'aborted' }, { state: 'unsupported', reason: 'Date' }, { state: 'present', value: '' }, { state: 'error', reason: 'SecurityError' }]) {
    const row = rows.find(row => JSON.stringify(row.before) === JSON.stringify(observation));
    assert.ok(row); assert.deepEqual(row.after, observation);
  }
});
test('renderer escapes HTML-like values and keys in selected rows without changing JSON values', () => {
  const value = '</script><img src=https://example.invalid/x onerror=alert(1)> & "quoted"';
  const before = snapshot({ '<db/>': { state: 'present', version: 1, stores: { '<store/>': { state: 'present', records: [{ key: '<key/>', value }] } } } });
  const { rows, html } = renderedRows(before, before);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.before === value)?.after, value);
  assert.equal(html.includes('<img src='), false);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
});
test('renderer can present a run with no snapshots and zero selected subjects', () => {
  assert.deepEqual(renderedRows(undefined, undefined).rows, []);
});
