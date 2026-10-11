#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { platform, arch, release } from 'node:os';
import { VERSION, PLAYWRIGHT_VERSION } from '../runner/index.js';
import { supervisedRun } from './supervise.js';
import { renderHTML, validateReport } from '../report/index.js';
import { OwnedProfiles } from '../profile/index.js';
import { Gateway, inspectBuild } from '../gateway/index.js';
const require = createRequire(import.meta.url);
const template = fileURLToPath(new URL('../../examples/notes/', import.meta.url));
const program = new Command().name('originrehearsal').description('Rehearse web-app upgrades with retained browser profiles and explicit data contracts.').version(VERSION).exitOverride();
type Flags = { json?: boolean; headed?: boolean; noOpen?: boolean; open?: boolean; out: string; dir: string; withDeps?: boolean };
const machine = (): boolean => process.argv.includes('--json');
const emit = (data: unknown, message: string): void => { process.stdout.write(machine() ? JSON.stringify(data) + '\n' : message + '\n'); };
async function initialize(dir: string): Promise<void> {
  try { await stat(dir); throw new Error(`init refuses an existing destination: ${dir}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(dir), { recursive: true }); await cp(template, dir, { recursive: true, force: false, errorOnExist: true });
}
async function maybeOpen(file: string, flags: Flags): Promise<void> {
  if (flags.open === false || flags.json || process.env.CI) return;
  if (platform() !== 'darwin' && !process.env.DISPLAY) return;
  const child = spawn(platform() === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'ignore' });
  child.once('error', error => process.stderr.write(`Could not open report: ${error.message}\n`)); child.unref();
}
program.command('doctor').description('Check Node, loopback listening and a real owned Chromium profile').option('--json').action(async () => {
  const profiles = new OwnedProfiles(); let gateway: Gateway | undefined; let profile;
  const checks: { id: string; outcome: string; reason: string }[] = [];
  let chromiumVersion = 'not launched';
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24 || Number(process.versions.node.split('.')[1]) < 21) throw new Error('Use Node 24.21.0 or later Node 24 LTS');
    checks.push({ id: 'node', outcome: 'PASS', reason: process.version });
    await profiles.prepare();
    const build = await inspectBuild(join(template, 'dist/v1')); gateway = new Gateway(build, build, 'doctor'); await gateway.listen(); await gateway.observe();
    checks.push({ id: 'loopback', outcome: 'PASS', reason: gateway.origin });
    profile = await profiles.create('control'); await profile.launch(30_000); chromiumVersion = profile.browserVersion;
    checks.push({ id: 'chromium', outcome: 'PASS', reason: `${chromiumVersion}; owned userDataDir confirmed` });
  } catch (error) { checks.push({ id: 'environment', outcome: 'ERROR', reason: `${String(error)}. Run originrehearsal install-browser if Chromium is missing.` }); }
  finally {
    try { if (profile) { await profile.close(); await profiles.remove(profile); } await gateway?.close(); await profiles.cleanup(); }
    catch (error) { checks.push({ id: 'cleanup', outcome: 'ERROR', reason: String(error) }); }
  }
  const outcome = checks.some(check => check.outcome === 'ERROR') ? 'ERROR' : 'PASS';
  process.exitCode = outcome === 'PASS' ? 0 : 2;
  emit({ outcome, version: VERSION, node: process.version, playwright: PLAYWRIGHT_VERSION, chromium: chromiumVersion, os: `${platform()} ${release()} ${arch()}`, checks }, checks.map(check => `${check.outcome} ${check.id}: ${check.reason}`).join('\n'));
});
program.command('install-browser').description(`Install Chromium pinned by Playwright ${PLAYWRIGHT_VERSION}; no postinstall download`).option('--json').option('--with-deps', 'Also install system packages on Linux (may need privileges)').action(async (flags: Flags) => {
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const child = spawn(process.execPath, [cli, 'install', ...(flags.withDeps ? ['--with-deps'] : []), 'chromium'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr);
  const code = await new Promise<number>((res, rej) => { child.once('error', rej); child.once('exit', value => res(value ?? 2)); });
  if (code !== 0) throw new Error(`Pinned Chromium installer exited ${code}`);
  emit({ outcome: 'PASS', playwright: PLAYWRIGHT_VERSION }, `Installed Chromium for Playwright ${PLAYWRIGHT_VERSION}.`);
});
program.command('init').description('Create a standalone synthetic notes case with ready static builds; never overwrite').requiredOption('--dir <directory>').option('--json').action(async (flags: Flags) => {
  await initialize(resolve(flags.dir)); emit({ outcome: 'PASS', dir: resolve(flags.dir), case: join(resolve(flags.dir), 'upgrade-case.json') }, `Created ${flags.dir}.\nRun: originrehearsal run "${join(flags.dir, 'upgrade-case.json')}" --out ./artifacts/run`);
});
program.command('run').description('Run separate OLD cold control and retained-profile OLD → NEW upgrade').argument('<case>').requiredOption('--out <directory>').option('--json').option('--headed').option('--no-open').action(async (file: string, flags: Flags) => {
  const run = await supervisedRun(resolve(file), resolve(flags.out), !!flags.headed, (phase, reason) => process.stderr.write(`[${phase}] ${reason}\n`));
  process.exitCode = run.exitCode;
  emit(run, `${run.outcome} · ${run.caseId}\n${run.diagnostics.map(d => `${d.phase}: ${d.reason}`).join('\n')}\nEvidence: ${join(resolve(flags.out), 'run.json')}\nReport: ${join(resolve(flags.out), 'report.html')}`);
  await maybeOpen(join(resolve(flags.out), 'report.html'), flags);
});
program.command('demo').description('Run real GOOD and BAD upgrades; success requires expected PASS and VIOLATION').requiredOption('--out <directory>').option('--json').option('--headed').option('--no-open').action(async (flags: Flags) => {
  const out = resolve(flags.out); await mkdir(out, { recursive: true }); const example = join(out, 'example'); await initialize(example);
  const results = [];
  for (const [name, file, expected] of [['good', 'upgrade-case.json', 'PASS'], ['bad', 'bad-case.json', 'VIOLATION']]) {
    const run = await supervisedRun(join(example, file!), join(out, name!), !!flags.headed, (phase, reason) => process.stderr.write(`[${name}/${phase}] ${reason}\n`));
    results.push({ scenario: name, expected, outcome: run.outcome, exitCode: run.exitCode, control: run.control?.outcome, report: `${name}/report.html`, json: `${name}/run.json` });
    if (run.exitCode === 130) { process.exitCode = 130; break; }
  }
  const success = results.length === 2 && results.every(result => result.outcome === result.expected && result.control === 'PASS');
  const data = { outcome: success ? 'PASS' : 'ERROR', meaning: 'Demo self-test checks expected outcomes. The BAD application report remains VIOLATION.', scenarios: results };
  await writeFile(join(out, 'demo.json'), JSON.stringify(data, null, 2) + '\n');
  if (process.exitCode !== 130) process.exitCode = success ? 0 : 2;
  emit(data, results.map(result => `${result.scenario}: ${result.outcome} (expected ${result.expected}) → ${join(out, result.report)}`).join('\n'));
  await maybeOpen(join(out, 'bad/report.html'), flags);
});
program.command('report').description('Render a saved JSON run as a self-contained offline HTML report').argument('<run.json>').requiredOption('--out <directory>').option('--json').option('--no-open').action(async (file: string, flags: Flags) => {
  const info = await stat(file); if (info.size > 50_000_000) throw new Error('Report input exceeds 50 MB');
  const run = validateReport(JSON.parse(await readFile(file, 'utf8')));
  const out = resolve(flags.out); await mkdir(out, { recursive: true }); const target = join(out, 'report.html');
  await writeFile(target, renderHTML(run), { flag: 'wx' });
  emit({ outcome: run.outcome, report: target }, `${run.outcome} report: ${target}`); await maybeOpen(target, flags);
});
try { await program.parseAsync(); }
catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else { if (process.exitCode !== 130) process.exitCode = 2; emit({ outcome: 'ERROR', exitCode: process.exitCode, reason: error instanceof Error ? error.message : String(error) }, `ERROR: ${error instanceof Error ? error.message : String(error)}`); }
}
