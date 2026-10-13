import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import { caseSchema } from '../dist/config/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = await readFile(join(root, 'schemas/upgrade-case.schema.json'), 'utf8');
const schema = JSON.parse(text);
assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false, coerceTypes: false, removeAdditional: false });
// Zod emits a starts_with annotation as well as the authoritative pattern.
ajv.addFormat('starts_with', value => value.startsWith('/'));
const validate = ajv.compile(schema);
const results = [];
function verify(id, input, schemaExpected = true, runtimeExpected = true, runtimeOnly) {
  const original = structuredClone(input);
  const schemaValid = validate(input);
  const schemaErrors = structuredClone(validate.errors);
  const parsed = caseSchema.safeParse(input);
  assert.deepEqual(input, original, `${id}: validation must not insert defaults or otherwise mutate input`);
  const result = { id, schemaValid, runtimeValid: parsed.success, schemaExpected, runtimeExpected, ...(runtimeOnly ? { runtimeOnly } : {}), ...(schemaErrors ? { schemaErrors } : {}) };
  results.push(result);
}
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.json')) {
      const input = JSON.parse(await readFile(path, 'utf8'));
      if (entry.name.endsWith('-case.json') || Object.hasOwn(input, 'schemaVersion')) verify(relative(root, path), input);
    }
  }
}
await walk(join(root, 'examples'));
const fixtures = JSON.parse(await readFile(join(root, 'tests/fixtures/schema-inputs.json'), 'utf8'));
verify('minimal-input', fixtures.minimal);
for (const fixture of fixtures.cases) {
  const input = structuredClone(fixtures.minimal);
  for (const [path, value] of fixture.set) {
    const keys = path.split('.'); let target = input;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = structuredClone(value);
  }
  verify(fixture.id, input, fixture.schema, fixture.runtime, fixture.runtimeOnly);
}
for (const seedInputs of [null, false, 0, '', [1, null, { 'a/b': false }], { value: '</script>' }]) verify(`seedInputs:${JSON.stringify(seedInputs)}`, { ...fixtures.minimal, seedInputs });
for (const [id, change, valid] of [
  ['name-length-500', input => input.storage.localStorageKeys = ['x'.repeat(500)], true],
  ['name-length-501', input => input.storage.localStorageKeys = ['x'.repeat(501)], false],
  ['local-targets-100', input => input.storage.localStorageKeys = Array.from({ length: 100 }, (_, i) => `key-${i}`), true],
  ['local-targets-101', input => input.storage.localStorageKeys = Array.from({ length: 101 }, (_, i) => `key-${i}`), false],
  ['databases-50', input => input.storage.indexedDB = Array.from({ length: 50 }, (_, i) => ({ name: `db-${i}`, stores: ['s'] })), true],
  ['databases-51', input => input.storage.indexedDB = Array.from({ length: 51 }, (_, i) => ({ name: `db-${i}`, stores: ['s'] })), false],
  ['stores-100', input => input.storage.indexedDB = [{ name: 'db', stores: Array.from({ length: 100 }, (_, i) => `store-${i}`) }], true],
  ['stores-101', input => input.storage.indexedDB = [{ name: 'db', stores: Array.from({ length: 101 }, (_, i) => `store-${i}`) }], false],
]) { const input = structuredClone(fixtures.minimal); change(input); verify(id, input, valid, valid); }
const mismatches = results.filter(row => row.schemaValid !== row.schemaExpected || row.runtimeValid !== row.runtimeExpected);
const deterministic = text === JSON.stringify(z.toJSONSchema(caseSchema, { io: 'input' }), null, 2) + '\n';
console.log(JSON.stringify({ outcome: mismatches.length || !deterministic ? 'FAIL' : 'PASS', draft: schema.$schema, deterministic, checked: results.length, mismatches, fixtures: results.map(({ id, schemaValid, runtimeValid }) => ({ id, schemaValid, runtimeValid })), runtimeOnly: results.filter(row => row.runtimeOnly).map(({ id, runtimeOnly }) => ({ id, reason: runtimeOnly })) }, null, 2));
assert.equal(mismatches.length, 0, 'Published schema and runtime must meet the declared input fixture expectations');
assert.equal(deterministic, true, 'Build must generate the checked-in input schema deterministically');
