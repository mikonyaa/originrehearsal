import { randomUUID } from 'node:crypto';
import { platform, release, arch } from 'node:os';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { loadCase } from '../config/index.js';
import { Gateway, digest } from '../gateway/index.js';
import { OwnedProfiles } from '../profile/index.js';
import { captureStorage } from '../probes/index.js';
import { Checks, canonical, deepFreeze } from '../sdk/index.js';
import { assertIdentity, observeBuild, waitReady } from './evidence.js';
import type { Leg, LifecycleEvent, Outcome, StorageSnapshot, UpgradeRun } from '../models.js';
import { renderHTML } from '../report/index.js';
const require = createRequire(import.meta.url);
export const VERSION = '0.1.0';
export const PLAYWRIGHT_VERSION = (require('playwright/package.json') as { version: string }).version;
export const exitCodes: Record<Outcome, number> = { PASS: 0, VIOLATION: 1, ERROR: 2, UNSUPPORTED: 3 };
const priority: Outcome[] = ['ERROR', 'UNSUPPORTED', 'VIOLATION', 'PASS'];
export const combinedOutcome = (outcomes: Outcome[]): Outcome => priority.find(value => outcomes.includes(value)) ?? 'PASS';
export class RunProblem extends Error { constructor(readonly outcome: 'ERROR' | 'UNSUPPORTED', message: string) { super(message); } }
export interface RunOptions {
  out: string; headed?: boolean; signal?: AbortSignal;
  progress?: (phase: string, reason: string) => void;
  onPage?: (page: Page, stage: string, kind: 'control' | 'upgrade') => Promise<void>;
  onPhase?: (phase: string, timeout: number) => void;
  onOwnedBrowser?: (pid: number, path: string) => void;
  videoDir?: string;
  onOwnedRoot?: (root: string, marker: string) => void;
  onCheckpoint?: (run: UpgradeRun) => void;
}

export async function writeReport(run: UpgradeRun, out: string): Promise<void> {
  await mkdir(out, { recursive: true });
  for (const [name, value] of [['run.json', JSON.stringify(run, null, 2) + '\n'], ['report.html', renderHTML(run)]]) {
    const temp = join(out, `${name}.${run.runId}.tmp`); await writeFile(temp, value!, { mode: 0o600 }); await rename(temp, join(out, name!));
  }
}

export async function runCase(file: string, options: RunOptions): Promise<UpgradeRun> {
  const startedAt = new Date().toISOString(); const runId = randomUUID(); const controlId = randomUUID(); const upgradeId = randomUUID();
  const run: UpgradeRun = {
    schemaVersion: 1, toolVersion: VERSION, runId, caseId: 'unvalidated', startedAt, finishedAt: startedAt, outcome: 'ERROR', exitCode: 2,
    environment: { node: process.version, playwright: PLAYWRIGHT_VERSION, chromium: 'not launched', os: `${platform()} ${release()}`, arch: arch() },
    digests: { config: '', hooks: '', old: '', new: '' }, buildIds: { old: 'not validated', new: 'not validated' }, origin: '',
    seed: { inputDigest: '', controlRunId: controlId, upgradeRunId: upgradeId, fingerprintsMatch: false },
    cachePolicy: 'no-store', coverage: { localStorageKeys: [], indexedDB: [], complete: false }, events: [], diagnostics: [],
    limitations: ['Static builds on one loopback HTTP origin.', 'no-store cold updates; production cache parity is not claimed.', 'Service workers are unsupported and never blocked or removed.', 'Only selected localStorage keys, string/finite-number IDB keys and JSON values.', 'Separate fresh control and upgrade profiles; no storage restore.', 'Reports contain selected application data. Hooks are trusted local code.'],
    cleanup: { gatewayClosed: false, ownedRootRemoved: false },
  };
  const profiles = new OwnedProfiles(); let gateway: Gateway | undefined; let timeout = 30_000; let interrupted = false;
  const out = resolve(options.out); await mkdir(out, { recursive: true });
  const lockPath = join(out, '.originrehearsal-lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(runId); }
  catch { throw new Error('Output directory is already owned by another run; choose a fresh --out'); }
  try {
    await readFile(join(out, 'run.json'));
    throw new Error('Output already contains run.json; choose a fresh --out');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await lock.close(); await unlink(lockPath); throw error;
    }
  }
  async function phase<T>(events: LifecycleEvent[], name: string, work: () => Promise<T>, enforceAbort = true): Promise<T> {
    const start = Date.now(); const event: LifecycleEvent = { phase: name, startedAt: new Date(start).toISOString(), durationMs: 0, outcome: 'PASS', reason: 'Completed' };
    events.push(event); options.progress?.(name, 'started'); options.onPhase?.(name, timeout); options.onCheckpoint?.(run);
    let timer: ReturnType<typeof setTimeout> | undefined; let listener: (() => void) | undefined;
    try {
      if (enforceAbort && options.signal?.aborted) { interrupted = true; throw new Error('Interrupted'); }
      const deadline = new Promise<never>((_res, rej) => { timer = setTimeout(() => rej(new Error(`Phase ${name} timed out after ${timeout}ms`)), timeout); });
      const abort = new Promise<never>((_res, rej) => {
        listener = () => { interrupted = true; rej(new Error('Interrupted')); };
        if (enforceAbort) options.signal?.addEventListener('abort', listener, { once: true });
      });
      return await Promise.race([work(), deadline, abort]);
    } catch (error) {
      const outcome = error instanceof RunProblem ? error.outcome : 'ERROR';
      event.outcome = outcome; event.reason = error instanceof Error ? error.message : String(error);
      if (profiles.root) event.reason = event.reason.split(profiles.root).join('<owned-profile-root>');
      run.diagnostics.push({ outcome, phase: name, reason: event.reason }); throw error;
    } finally {
      clearTimeout(timer); if (listener) options.signal?.removeEventListener('abort', listener);
      event.durationMs = Date.now() - start; options.progress?.(name, `${event.outcome}: ${event.reason}`);
      options.onCheckpoint?.(run);
    }
  }
  const finalize = (): void => {
    run.finishedAt = new Date().toISOString();
    run.outcome = combinedOutcome([...run.diagnostics.map(d => d.outcome), ...[run.control, run.upgrade].filter((leg): leg is Leg => !!leg).map(leg => leg.outcome)]);
    run.exitCode = interrupted ? 130 : exitCodes[run.outcome];
  };
  try {
    const loaded = await phase(run.events, 'validate', () => loadCase(file));
    const { config } = loaded; timeout = config.limits.phaseTimeoutMs;
    run.caseId = config.id; run.digests = { config: loaded.configDigest, hooks: loaded.hooksDigest, old: loaded.old.hash, new: loaded.next.hash };
    run.buildIds = { old: config.old.buildId, new: config.new.buildId };
    run.seed.inputDigest = digest(canonical(config.seedInputs));
    run.coverage.localStorageKeys = config.storage.localStorageKeys; run.coverage.indexedDB = config.storage.indexedDB;
    await phase(run.events, 'prepare', async () => {
      if (!(platform() === 'darwin' && arch() === 'arm64') && !(platform() === 'linux' && arch() === 'x64')) throw new RunProblem('UNSUPPORTED', 'v0.1 supports macOS arm64 and Linux x64 only');
      if (Number(process.versions.node.split('.')[0]) !== 24 || Number(process.versions.node.split('.')[1]) < 21) throw new RunProblem('UNSUPPORTED', 'Use Node 24.21.0 or later Node 24 LTS');
      await profiles.prepare(); options.onOwnedRoot?.(profiles.root, profiles.marker);
      gateway = new Gateway(loaded.old, loaded.next, runId, config.gateway.spaFallback); await gateway.listen(config.gateway.port); run.origin = gateway.origin;
    });
    async function leg(kind: 'control' | 'upgrade'): Promise<void> {
      const profile = await profiles.create(kind);
      const result: Leg = { runId: kind === 'control' ? controlId : upgradeId, kind, profileId: profile.id, outcome: 'ERROR', events: [], builds: [], checks: { seed: [], cold: [], upgrade: [] }, closure: [], cleanup: { browserClosed: false, profileRemoved: false } };
      run[kind] = result;
      let page: Page;
      const targets = [...config.storage.localStorageKeys.map(key => `localStorage/${key}`), ...config.storage.indexedDB.flatMap(db => [ `indexedDB/${db.name}`, ...db.stores.map(store => `indexedDB/${db.name}/${store}`) ])];
      async function launch(): Promise<Page> {
        const page = await profile.launch(timeout, options.headed, options.videoDir);
        run.environment.chromium = profile.browserVersion;
        if (profile.pid) options.onOwnedBrowser?.(profile.pid, profile.path);
        return page;
      }
      function validateSnapshot(snapshot: StorageSnapshot): void {
        if (snapshot.origin !== run.origin) throw new Error(`Snapshot origin changed to ${snapshot.origin}`);
        if (!snapshot.complete) {
          for (const p of snapshot.problems) run.diagnostics.push({ outcome: p.outcome, phase: 'probe', reason: `${p.subject}: ${p.reason}` });
          throw new RunProblem(snapshot.problems.some(p => p.outcome === 'ERROR') ? 'ERROR' : 'UNSUPPORTED', 'Storage coverage incomplete; see probe evidence');
        }
      }
      async function observe(expected: string): Promise<void> {
        const evidence = await observeBuild(page, gateway!, profile, config.app, expected); result.builds.push(evidence);
        assertIdentity(evidence, run.origin, result.profileId);
        if (evidence.serviceWorkers.controller || evidence.serviceWorkers.registrations.length) throw new RunProblem('UNSUPPORTED', 'Service worker registration/controller detected; evidence preserved without clearing it');
      }
      async function checkWorkers(): Promise<void> {
        if (profile.context?.pages().length !== 1) throw new RunProblem('UNSUPPORTED', 'Multiple open tabs are outside v0.1 coverage');
        const evidence = await observeBuild(page, gateway!, profile, config.app, kind === 'control' || result.builds.length === 1 ? config.old.buildId : config.new.buildId);
        const last = result.builds.at(-1); if (last) last.serviceWorkers = evidence.serviceWorkers;
        if (evidence.serviceWorkers.controller || evidence.serviceWorkers.registrations.length) throw new RunProblem('UNSUPPORTED', 'Service worker registration/controller detected after readiness');
        assertIdentity(evidence, run.origin, result.profileId);
      }
      try {
        await gateway!.switchTo('old');
        await phase(result.events, 'old-ready', async () => {
          page = await launch(); await page.goto(new URL(config.app.path, run.origin).href); await observe(config.old.buildId);
          await waitReady(page, config.app, timeout); await checkWorkers(); await options.onPage?.(page, 'old-ready', kind);
        });
        await phase(result.events, 'seed-complete', async () => { await loaded.hooks.seed({ page, origin: run.origin, inputs: deepFreeze(config.seedInputs) }); });
        await phase(result.events, 'before-captured', async () => {
          result.before = await captureStorage(page, config.storage, config.limits); validateSnapshot(result.before);
          const checks = new Checks(targets); await loaded.hooks.assertSeed({ snapshot: deepFreeze(result.before), checks });
          result.checks.seed = [...checks.finish()];
          if (!checks.fingerprintEvidence) throw new Error('assertSeed must declare a logical fingerprint and normalization rules');
          result.seedFingerprint = checks.fingerprintEvidence;
          if (checks.results.some(check => check.outcome === 'VIOLATION')) throw new Error('Seed contract failed: initial application data was not confirmed');
          if (kind === 'upgrade') {
            run.seed.fingerprintsMatch = result.seedFingerprint.digest === run.control?.seedFingerprint?.digest;
            if (!run.seed.fingerprintsMatch) throw new Error('Control/main logical seed fingerprints differ');
          }
          await options.onPage?.(page, 'before-captured', kind); await checkWorkers(); await gateway!.assertImmutable();
        });
        await phase(result.events, 'browser-closed', async () => {
          const closed = await profile.close(timeout); result.closure.push({ stage: 'old', ...closed });
          if (closed.forced) throw new Error('OLD browser required forced termination; cold lifecycle was not clean');
        });
        await phase(result.events, 'gateway-switched', () => gateway!.switchTo(kind === 'control' ? 'old' : 'new'));
        await phase(result.events, 'new-observed', async () => {
          page = await launch(); await page.goto(new URL(config.app.path, run.origin).href); await observe(kind === 'control' ? config.old.buildId : config.new.buildId);
        });
        await phase(result.events, 'new-ready', async () => {
          await waitReady(page, config.app, timeout); await checkWorkers(); await options.onPage?.(page, 'new-ready', kind);
        });
        await phase(result.events, 'after-captured', async () => {
          result.after = await captureStorage(page, config.storage, config.limits); validateSnapshot(result.after); await gateway!.assertImmutable();
          await options.onPage?.(page, 'after-captured', kind); await checkWorkers();
        });
        await phase(result.events, 'assertions', async () => {
          const checks = new Checks(targets);
          await (kind === 'control' ? loaded.hooks.verifyCold : loaded.hooks.verify)({ before: deepFreeze(result.before!), after: deepFreeze(result.after!), checks });
          await gateway!.assertImmutable();
          result.checks[kind === 'control' ? 'cold' : 'upgrade'] = [...checks.finish()];
          const violations = checks.results.filter(check => check.outcome === 'VIOLATION');
          if (violations.length && kind === 'control') throw new Error(`Cold OLD control violated ${violations.length} storage checks; upgrade cannot be evaluated`);
          result.outcome = violations.length ? 'VIOLATION' : 'PASS';
          if (violations.length) run.diagnostics.push({ outcome: 'VIOLATION', phase: 'assertions', reason: `${violations.length} storage contracts violated; see stable check IDs and subjects` });
        });
        const event = result.events.at(-1); if (event && result.outcome === 'VIOLATION') { event.outcome = 'VIOLATION'; event.reason = 'Application data violated upgrade contracts'; }
      } catch (error) { result.outcome = error instanceof RunProblem ? error.outcome : 'ERROR'; throw error; }
      finally {
        try {
          const closed = await profile.close(Math.min(timeout, 10_000)); result.closure.push({ stage: 'cleanup', ...closed });
          result.cleanup.browserClosed = closed.disconnected && closed.processExited;
          await profiles.remove(profile); result.cleanup.profileRemoved = true;
        } catch (error) { run.diagnostics.push({ outcome: 'ERROR', phase: 'cleanup', reason: String(error).split(profiles.root).join('<owned-profile-root>') }); result.outcome = 'ERROR'; }
      }
    }
    await leg('control'); await leg('upgrade');
    run.coverage.complete = !!(run.control?.before?.complete && run.control.after?.complete && run.upgrade?.before?.complete && run.upgrade.after?.complete);
    if (!run.coverage.complete || !run.seed.fingerprintsMatch) throw new Error('Lifecycle coverage was not complete');
  } catch (error) {
    if (run.diagnostics.length === 0) run.diagnostics.push({ outcome: 'ERROR', phase: 'validate', reason: error instanceof Error ? error.message : String(error) });
  } finally {
    finalize();
    await phase(run.events, 'report', () => writeReport(run, out), false).catch(() => {});
    await phase(run.events, 'cleanup', async () => {
      await gateway?.close(); run.cleanup.gatewayClosed = true; await profiles.cleanup(); run.cleanup.ownedRootRemoved = true;
    }, false).catch(() => {});
    finalize();
    try { await writeReport(run, out); }
    finally { await lock.close(); if (await readFile(lockPath, 'utf8') === runId) await unlink(lockPath); }
  }
  return run;
}
