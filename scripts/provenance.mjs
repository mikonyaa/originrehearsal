import { readFile, writeFile } from 'node:fs/promises';
import { platform, release, arch } from 'node:os';
import { chromium } from 'playwright';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw new Error('CI source SHA is required');
const browser = await chromium.launch(); const version = browser.version(); await browser.close();
const provenance = { version: pkg.version, sourceCommit: process.env.GITHUB_SHA, buildSource: 'GitHub Actions: npm ci, explicit build, npm pack, exact-archive consumer verification', ciRunUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, ciAttempt: process.env.GITHUB_RUN_ATTEMPT, node: process.version, playwright: pkg.dependencies.playwright, chromium: version, os: `${platform()} ${release()} ${arch()}` };
await writeFile(new URL('../artifacts/package/build-provenance.json', import.meta.url), JSON.stringify(provenance, null, 2) + '\n');
