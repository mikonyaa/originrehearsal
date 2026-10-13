import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import Ajv2020 from 'ajv/dist/2020.js';
import { createTypedFixture } from '../typed-fixture.mjs';

const exec = promisify(execFile), root = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

// Independent report oracle traverses the public raw observations, never production report helpers.
function rawRows(before, after) {
  const rows = new Map();
  function add(parts, value, side) {
    const id = JSON.stringify(parts);
    if (!rows.has(id)) rows.set(id, { id, before: { state: 'not-observed' }, after: { state: 'not-observed' } });
    rows.get(id)[side] = value;
  }
  for (const [side, snapshot] of [['before', before], ['after', after]]) {
    for (const [key, value] of Object.entries(snapshot.localStorage)) add(['localStorage', key], value, side);
    for (const [name, db] of Object.entries(snapshot.indexedDB)) {
      add(['database', name], db.state === 'present' ? { state: 'present', version: db.version } : db, side);
      if (db.state !== 'present') continue;
      for (const [store, observation] of Object.entries(db.stores)) {
        add(['store', name, store], observation.state === 'present' ? { state: 'present', records: observation.records.length } : observation, side);
        if (observation.state === 'present') for (const record of observation.records) add(['record', name, store, typeof record.key, record.key], record.value, side);
      }
    }
  }
  return [...rows.values()];
}
export async function verifyTypedConsumer({ consumer, archive, evidenceDir }) {
  await mkdir(evidenceDir, { recursive: true });
  assert.equal((await lstat(join(consumer, 'node_modules/originrehearsal'))).isSymbolicLink(), false, 'Consumer must install an archive, not a workspace link');
  const binary = join(consumer, 'node_modules/.bin/originrehearsal');
  const fixture = join(consumer, 'independent typed fixture'); await createTypedFixture(fixture);
  const expected = JSON.parse(await readFile(join(fixture, 'expected.json'), 'utf8'));
  const publishedSchema = JSON.parse(await readFile(join(consumer, 'node_modules/originrehearsal/schemas/upgrade-case.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat('starts_with', value => value.startsWith('/'));
  const validateInput = ajv.compile(publishedSchema);
  const runs = [], commands = [];
  async function installed(args, code = 0) {
    const startedAt = new Date().toISOString(); let result, actualCode = 0;
    try { result = await exec(binary, args, { cwd: consumer, timeout: 120_000, maxBuffer: 20_000_000, env: { ...process.env, NODE_PATH: '' } }); }
    catch (error) { result = error; actualCode = error.code; }
    commands.push({ command: ['originrehearsal', ...args], startedAt, finishedAt: new Date().toISOString(), exitCode: actualCode });
    await writeFile(join(evidenceDir, `command-${commands.length}.stdout.log`), result.stdout ?? '');
    await writeFile(join(evidenceDir, `command-${commands.length}.stderr.log`), result.stderr ?? '');
    assert.equal(actualCode, code, result.stderr || result.stdout);
    assert.equal(result.stdout.trim().split('\n').length, 1, '--json must emit a single stdout result');
    return JSON.parse(result.stdout);
  }
  for (const [scenario, code, outcome] of [['good', 0, 'PASS'], ['bad', 1, 'VIOLATION'], ['edges', 0, 'PASS']]) {
    const configInput = JSON.parse(await readFile(join(fixture, `${scenario}.json`), 'utf8'));
    assert.equal(validateInput(configInput), true, `Installed archive schema must accept runtime input: ${JSON.stringify(validateInput.errors)}`);
    const out = join(evidenceDir, `fresh-${scenario}`);
    const run = await installed(['run', join(fixture, `${scenario}.json`), '--out', out, '--json', '--no-open'], code);
    assert.equal(run.outcome, outcome); assert.equal(run.control.outcome, 'PASS'); assert.equal(run.seed.fingerprintsMatch, true); assert.equal(run.coverage.complete, true);
    assert.deepEqual(run.cleanup, { gatewayClosed: true, ownedRootRemoved: true });
    assert.notEqual(run.control.profileId, run.upgrade.profileId);
    for (const leg of [run.control, run.upgrade]) {
      assert.deepEqual(leg.cleanup, { browserClosed: true, profileRemoved: true });
      assert.deepEqual(leg.closure[0], { stage: 'old', disconnected: true, processExited: true, forced: false });
      assert.equal(leg.builds.every(build => build.origin === run.origin && build.appConfirmed && build.backendConfirmed && build.userDataDirConfirmed), true);
      assert.deepEqual(leg.before.indexedDB['audit-keyed-records'].stores.records.records, expected.core);
    }
    assert.deepEqual(run.control.after.indexedDB['audit-keyed-records'].stores.records.records, expected.core);
    assert.deepEqual(run.upgrade.after.indexedDB['audit-keyed-records'].stores.records.records, scenario === 'bad' ? [{ key: '1', value: 'STRING_KEY_SENTINEL' }, { key: 'nullable', value: null }] : expected.core);
    if (scenario === 'bad') assert.equal(run.upgrade.checks.upgrade.find(check => check.id === 'upgrade.core.number.1').outcome, 'VIOLATION');
    const capture = await readFile(join(out, 'run.json'));
    const rendered = join(evidenceDir, `offline-${scenario}`);
    await installed(['report', join(out, 'run.json'), '--out', rendered, '--json', '--no-open']);
    assert.equal(hash(await readFile(join(out, 'run.json'))), hash(capture), 'Report regeneration must not alter capture JSON');
    runs.push({ scenario, run, report: join(rendered, 'report.html') });
  }
  await writeFile(join(evidenceDir, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  const browser = await chromium.launch(), results = [], losses = [];
  try {
    for (const { scenario, run, report } of runs) for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } }); let network = 0;
      await page.route(/^https?:/, route => { network++; return route.abort(); });
      await page.goto(pathToFileURL(report).href);
      const summary = page.locator('summary').filter({ hasText: 'Selected before / after values' });
      await summary.click();
      const table = summary.locator('..').locator('tbody tr');
      const actual = await table.evaluateAll(rows => rows.map(row => ({ id: row.getAttribute('data-storage-subject'), subject: row.querySelector('code').textContent, before: JSON.parse(row.querySelector('[data-label="Before"] pre').textContent), after: JSON.parse(row.querySelector('[data-label="After"] pre').textContent) })));
      const wanted = rawRows(run.upgrade.before, run.upgrade.after);
      const summaryCount = Number((await summary.textContent()).match(/\((\d+) subjects\)/)[1]);
      if (actual.length !== wanted.length || summaryCount !== wanted.length) losses.push({ scenario, width, reason: 'subject cardinality', expected: wanted.length, summaryCount, actualRows: actual.length });
      for (const row of wanted) {
        const observed = actual.find(item => item.id === row.id);
        if (!observed || JSON.stringify(observed.before) !== JSON.stringify(row.before) || JSON.stringify(observed.after) !== JSON.stringify(row.after)) losses.push({ scenario, width, reason: 'subject/value mismatch', expected: row, observed });
      }
      if (scenario !== 'edges') {
        assert.equal(wanted.length, 5, 'The core fixture always has exactly five subjects, including a before-only numeric record in BAD');
        const numeric = actual.find(row => row.before === 'NUMERIC_KEY_SENTINEL');
        const string = actual.find(row => row.before === 'STRING_KEY_SENTINEL');
        if (!numeric || !string || !/number.*1/.test(numeric.subject) || !/string.*"1"/.test(string.subject)) losses.push({ scenario, width, reason: 'readable native key types', numeric, string });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('img,iframe,object').count(), 0);
      await page.screenshot({ path: join(evidenceDir, `${scenario}-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: 'All checks', exact: true }).focus();
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'violations');
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
      await page.keyboard.press('Enter'); assert.equal(await page.locator('#violations').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('tr[data-outcome="PASS"]:visible').count(), 0);
      if (scenario === 'bad') assert.equal(await page.locator('tr[data-outcome="VIOLATION"]:visible').count() > 0, true);
      await page.locator('#all').click(); await page.locator('#search').fill('not-a-real-check-xyz');
      assert.equal(await page.locator('tr[data-outcome]:visible').count(), 0);
      assert.equal(await page.locator('#visible').textContent(), '0 checks shown');
      await page.locator('#search').fill('NUMERIC_KEY_SENTINEL'); assert.equal(await page.locator('tr[data-outcome]:visible').count() > 0, true);
      assert.equal(network, 0);
      results.push({ scenario, width, expectedSubjects: wanted.length, summaryCount, actualRows: actual.length, offline: true, keyboard: 'PASS', emptyState: 'PASS', horizontalOverflow: false, hostileValuesEscaped: true, externalRequests: network });
      await page.close();
    }
  } finally { await browser.close(); }
  const evidence = { outcome: losses.length ? 'FAIL' : 'PASS', archiveSha256: hash(await readFile(archive)), application: 'Independent synthetic three-record static fixture plus edge-value and slash-name fixture; not a real application pilot.', expectedSource: 'expected.json, authored independently of seed inputs and observed snapshots', results, losses, runs: runs.map(({ scenario, run }) => ({ scenario, outcome: run.outcome, exitCode: run.exitCode, coldControl: run.control.outcome, seedFingerprint: run.upgrade.seedFingerprint, cleanup: run.cleanup, runId: run.runId })) };
  await writeFile(join(evidenceDir, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: evidence.outcome, archiveSha256: evidence.archiveSha256, checked: results.length, presentationLosses: losses.length, evidence: evidenceDir }, null, 2));
  assert.equal(losses.length, 0, 'Rendered subjects and exact JSON must match all public raw observations');
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidenceDir = resolve(process.env.ORIGINREHEARSAL_TYPED_EVIDENCE ?? join(root, 'artifacts/typed-keys', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(evidenceDir, { recursive: true });
  let archive = process.env.ORIGINREHEARSAL_TARBALL;
  if (!archive) {
    const packed = await exec('npm', ['pack', '--json', '--pack-destination', evidenceDir], { cwd: root });
    archive = join(evidenceDir, JSON.parse(packed.stdout)[0].filename);
  }
  archive = resolve(archive);
  const consumer = await mkdtemp(join(process.env.ORIGINREHEARSAL_CONSUMER_ROOT ?? tmpdir(), 'originrehearsal-typed-consumer-'));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'independent-typed-consumer', private: true, type: 'module' }));
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: consumer });
  console.error(`Independent installed consumer: ${consumer}`);
  await verifyTypedConsumer({ consumer, archive, evidenceDir });
}
