import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { UpgradeRun } from '../models.js';
import { readFile, readdir, realpath, lstat, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeReport } from '../runner/index.js';
const exec = promisify(execFile);
/** A trusted synchronous hook can stall the worker, so deadlines live in a parent. */
export async function supervisedRun(file: string, out: string, headed: boolean, progress: (phase: string, reason: string) => void): Promise<UpgradeRun> {
  const worker = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  worker.stderr?.pipe(process.stderr);
  const browsers = new Map<number, string>();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let forced: ReturnType<typeof setTimeout> | undefined;
  let result: UpgradeRun | undefined; let failure = ''; let interrupted = false;
  let checkpoint: UpgradeRun | undefined;
  let ownedRoot: { path: string; marker: string } | undefined;
  let forceCleanup: Promise<boolean> | undefined;
  async function terminateOwned(): Promise<boolean> {
    let exited = true;
    const killed: number[] = [];
    for (const [pid, profile] of browsers) {
      try {
        const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command=']);
        if (stdout.includes(`--user-data-dir=${profile}`) && /chrom(e|ium)/i.test(stdout)) {
          process.kill(pid, 'SIGKILL');
          killed.push(pid);
        } else exited = false;
      } catch { /* exited process or unconfirmed ownership: never kill another PID */ }
    }
    worker.kill('SIGKILL');
    await new Promise<void>(res => { if (worker.exitCode !== null || worker.signalCode !== null) res(); else worker.once('exit', () => res()); });
    // A killed Chromium child may remain a zombie until its stalled parent exits.
    for (const pid of killed) {
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); await new Promise(res => setTimeout(res, 25)); } catch { break; } }
      try { process.kill(pid, 0); exited = false; } catch { /* confirmed exit */ }
    }
    if (exited && ownedRoot) {
      try {
        const root = ownedRoot.path;
        if (await realpath(root) !== root || (await lstat(root)).isSymbolicLink() || await readFile(join(root, '.owner'), 'utf8') !== ownedRoot.marker) return false;
        const known = [...browsers.values()].filter(path => dirname(path) === root).map(path => basename(path));
        if ((await readdir(root)).some(name => name !== '.owner' && !known.includes(name))) return false;
        for (const name of (await readdir(root)).filter(name => name !== '.owner')) if (await readFile(join(root, name, '.owner'), 'utf8') !== name) return false;
        await rm(root, { recursive: true }); return true;
      } catch { return false; }
    }
    return !ownedRoot;
  }
  function stop(reason: string, signal: NodeJS.Signals): void {
    failure = reason; worker.kill(signal);
    clearTimeout(watchdog);
    if (!forced) forced = setTimeout(() => { forceCleanup = terminateOwned(); }, 5000);
  }
  const interrupt = (): void => { interrupted = true; stop('Interrupted', 'SIGINT'); };
  process.once('SIGINT', interrupt);
  watchdog = setTimeout(() => stop('Worker validation timed out', 'SIGTERM'), 35_000);
  return new Promise<UpgradeRun>((res, rej) => {
    worker.on('message', (message: unknown) => {
      const data = message as { type: string; phase: string; reason: string; timeout: number; pid: number; path: string; root: string; marker: string; run: UpgradeRun };
      if (data.type === 'phase') { clearTimeout(watchdog); watchdog = setTimeout(() => stop(`Phase ${data.phase} exceeded supervised deadline`, 'SIGTERM'), data.timeout + 3000); }
      if (data.type === 'browser') browsers.set(data.pid, data.path);
      if (data.type === 'root') ownedRoot = { path: data.root, marker: data.marker };
      if (data.type === 'checkpoint') checkpoint = data.run;
      if (data.type === 'progress') progress(data.phase, data.reason);
      if (data.type === 'result') result = data.run;
      if (data.type === 'error') failure = data.reason;
    });
    worker.once('error', error => { failure = error.message; });
    worker.once('close', () => { void (async () => {
      clearTimeout(watchdog); clearTimeout(forced); process.removeListener('SIGINT', interrupt);
      if (result) { if (interrupted) result.exitCode = 130; res(result); }
      else if (checkpoint && forceCleanup) {
        const removed = await forceCleanup;
        checkpoint.outcome = 'ERROR'; checkpoint.exitCode = interrupted ? 130 : 2; checkpoint.finishedAt = new Date().toISOString();
        checkpoint.diagnostics.push({ outcome: 'ERROR', phase: 'supervisor', reason: `${failure}. Owned worker/browser termination enforced; profile cleanup ${removed ? 'confirmed' : 'could not be confirmed'}.` });
        checkpoint.cleanup = { gatewayClosed: true, ownedRootRemoved: removed };
        for (const leg of [checkpoint.control, checkpoint.upgrade]) if (leg && leg.outcome === 'ERROR') leg.cleanup = { browserClosed: removed, profileRemoved: removed };
        await writeReport(checkpoint, out);
        const lock = join(out, '.originrehearsal-lock'); if (await readFile(lock, 'utf8').catch(() => '') === checkpoint.runId) await unlink(lock);
        res(checkpoint);
      } else { process.exitCode = interrupted ? 130 : 2; rej(new Error(failure || 'Worker exited before lifecycle/report completion')); }
    })().catch(rej); });
    worker.send({ file, out, headed });
  });
}
