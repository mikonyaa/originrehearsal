import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { verifyTypedConsumer } from './typed-keys.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, 'artifacts/package'), { recursive: true });
let archive = process.env.ORIGINREHEARSAL_TARBALL;
if (!archive) {
  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', join(root, 'artifacts/package')], { cwd: root });
  archive = join(root, 'artifacts/package', JSON.parse(stdout)[0].filename);
}
archive = resolve(archive);
const bytes = await readFile(archive); assert.equal(bytes[0], 0x1f); assert.equal(bytes[1], 0x8b);
const consumer = await mkdtemp(join(process.env.ORIGINREHEARSAL_CONSUMER_ROOT ?? tmpdir(), 'originrehearsal-consumer-'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'originrehearsal-verified-consumer', private: true, type: 'module' }));
await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: consumer, maxBuffer: 5_000_000 });
const binary = join(consumer, 'node_modules/.bin/originrehearsal');
const results = [];
async function installed(args, code = 0) {
  let result;
  try { result = await exec(binary, args, { cwd: consumer, maxBuffer: 20_000_000, timeout: 120_000 }); assert.equal(code, 0); }
  catch (error) { assert.equal(error.code, code, error.stderr || String(error)); result = error; }
  return result;
}
const version = await installed(['--version']); assert.equal(version.stdout.trim(), '0.1.0');
const doctor = JSON.parse((await installed(['doctor', '--json'])).stdout); assert.equal(doctor.outcome, 'PASS');
const installer = JSON.parse((await installed(['install-browser', '--json'])).stdout); assert.equal(installer.playwright, '1.64.0');
const example = 'example space Юникод';
await installed(['init', '--dir', example, '--json']);
for (const [name, file, expected, code] of [['good', 'upgrade-case.json', 'PASS', 0], ['bad', 'bad-case.json', 'VIOLATION', 1]]) {
  const data = JSON.parse((await installed(['run', join(example, file), '--out', join('runs', name), '--no-open', '--json'], code)).stdout);
  assert.equal(data.outcome, expected); assert.equal(data.control.outcome, 'PASS'); assert.equal(data.seed.fingerprintsMatch, true); assert.equal(data.cleanup.ownedRootRemoved, true);
  results.push({ scenario: name, outcome: data.outcome, exitCode: data.exitCode, coldControl: data.control.outcome });
}
const demo = JSON.parse((await installed(['demo', '--out', 'demo', '--json', '--no-open'])).stdout);
assert.equal(demo.outcome, 'PASS'); assert.deepEqual(demo.scenarios.map(run => run.outcome), ['PASS', 'VIOLATION']);
await writeFile(join(consumer, 'sdk-import.mjs'), `import {Checks, canonical} from 'originrehearsal'; const checks=new Checks(['localStorage/key']); checks.equal('consumer.value','localStorage/key','value','value','Installed compiled SDK assertion'); if(checks.finish()[0].outcome!=='PASS'||canonical({b:2,a:1})!=='{"a":1,"b":2}') throw new Error('SDK import failed'); console.log('SDK_OK');\n`);
assert.match((await exec(process.execPath, ['sdk-import.mjs'], { cwd: consumer })).stdout, /SDK_OK/);
await installed(['report', 'runs/bad/run.json', '--out', 'rendered', '--json', '--no-open']);
const browser = await chromium.launch(); const page = await browser.newPage(); let network = 0;
try {
  await page.route(/^https?:/, route => { network++; return route.abort(); });
  await page.goto(pathToFileURL(join(consumer, 'rendered/report.html')).href);
  assert.match(await page.title(), /^VIOLATION/);
  await page.getByRole('button', { name: 'Violations only', exact: true }).click();
  assert.equal(await page.locator('tr[data-outcome="PASS"]:visible').count(), 0);
  assert.equal(await page.locator('tr[data-outcome="VIOLATION"]:visible').count() > 0, true);
  assert.equal(await page.locator('img').count(), 0); assert.equal(network, 0);
} finally { await browser.close(); }
const typedEvidence = await verifyTypedConsumer({ consumer, archive, evidenceDir: join(consumer, 'typed-key-evidence') });
const record = { outcome: 'PASS', archiveSha256: createHash('sha256').update(bytes).digest('hex'), install: 'npm install --ignore-scripts (no link, workspace symlinks or NODE_PATH)', node: process.version, playwright: installer.playwright, chromium: doctor.chromium, os: `${platform()} ${arch()}`, checks: ['installed binary version', 'real doctor', 'pinned browser installer', 'standalone Unicode/space init', 'real GOOD/BAD/cold scenarios', 'real installed demo', '.mjs SDK import', 'offline HTML controls and no network'], results };
record.typedKeys = { outcome: typedEvidence.outcome, results: typedEvidence.results, runs: typedEvidence.runs };
await writeFile(join(root, 'artifacts/package/consumer-result.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
console.error(`Consumer evidence retained at ${consumer}`);
