import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { runCase } from '../../dist/runner/index.js';
import { observeBuild, assertIdentity } from '../../dist/runner/evidence.js';
import { expected, fixtureRoot, output, cli, copyCase, lowFixture, nativeInventory } from '../helpers.mjs';
const config = JSON.parse(await readFile(join(fixtureRoot, 'upgrade-case.json'), 'utf8'));
const hookSource = await readFile(join(fixtureRoot, 'upgrade.hooks.mjs'), 'utf8');
const readRun = async out => JSON.parse(await readFile(join(out, 'run.json'), 'utf8'));

test('real control + GOOD/BAD/same-count upgrades, independently observed native data', { timeout: 120_000 }, async () => {
  for (const [file, wanted] of [['upgrade-case.json', 'PASS'], ['bad-case.json', 'VIOLATION'], ['mutant-case.json', 'VIOLATION']]) {
    const out = await output(file.replace('.json', '')); const native = [];
    const run = await runCase(join(fixtureRoot, file), { out, onPage: async (page, stage, kind) => { if (stage === 'before-captured' || stage === 'after-captured') native.push({ stage, kind, data: await nativeInventory(page) }); } });
    assert.equal(run.outcome, wanted); assert.equal(run.exitCode, wanted === 'PASS' ? 0 : 1);
    assert.equal(run.control.outcome, 'PASS'); assert.equal(run.seed.fingerprintsMatch, true); assert.equal(run.coverage.complete, true);
    assert.notEqual(run.control.profileId, run.upgrade.profileId); assert.notEqual(run.seed.controlRunId, run.seed.upgradeRunId);
    for (const leg of [run.control, run.upgrade]) {
      assert.equal(leg.builds.length, 2); assert.equal(leg.builds[0].profileId, leg.builds[1].profileId);
      assert.equal(leg.closure[0].stage, 'old'); assert.equal(leg.closure[0].processExited, true); assert.equal(leg.closure[0].disconnected, true); assert.equal(leg.closure[0].forced, false);
      assert.equal(leg.builds.every(build => build.origin === run.origin && build.appConfirmed && build.backendConfirmed && build.userDataDirConfirmed), true);
      assert.equal(leg.cleanup.profileRemoved, true);
    }
    assert.equal(run.cleanup.ownedRootRemoved, true); assert.match(run.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const cold = native.find(item => item.kind === 'control' && item.stage === 'after-captured').data;
    assert.deepEqual(cold.databases.notes.stores.notes.values, expected.notes);
    assert.equal(cold.databases.notes.version, 1); assert.equal('body' in cold.databases.notes.stores.notes.values[0], false);
    assert.equal(cold.localStorage['ui-prefs'], JSON.stringify(expected.preferences)); assert.equal(cold.localStorage.preferences, undefined);
    const after = native.find(item => item.kind === 'upgrade' && item.stage === 'after-captured').data;
    assert.equal(after.databases.notes.version, 2); assert.equal(after.databases.notes.stores.scratch, undefined);
    assert.equal(after.localStorage['ui-prefs'], undefined); assert.equal(after.localStorage.preferences, JSON.stringify(expected.preferences));
    const rows = after.databases.notes.stores.notes.values;
    if (wanted === 'PASS') {
      assert.deepEqual(rows, expected.notes.map(({ text, ...note }) => ({ ...note, body: text })));
      assert.equal(run.upgrade.checks.upgrade.find(check => check.id === 'upgrade.scratch').outcome, 'PASS');
    } else if (file === 'bad-case.json') {
      assert.equal(rows.length, 5); assert.equal(run.upgrade.checks.upgrade.find(check => check.id === 'upgrade.ids.note-006').outcome, 'VIOLATION');
      assert.deepEqual(rows.map(row => row.id), expected.notes.slice(0, 5).map(row => row.id));
    } else {
      assert.equal(rows.length, 20); assert.equal(rows[0].body, 'CORRUPTED but same count'); assert.deepEqual(rows[1].tagIds, ['tag-missing']);
      assert.equal(run.upgrade.checks.upgrade.find(check => check.id === 'upgrade.references.note-002').outcome, 'VIOLATION');
    }
    assert.equal((await readRun(out)).outcome, wanted);
  }
});
test('CLI JSON is one result; GOOD=0 BAD=1 SW=3, installed scenario semantics', async () => {
  for (const [file, code, outcome] of [['upgrade-case.json', 0, 'PASS'], ['bad-case.json', 1, 'VIOLATION'], ['sw-case.json', 3, 'UNSUPPORTED']]) {
    const out = await output(`cli-${outcome}`); const result = await cli(['run', join(fixtureRoot, file), '--out', out, '--json', '--no-open']).done;
    assert.equal(result.code, code, result.stderr + result.stdout); const json = JSON.parse(result.stdout); assert.equal(json.outcome, outcome); assert.match(result.stderr, /\[old-ready\]/);
    assert.equal(json.cleanup.ownedRootRemoved, true);
    if (outcome === 'UNSUPPORTED') assert.equal(json.control.builds[0].serviceWorkers.registrations.length > 0, true);
  }
});
test('same BAD build passes an actual fresh-install create/read/cold reopen UI path', async () => {
  const fixture = await lowFixture('bad', 'bad');
  try {
    const { page, profile } = await fixture.open(); await page.locator('#text').fill('Fresh install succeeds; existing users still lose notes.');
    await page.getByRole('button', { name: 'Save note', exact: true }).click(); await page.getByText('Note saved after transaction completion').waitFor();
    assert.equal((await nativeInventory(page)).databases.notes.stores.notes.values[0].body, 'Fresh install succeeds; existing users still lose notes.');
    await profile.close(); const reopened = await fixture.open('upgrade', profile);
    assert.equal((await nativeInventory(reopened.page)).databases.notes.stores.notes.values[0].id, 'fresh-note');
  } finally { await fixture.close(); }
});
test('allowed scratch deletion passes; identical deletion under required-presence violates', async () => {
  const modified = hookSource.replace("checks.allowedAbsent('upgrade.scratch'", "checks.requiredPresence('upgrade.scratch'");
  const c = await copyCase('required-scratch', () => {}, modified); const run = await runCase(c.file, { out: c.out });
  assert.equal(run.outcome, 'VIOLATION'); assert.equal(run.upgrade.checks.upgrade.filter(check => check.outcome === 'VIOLATION').length, 1); assert.equal(run.upgrade.checks.upgrade.find(check => check.outcome === 'VIOLATION').id, 'upgrade.scratch');
});
test('aborted migration/readiness is ERROR with NEW evidence, not a data-loss verdict', async () => {
  const out = await output('aborted'); const run = await runCase(join(fixtureRoot, 'abort-case.json'), { out });
  assert.equal(run.exitCode, 2); assert.equal(run.outcome, 'ERROR'); assert.equal(run.control.outcome, 'PASS');
  assert.equal(run.upgrade.builds[1].appConfirmed, true); assert.equal(run.upgrade.after, undefined);
  assert.equal(run.diagnostics.some(d => d.phase === 'new-ready' && d.reason.includes('Database migration failed')), true); assert.deepEqual(run.upgrade.checks.upgrade, []);
});
test('NEW backend and real persistent stale OLD service worker sentinel disagree', async () => {
  const fixture = await lowFixture('sw', 'v2');
  try {
    const { page, profile } = await fixture.open(); await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.getByRole('button', { name: 'Load 20 synthetic notes' }).click(); await page.waitForSelector('[data-saved="true"]');
    const oldOrigin = await page.evaluate(() => location.origin); await profile.close(); await fixture.gateway.switchTo('new');
    const reopened = await fixture.open('upgrade', profile);
    const evidence = await observeBuild(reopened.page, fixture.gateway, profile, config.app, 'notes-v2');
    assert.equal(evidence.backend.phase, 'new'); assert.equal(evidence.backend.buildHash, fixture.gateway.next.hash); assert.equal(evidence.backendConfirmed, true);
    assert.equal(evidence.executedAppId, 'notes-v1-sw'); assert.equal(evidence.appConfirmed, false); assert.equal(evidence.origin, oldOrigin); assert.equal(evidence.serviceWorkers.controller !== null, true);
    assert.throws(() => assertIdentity(evidence, oldOrigin, profile.id), /Executed app mismatch/);
    const out = await output('stale-sw-detector'); await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  } finally { await fixture.close(); }
});
test('real different origin and fresh-profile substitutions are rejected', async () => {
  const source = hookSource.replace('await page.evaluate(async data', "await page.goto(origin.replace('127.0.0.1', 'localhost')); await page.waitForSelector('[data-app-ready=\"true\"]'); await page.evaluate(async data").replace('seed({ page, inputs })', 'seed({ page, origin, inputs })');
  const c = await copyCase('wrong-origin', () => {}, source); const result = await runCase(c.file, { out: c.out }); assert.equal(result.outcome, 'ERROR'); assert.equal(result.diagnostics.some(d => d.reason.includes('origin changed')), true);
  const fixture = await lowFixture();
  try {
    const first = await fixture.open(); await first.profile.close(); await fixture.gateway.switchTo('new');
    const fresh = await fixture.open(); const evidence = await observeBuild(fresh.page, fixture.gateway, fresh.profile, config.app, 'notes-v2');
    assert.equal(evidence.appConfirmed, true); assert.throws(() => assertIdentity(evidence, fixture.gateway.origin, first.profile.id), /profile.*mismatch/);
  } finally { await fixture.close(); }
});
test('occupied explicit port leaves its owner serving requests', async () => {
  const server = createServer((_req, res) => res.end('still owned')); await new Promise(res => server.listen(0, '127.0.0.1', res));
  try {
    const port = server.address().port; const c = await copyCase('occupied', cfg => cfg.gateway = { port });
    const run = await runCase(c.file, { out: c.out }); assert.equal(run.outcome, 'ERROR'); assert.equal(run.diagnostics.some(d => d.reason.includes('EADDRINUSE')), true);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'still owned');
  } finally { server.closeAllConnections(); await new Promise(res => server.close(res)); }
});
test('hook exception, empty callbacks and timeout never pass and close owned resources', async () => {
  for (const [name, suffix] of [
    ['throws', "export async function seed(){throw new Error('Deliberate seed hook exception')} export function assertSeed(){} export function verifyCold(){} export function verify(){}"],
    ['seed-empty', hookSource.replace(/export function assertSeed\(\{ snapshot, checks \}\) \{[\s\S]*?\n\}\nexport function verifyCold/, 'export function assertSeed() {}\nexport function verifyCold')],
    ['cold-empty', hookSource.replace(/export function verifyCold\(\{ before, after, checks \}\) \{[\s\S]*?\n\}\nexport function verify/, 'export function verifyCold() {}\nexport function verify')],
    ['upgrade-empty', hookSource.replace(/export function verify\([\s\S]*/, 'export function verify(){}')],
    ['seed-timeout', hookSource.replace(/export async function seed\([\s\S]*?\n\}\nexport function assertSeed/, 'export async function seed(){await new Promise(()=>{})}\nexport function assertSeed')],
  ]) {
    const c = await copyCase(name, cfg => { cfg.limits.phaseTimeoutMs = 2000; }, suffix);
    const run = await runCase(c.file, { out: c.out }); assert.equal(run.outcome, 'ERROR', name); assert.equal(run.exitCode, 2); assert.equal(run.cleanup.ownedRootRemoved, true, name);
  }
});
test('browser crash is ERROR and cleanup confirms process exit', async () => {
  const c = await copyCase('crash', cfg => cfg.limits.phaseTimeoutMs = 2000); let crashed = false;
  const run = await runCase(c.file, { out: c.out, onPage: async (page, stage) => {
    if (stage === 'old-ready' && !crashed) { crashed = true; const session = await page.context().browser().newBrowserCDPSession(); await session.send('Browser.crash').catch(() => {}); throw new Error('Owned browser crashed'); }
  } });
  assert.equal(run.outcome, 'ERROR'); assert.equal(run.control.cleanup.browserClosed, true); assert.equal(run.cleanup.ownedRootRemoved, true);
});
test('synchronously hung trusted hook has an external deadline and owned cleanup', { timeout: 25_000 }, async () => {
  const suffix = hookSource.replace(/export async function seed\([\s\S]*?\n\}\nexport function assertSeed/, 'export async function seed(){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}\nexport function assertSeed');
  const c = await copyCase('sync-hang', cfg => cfg.limits.phaseTimeoutMs = 2000, suffix);
  const result = await cli(['run', c.file, '--out', c.out, '--json', '--no-open']).done;
  assert.equal(result.code, 2); const report = JSON.parse(result.stdout); assert.equal(report.outcome, 'ERROR'); assert.equal(report.cleanup.ownedRootRemoved, true); assert.equal(report.diagnostics.some(d => d.phase === 'supervisor'), true);
});
test('Ctrl-C returns 130 and a concurrent run cannot overwrite its evidence or own its profile', async () => {
  const suffix = hookSource.replace(/export async function seed\([\s\S]*?\n\}\nexport function assertSeed/, 'export async function seed(){await new Promise(()=>{})}\nexport function assertSeed');
  const c = await copyCase('interrupt', () => {}, suffix);
  const first = cli(['run', c.file, '--out', c.out, '--json', '--no-open']); await first.waitFor('[seed-complete] started');
  const second = await cli(['run', c.file, '--out', c.out, '--json', '--no-open']).done; assert.equal(second.code, 2); assert.match(JSON.parse(second.stdout).reason, /another run/);
  first.child.kill('SIGINT'); const interrupted = await first.done; assert.equal(interrupted.code, 130, interrupted.stderr);
  const run = JSON.parse(interrupted.stdout); assert.equal(run.exitCode, 130); assert.equal(run.cleanup.ownedRootRemoved, true); assert.equal(run.control.cleanup.profileRemoved, true);
  const saved = await readRun(c.out); const retry = await cli(['run', c.file, '--out', c.out, '--json', '--no-open']).done; assert.equal(retry.code, 2); assert.deepEqual(await readRun(c.out), saved);
});
