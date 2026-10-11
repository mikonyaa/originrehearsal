import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

export interface Build { root: string; hash: string; files: Map<string, string> }
export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export async function inspectBuild(directory: string): Promise<Build> {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Build directory symlinks are unsupported');
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error(`Build directory is not a directory: ${directory}`);
  const files = new Map<string, string>();
  const hash = createHash('sha256');
  const paths: string[] = []; let totalBytes = 0;
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name); const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Build symlinks are unsupported: ${relative(root, path)}`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        const key = relative(root, path).split(sep).join('/');
        if (key.startsWith('__originrehearsal__')) throw new Error('Build uses reserved __originrehearsal__ path');
        totalBytes += info.size;
        if (info.size > 64 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024 || paths.length >= 10_000) throw new Error('Static build resource limit exceeded (64 MiB/file, 256 MiB/build, 10000 files)');
        paths.push(key);
      } else throw new Error(`Unsupported build entry: ${path}`);
    }
  }
  await walk(root);
  for (const key of paths.sort()) {
    const bytes = await readFile(join(root, key)); files.set(key, digest(bytes));
    hash.update(`${Buffer.byteLength(key)}:${key}:${bytes.length}:`); hash.update(bytes);
  }
  if (!files.has('index.html')) throw new Error(`Build has no index.html: ${directory}`);
  return { root, hash: hash.digest('hex'), files };
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp4': 'video/mp4',
};

export class Gateway {
  readonly server: Server;
  origin = '';
  private active: Build;
  private phase = 'old';
  failure: string | undefined;
  constructor(readonly old: Build, readonly next: Build, readonly runId: string, readonly spaFallback = false) {
    this.active = old;
    this.server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
      void (async () => {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end('Read-only gateway'); return; }
        const raw = (request.url ?? '/').split('?')[0] ?? '/';
        let path: string;
        try { path = decodeURIComponent(raw); } catch { response.writeHead(400).end('Invalid URL encoding'); return; }
        if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) {
          response.writeHead(400).end('Invalid path'); return;
        }
        if (path.startsWith('/__originrehearsal__')) {
          if (path !== '/__originrehearsal__/phase' || request.method !== 'GET') { response.writeHead(404).end(); return; }
          const challenge = new URL(request.url ?? '/', this.origin).searchParams.get('challenge');
          if (!challenge || !/^[a-zA-Z0-9-]{1,128}$/.test(challenge)) { response.writeHead(400).end('Invalid challenge'); return; }
          if (this.failure) { response.writeHead(503).end('Build integrity failure'); return; }
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ runId: this.runId, phase: this.phase, buildHash: this.active.hash, challenge })); return;
        }
        const build = this.active;
        let key = path.slice(1); if (path.endsWith('/')) key += 'index.html';
        if (!build.files.has(key)) {
          if (this.spaFallback && extname(key) === '' && request.headers.accept?.includes('text/html')) key = 'index.html';
          else { response.writeHead(404).end('File not found'); return; }
        }
        const file = resolve(build.root, key);
        const actual = await realpath(file);
        if (!actual.startsWith(build.root + sep) || (await lstat(file)).isSymbolicLink()) throw new Error(`Build path changed: ${key}`);
        const bytes = await readFile(actual);
        if (digest(bytes) !== build.files.get(key)) throw new Error(`Immutable build file changed: ${key}`);
        response.setHeader('Content-Type', mime[extname(key)] ?? 'application/octet-stream');
        response.setHeader('Content-Length', bytes.length);
        response.end(request.method === 'HEAD' ? undefined : bytes);
      })().catch((error: unknown) => {
        this.failure = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) response.writeHead(500);
        response.end('Build read or integrity failure');
      });
    });
    this.server.requestTimeout = 10_000; this.server.headersTimeout = 10_000;
  }
  async listen(port = 0): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(port, '127.0.0.1', () => { this.server.removeListener('error', rej); res(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Gateway did not bind a TCP port');
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  async assertImmutable(): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    for (const build of [this.old, this.next]) {
      if ((await inspectBuild(build.root)).hash !== build.hash) throw new Error('Immutable build directory changed during run');
    }
  }
  async switchTo(phase: 'old' | 'new'): Promise<void> {
    await this.assertImmutable(); this.active = phase === 'old' ? this.old : this.next; this.phase = phase;
  }
  async observe(): Promise<{ runId: string; phase: string; buildHash: string; challenge: string }> {
    await this.assertImmutable();
    const challenge = randomUUID();
    const response = await fetch(`${this.origin}/__originrehearsal__/phase?challenge=${challenge}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Backend challenge returned HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('challenge' in data) || data.challenge !== challenge ||
      !('buildHash' in data) || data.buildHash !== this.active.hash || !('runId' in data) || data.runId !== this.runId ||
      !('phase' in data) || data.phase !== this.phase) throw new Error('Backend challenge identity mismatch');
    return { runId: this.runId, phase: this.phase, buildHash: this.active.hash, challenge };
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>((res, rej) => this.server.close(error => error ? rej(error) : res()));
  }
}
