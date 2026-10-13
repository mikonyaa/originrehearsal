import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { OwnedProfiles } from '../dist/profile/index.js';
import { Gateway, inspectBuild } from '../dist/gateway/index.js';
import { captureStorage } from '../dist/probes/index.js';
import { renderHTML } from '../dist/report/index.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const limits = { phaseTimeoutMs: 120_000, maxRecordsPerStore: 100_000, maxSnapshotBytes: 50_000_000 };
const storage = { localStorageKeys: [], indexedDB: [{ name: 'synthetic-benchmark', stores: ['records'] }] };
const sizes = { small: { count: 1000, payload: 128 }, bounds: { count: 100_000, payload: 470 } };

if (process.argv[2] === '--child') {
  const label = process.argv[3], spec = sizes[label];
  if (!spec) throw new Error('Unknown bounded benchmark fixture');
  const dir = await mkdtemp(join(root, 'artifacts/benchmarks/fixture-'));
  const buildDir = join(dir, 'build'); await mkdir(buildDir);
  await writeFile(join(buildDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic bounded snapshot benchmark</title></head><body><script src="/app.js"></script></body></html>');
  await writeFile(join(buildDir, 'app.js'), `document.documentElement.dataset.appBuild='synthetic-benchmark-v1'; const request=indexedDB.open('synthetic-benchmark',1); request.onupgradeneeded=()=>request.result.createObjectStore('records'); request.onsuccess=()=>{window.benchmarkDB=request.result;window.benchmarkDB.onversionchange=()=>window.benchmarkDB.close();document.documentElement.dataset.appReady='true'};`);
  const build = await inspectBuild(buildDir), gateway = new Gateway(build, build, 'synthetic-benchmark');
  const profiles = new OwnedProfiles(); await profiles.prepare(); const profile = await profiles.create('control');
  let snapshot, browserVersion, seedMs, captureMs, browserSampledPeakRSSBytes = 0, browserRSSSamples = 0, sampledBrowserPids = [];
  let timer, hardDeadline, closure, sampling = Promise.resolve();
  try {
    await gateway.listen(); const page = await profile.launch(limits.phaseTimeoutMs);
    browserVersion = profile.browserVersion;
    await page.goto(gateway.origin); await page.waitForSelector('[data-app-ready="true"]');
    const session = await page.context().browser().newBrowserCDPSession();
    sampledBrowserPids = (await session.send('SystemInfo.getProcessInfo')).processInfo.map(info => info.id);
    await session.detach();
    const sample = async () => {
      try {
        const { stdout } = await exec('ps', ['-p', sampledBrowserPids.join(','), '-o', 'rss=']);
        const rss = stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0);
        browserSampledPeakRSSBytes = Math.max(browserSampledPeakRSSBytes, rss);
        browserRSSSamples++;
      } catch { /* Processes may exit between a sample and confirmed close. */ }
    };
    await sample();
    timer = setInterval(() => { sampling = sampling.then(sample); }, 250);
    // Close only this benchmark's confirmed browser if native work exceeds the total budget.
    hardDeadline = setTimeout(() => { void profile.close(5000); }, 150_000);
    let start = performance.now();
    await page.evaluate(async ({ count, payload }) => {
      await new Promise((resolve, reject) => {
        const tx = window.benchmarkDB.transaction('records', 'readwrite'), value = 'x'.repeat(payload);
        for (let key = 0; key < count; key++) tx.objectStore('records').put(value, key);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
      document.documentElement.dataset.saved = 'true';
    }, spec);
    seedMs = performance.now() - start;
    start = performance.now(); snapshot = await captureStorage(page, storage, limits); captureMs = performance.now() - start;
    assert.equal(snapshot.complete, true); assert.deepEqual(snapshot.problems, []);
    const rows = snapshot.indexedDB['synthetic-benchmark'].stores.records.records;
    assert.equal(rows.length, spec.count);
    for (let i = 0; i < rows.length; i++) { assert.equal(rows[i].key, i); assert.equal(rows[i].value, 'x'.repeat(spec.payload)); }
    const nativeCount = await page.evaluate(async () => new Promise((resolve, reject) => {
      const tx = window.benchmarkDB.transaction('records', 'readonly'), request = tx.objectStore('records').count();
      tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error);
    }));
    assert.equal(nativeCount, spec.count, 'Readonly capture must leave the native fixture intact');
    await sample();
  } finally {
    clearInterval(timer); clearTimeout(hardDeadline); await sampling;
    closure = await profile.close(); await profiles.remove(profile); await gateway.close(); await profiles.cleanup();
  }
  // Browser ownership cleanup is complete before the memory-heavy, synchronous formatter benchmark.
  let start = performance.now(); const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot)); const serializeMs = performance.now() - start;
  assert.equal(snapshotBytes <= limits.maxSnapshotBytes, true);
  const sample = JSON.parse(await readFile(join(root, 'site/reports/good.json'), 'utf8'));
  // This object benchmarks formatting only. It is never saved or presented as cold-update evidence.
  delete sample.control;
  sample.upgrade.before = snapshot; sample.upgrade.after = snapshot;
  sample.upgrade.checks = { seed: [], cold: [], upgrade: [] };
  start = performance.now(); let html = renderHTML(sample); const renderMs = performance.now() - start;
  const htmlBytes = Buffer.byteLength(html); html = null;
  globalThis.gc?.();
  const memory = process.memoryUsage();
  console.log(JSON.stringify({ label, records: spec.count, stringPayloadBytesPerRecord: spec.payload, snapshotBytes, limits, seedMs, captureMs, serializeMs, twoSnapshotFormatterMs: renderMs, twoSnapshotHTMLBytes: htmlBytes, nodePeakRSSBytes: process.resourceUsage().maxRSS * 1024, nodeMemoryAfterGC: memory, browserSampledPeakRSSBytes: browserRSSSamples ? browserSampledPeakRSSBytes : null, browserRSSSamples, browserSamplingMs: 250, browserSamplingScope: 'Immediate readiness/after-capture samples plus 250 ms polling of this owned browser process IDs observed at readiness; shared pages can be counted more than once; later processes and sub-sample spikes can be missed.', closure, cleanup: { profileRemoved: true, gatewayClosed: true, ownedRootRemoved: true }, environment: { node: process.version, playwright: JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8')).version, chromium: browserVersion, os: `${platform()} ${release()} ${arch()}` } }));
} else {
  await mkdir(join(root, 'artifacts/benchmarks'), { recursive: true });
  const out = await mkdtemp(join(root, 'artifacts/benchmarks/results-')), results = [];
  const repeats = Number(process.env.ORIGINREHEARSAL_BENCH_REPEATS ?? 3);
  assert.equal(Number.isInteger(repeats) && repeats >= 2 && repeats <= 5, true, 'Use 2-5 independent repeats');
  for (const label of ['small', 'bounds']) for (let repeat = 1; repeat <= repeats; repeat++) {
    const { stdout, stderr } = await exec(process.execPath, ['--expose-gc', '--max-old-space-size=2048', fileURLToPath(import.meta.url), '--child', label], { maxBuffer: 1_000_000 });
    const result = { repeat, ...JSON.parse(stdout) }; results.push(result);
    await writeFile(join(out, `${label}-${repeat}.json`), JSON.stringify(result, null, 2) + '\n');
    await writeFile(join(out, `${label}-${repeat}.stderr.log`), stderr);
    console.error(`${label} ${repeat}/${repeats}: ${result.records} records, ${result.snapshotBytes} bytes, capture ${Math.round(result.captureMs)} ms, two-snapshot formatter ${Math.round(result.twoSnapshotFormatterMs)} ms`);
  }
  const evidence = { outcome: 'PASS', method: 'Real synthetic native IndexedDB seed and readonly capture in a fresh owned browser per repeat; formatter-only cost uses the captured snapshot twice. This does not perform a large cold update or claim a four-snapshot full-run maximum.', budgets: { nodeHeapMiB: 2048, browserWorkDeadlineMs: 150000, phaseTimeoutMs: limits.phaseTimeoutMs, repeats }, results };
  await writeFile(join(out, 'benchmark.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: 'PASS', evidence: out, repeats: results.length }, null, 2));
}
