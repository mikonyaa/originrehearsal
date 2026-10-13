import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { renderHTML, validateReport } from '../dist/report/index.js';

// This is renderer regeneration, not a browser run. Keep original capture bytes and timestamps.
for (const name of ['good', 'bad']) {
  const capture = await readFile(new URL(`../site/reports/${name}.json`, import.meta.url));
  const sha256 = createHash('sha256').update(capture).digest('hex');
  const run = validateReport(JSON.parse(capture.toString('utf8')));
  const notice = `<p class="muted">Sample HTML regenerated from a saved v0.1.0 capture; this is not a new browser run. Original run IDs and timestamps are retained. Capture SHA-256: <code>${sha256}</code>.</p>`;
  const html = renderHTML(run).replace('</footer>', `${notice}</footer>`);
  await writeFile(new URL(`../site/reports/${name}.html`, import.meta.url), html);
  console.log(JSON.stringify({ sample: name, captureSha256: sha256, operation: 'renderer regeneration only', outcome: run.outcome }));
}
