import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const all = [];
async function walk(path) {
  const info = await lstat(path); assert.equal(info.isSymbolicLink(), false, `Publication symlink: ${path}`);
  if (info.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name)); else all.push(path);
}
for (const dir of ['src', 'examples', 'fixtures', 'tests', 'scripts', 'docs', 'site', '.github', 'schemas']) await walk(join(root, dir));
for (const name of ['README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'eslint.config.mjs', '.gitignore', '.npmrc', '.nvmrc']) all.push(join(root, name));
const secret = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|\b(?:aws_secret_access_key|NPM_TOKEN|GITHUB_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9/+]{20,})/;
const privatePath = /\/Users\/bahytzanmeiram|\/private\/(?:tmp|var\/folders)\/originrehearsal-|\/var\/folders\/[^\s"<>]+\/originrehearsal-/;
for (const path of all) {
  const name = relative(root, path);
  assert.equal(/(?:^|\/)(?:node_modules|profiles|auth-state|\.owner)(?:\/|$)/.test(name), false, name);
  if (!['.png', '.mp4'].includes(extname(path))) {
    const text = await readFile(path, 'utf8'); assert.equal(secret.test(text), false, `Secret-like material in ${name}`); assert.equal(privatePath.test(text), false, `Private absolute path in ${name}`);
  }
}
for (const workflow of ['ci.yml']) {
  const text = await readFile(join(root, '.github/workflows', workflow), 'utf8');
  for (const action of text.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(action[1], /^actions\/[a-z-]+@[0-9a-f]{40}$/, `Action must be pinned: ${action[1]}`);
  assert.equal(/pull_request_target|workflow_run|continue-on-error|self-hosted/.test(text), false);
}
const { stdout } = await exec('npm', ['pack', '--dry-run', '--json'], { cwd: root, maxBuffer: 5_000_000 });
const pack = JSON.parse(stdout)[0];
for (const file of pack.files) assert.equal(/(?:^|\/)(?:src|tests|scripts|node_modules|profiles|artifacts|output|auth-state|\.owner)(?:\/|$)|\.log$|\.tgz$/.test(file.path), false, `Unexpected package file: ${file.path}`);
for (const file of ['dist/cli/main.js', 'dist/cli/worker.js', 'dist/sdk/index.js', 'dist/sdk/index.d.ts', 'schemas/upgrade-case.schema.json', 'examples/notes/dist/v1/app.js', 'examples/notes/dist/v2/app.js', 'examples/notes/upgrade.hooks.mjs', 'examples/notes/expected.json', 'LICENSE', 'NOTICE.md']) assert.equal(pack.files.some(entry => entry.path === file), true, `Missing packaged asset: ${file}`);
assert.match(await readFile(join(root, 'dist/cli/main.js'), 'utf8'), /^#!\/usr\/bin\/env node/);
const siteFiles = all.filter(path => path.startsWith(join(root, 'site/'))).map(path => relative(join(root, 'site'), path));
for (const file of siteFiles) assert.match(file, /^(?:index\.html|reports\/(?:good|bad)\.(?:html|json)|media\/(?:[a-z-]+\.png|originrehearsal-demo\.mp4|demo-evidence\.json))$/, `Unexpected Pages file: ${file}`);
for (const [name, expected] of [['good', 'PASS'], ['bad', 'VIOLATION']]) {
  const run = JSON.parse(await readFile(join(root, `site/reports/${name}.json`), 'utf8')); assert.equal(run.outcome, expected); assert.equal(run.control.outcome, 'PASS');
}
await mkdir(join(root, 'artifacts/audit'), { recursive: true });
const evidence = { outcome: 'PASS', checkedOriginalFiles: all.length, secretPatternFindings: 0, privatePathFindings: 0, packlist: pack.files.map(entry => ({ path: entry.path, size: entry.size })), packageSize: pack.size, pagesAllowlist: siteFiles, rights: 'Original synthetic application, reports, screenshots and real demo; MIT. Runtime upstream licenses retained separately.' };
await writeFile(join(root, 'artifacts/audit/publication.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ outcome: 'PASS', checkedOriginalFiles: all.length, packagedFiles: pack.files.length, packageSize: pack.size, siteFiles: siteFiles.length }, null, 2));
