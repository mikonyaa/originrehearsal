import { records } from 'originrehearsal';
import { readFileSync } from 'node:fs';
// An independent application specification; never derived from a runner snapshot.
const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8'));
const sort = rows => [...rows].sort((a, b) => JSON.stringify([typeof a.key, a.key]).localeCompare(JSON.stringify([typeof b.key, b.key]), 'en'));
function assertRecords(checks, prefix, snapshot, database, store, wanted) {
  const actual = records(snapshot, database, store), subject = `indexedDB/${database}/${store}`;
  checks.equal(`${prefix}.keys`, subject, sort(actual).map(row => ({ type: typeof row.key, key: row.key })), sort(wanted).map(row => ({ type: typeof row.key, key: row.key })), 'All specified native key values and types must match, including number 1 and string "1".');
  for (const row of wanted) {
    const observed = actual.find(item => typeof item.key === typeof row.key && item.key === row.key);
    checks.equal(`${prefix}.${typeof row.key}.${row.key}`, `${subject}/${typeof row.key}:${JSON.stringify(row.key)}`, observed ? { state: 'present', value: observed.value } : { state: 'missing' }, { state: 'present', value: row.value }, 'Preserve the exact independently specified JSON value; null is present.');
  }
}
function edgeChecks(checks, prefix, snapshot, migrated) {
  if (!Object.hasOwn(snapshot.indexedDB, 'a/b')) return;
  assertRecords(checks, `${prefix}.edge`, snapshot, 'a/b', 'c', migrated ? expected.edgesAfter : expected.edgesBefore);
  assertRecords(checks, `${prefix}.slash`, snapshot, 'a', 'b/c', expected.slashRecords);
  assertRecords(checks, `${prefix}.metadata`, snapshot, 'a', 'b', expected.metadataCollisionRecords);
  checks.allowedAbsent(`${prefix}.missing-db`, 'indexedDB/a/b/c', snapshot.indexedDB['a/b/c'], 'An absent database is observed without opening or creating it.');
  checks.allowedAbsent(`${prefix}.missing-local`, 'localStorage/optional/missing', snapshot.localStorage['optional/missing'], 'An explicitly selected absent key remains missing.');
}
export async function seed({ page, inputs }) {
  await page.evaluate(async value => { await window.typedFixture.seed(value); }, inputs);
  await page.locator('[data-saved="true"]').waitFor();
}
export function assertSeed({ snapshot, checks }) {
  assertRecords(checks, 'seed.core', snapshot, 'audit-keyed-records', 'records', expected.core);
  edgeChecks(checks, 'seed', snapshot, false);
  const logical = { core: sort(records(snapshot, 'audit-keyed-records', 'records')) };
  if (Object.hasOwn(snapshot.indexedDB, 'a/b')) {
    logical.edges = sort(records(snapshot, 'a/b', 'c'));
    logical.slashes = sort(records(snapshot, 'a', 'b/c'));
    logical.metadata = sort(records(snapshot, 'a', 'b'));
  }
  checks.fingerprint(logical, ['Sort records by the JSON tuple [native key type, key] with English collation.', 'Keep all key types, key values and JSON values, including null and falsy values.', 'Exclude capture time, database version and owned physical profile identity.']);
}
export function verifyCold({ before, after, checks }) {
  assertRecords(checks, 'cold.core', after, 'audit-keyed-records', 'records', expected.core);
  checks.equal('cold.unchanged', 'indexedDB/audit-keyed-records/records', records(after, 'audit-keyed-records', 'records'), records(before, 'audit-keyed-records', 'records'), 'A real OLD cold reopen retains the complete seeded records.');
  edgeChecks(checks, 'cold', after, false);
}
export function verify({ before, after, checks }) {
  assertRecords(checks, 'upgrade.core', after, 'audit-keyed-records', 'records', expected.core);
  checks.equal('upgrade.unchanged', 'indexedDB/audit-keyed-records/records', records(after, 'audit-keyed-records', 'records'), records(before, 'audit-keyed-records', 'records'), 'GOOD preserves the three records; BAD deletes only native number 1.');
  edgeChecks(checks, 'upgrade', after, true);
}
