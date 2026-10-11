import { chromium } from 'playwright';
import { mkdir, mkdtemp, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { runCase } from '../dist/runner/index.js';
import { Gateway, inspectBuild } from '../dist/gateway/index.js';
import { OwnedProfiles } from '../dist/profile/index.js';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'artifacts/media'), { recursive: true });
const evidence = await mkdtemp(join(root, 'artifacts/media/recording-'));
const raw = join(evidence, 'raw'); await mkdir(raw);
const site = join(root, 'site'); await mkdir(join(site, 'reports'), { recursive: true }); await mkdir(join(site, 'media'), { recursive: true });
const clips = [], stages = [];
for (const [name, config, outcome] of [['bad', 'bad-case.json', 'VIOLATION'], ['good', 'upgrade-case.json', 'PASS']]) {
  const appClips = [];
  const run = await runCase(join(root, 'examples/notes', config), {
    out: join(evidence, name), videoDir: raw,
    onPage: async (page, stage, kind) => {
      if (kind === 'upgrade' && (stage === 'before-captured' || stage === 'after-captured')) {
        await page.screenshot({ path: join(site, `media/${name}-${stage}.png`) });
        appClips.push(await page.video().path());
        await page.waitForTimeout(2800);
      }
    },
  });
  assert.equal(run.outcome, outcome); assert.equal(run.control.outcome, 'PASS');
  const report = join(evidence, name, 'report.html'); await cp(report, join(site, `reports/${name}.html`)); await cp(join(evidence, name, 'run.json'), join(site, `reports/${name}.json`));
  clips.push(...appClips);
  const browser = await chromium.launch(); const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: raw, size: { width: 1280, height: 800 } } });
  try {
    const page = await context.newPage(); await page.goto(pathToFileURL(report).href); await page.waitForTimeout(900);
    if (name === 'bad') { await page.locator('#violations').click(); await page.locator('#search').fill('note-006'); }
    else { await page.locator('#search').fill('upgrade.body.note-001'); await page.locator('#all').click(); }
    await page.screenshot({ path: join(site, `media/${name}-report.png`) }); await page.waitForTimeout(3500);
    clips.push(await page.video().path());
  } finally { await context.close(); await browser.close(); }
  stages.push({ name, outcome, coldControl: run.control.outcome, executedBuild: run.upgrade.builds[1].executedAppId, origin: run.origin, sameProfile: run.upgrade.builds[0].profileId === run.upgrade.builds[1].profileId });
}
// Real fresh-install UI on the exact BAD build, separate from the upgrade path.
const profiles = new OwnedProfiles(); await profiles.prepare(); const profile = await profiles.create('upgrade');
const build = await inspectBuild(join(root, 'examples/notes/dist/bad')); const gateway = new Gateway(build, build, 'demo-fresh-install');
try {
  await gateway.listen(); const page = await profile.launch(30_000, false, raw); await page.goto(gateway.origin); await page.waitForSelector('[data-app-ready="true"]');
  await page.locator('#text').fill('Fresh install passes. This does not protect existing notes.'); await page.getByRole('button', { name: 'Save note', exact: true }).click(); await page.getByText('Note saved after transaction completion').waitFor();
  assert.equal(await page.locator('#count').textContent(), '1 saved notes');
  await page.screenshot({ path: join(site, 'media/bad-fresh-install.png') }); await page.waitForTimeout(3000); clips.splice(3, 0, await page.video().path());
} finally { await profile.close(); await profiles.remove(profile); await gateway.close(); await profiles.cleanup(); }
const list = join(evidence, 'clips.txt'); await writeFile(list, clips.map(path => `file '${path.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
const mp4 = join(site, 'media/originrehearsal-demo.mp4');
await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=24,scale=1280:800', '-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], { maxBuffer: 10_000_000 });
const { stdout } = await exec('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', mp4]);
const metadata = JSON.parse(stdout); assert.equal(Number(metadata.format.duration) >= 20 && Number(metadata.format.duration) <= 35, true, stdout);
await writeFile(join(site, 'media/demo-evidence.json'), JSON.stringify({ origin: 'real runner; no storage restore', stages, freshInstall: 'BAD build saved and read a new note through its UI', media: metadata.format }, null, 2));
console.log(JSON.stringify({ outcome: 'PASS', evidence, media: mp4, ...metadata }, null, 2));
