import { chromium, type BrowserContext, type Page } from 'playwright';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };

export class OwnedProfiles {
  root = '';
  readonly marker = randomUUID();
  private profiles = new Map<string, string>();
  async prepare(): Promise<void> {
    this.root = await realpath(await mkdtemp(join(tmpdir(), 'originrehearsal-')));
    await chmod(this.root, 0o700); await writeFile(join(this.root, '.owner'), this.marker, { mode: 0o600 });
  }
  async create(kind: 'control' | 'upgrade'): Promise<OwnedProfile> {
    const id = `${kind}-${randomUUID()}`; const path = join(this.root, id);
    await mkdir(path, { mode: 0o700 }); await writeFile(join(path, '.owner'), id, { mode: 0o600 });
    this.profiles.set(id, path); return new OwnedProfile(id, path);
  }
  async remove(profile: OwnedProfile): Promise<void> {
    if (profile.context) throw new Error('Cannot remove a profile with an unclosed browser');
    const path = this.profiles.get(profile.id);
    if (path !== profile.path || (await lstat(path)).isSymbolicLink() || await readFile(join(path, '.owner'), 'utf8') !== profile.id) throw new Error('Profile ownership could not be confirmed');
    await rm(path, { recursive: true }); this.profiles.delete(profile.id);
  }
  async cleanup(): Promise<void> {
    if (!this.root) return;
    if (this.profiles.size !== 0) throw new Error('Owned root retained because a profile did not close cleanly');
    if ((await lstat(this.root)).isSymbolicLink() || await readFile(join(this.root, '.owner'), 'utf8') !== this.marker) throw new Error('Temp root ownership mismatch');
    await rm(this.root, { recursive: true });
  }
}

export class OwnedProfile {
  context: BrowserContext | undefined;
  browserVersion = '';
  confirmed = false;
  pid: number | undefined;
  constructor(readonly id: string, readonly path: string) {}
  async launch(timeout: number, headed = false, videoDir?: string): Promise<Page> {
    if (this.context) throw new Error('This profile already has a browser');
    if (await readFile(join(this.path, '.owner'), 'utf8') !== this.id) throw new Error('Profile marker changed');
    this.context = await chromium.launchPersistentContext(this.path, {
      headless: !headed, timeout, viewport: { width: 1280, height: 800 },
      args: ['--enable-automation'],
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}),
    });
    const browser = this.context.browser();
    if (!browser) throw new Error('Persistent browser handle unavailable');
    this.browserVersion = browser.version();
    const session = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      this.pid = processInfo.find(info => info.type === 'browser')?.id;
      const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
      this.confirmed = args.includes(`--user-data-dir=${this.path}`);
      if (!this.confirmed) throw new Error('Chromium userDataDir differs from the owned profile');
      if (!this.pid || this.pid === process.pid) throw new Error('Chromium process ownership could not be observed');
    } finally { await session.detach(); }
    const page = this.context.pages()[0] ?? await this.context.newPage();
    page.setDefaultTimeout(timeout); page.setDefaultNavigationTimeout(timeout);
    return page;
  }
  private async forceOwnedProcess(): Promise<void> {
    if (!this.pid || !alive(this.pid)) return;
    const { stdout } = await exec('ps', ['-p', String(this.pid), '-o', 'command=']);
    if (!stdout.includes(`--user-data-dir=${this.path}`) || !/chrom(e|ium)/i.test(stdout)) throw new Error('Refusing to terminate an unconfirmed process');
    process.kill(this.pid, 'SIGKILL');
  }
  async close(timeout = 10_000): Promise<{ disconnected: boolean; processExited: boolean; forced: boolean }> {
    const context = this.context;
    if (!context) return { disconnected: true, processExited: this.pid ? !alive(this.pid) : true, forced: false };
    const browser = context.browser(); let forced = false; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([context.close(), new Promise<never>((_res, rej) => { timer = setTimeout(() => rej(new Error('Browser close timed out')), timeout); })]);
    } catch {
      forced = true; await this.forceOwnedProcess();
      await context.close().catch(() => {});
    } finally { clearTimeout(timer); }
    for (let i = 0; this.pid && alive(this.pid) && i < 100; i++) await delay(25);
    const disconnected = !browser?.isConnected(); const processExited = this.pid ? !alive(this.pid) : false;
    if (!disconnected || !processExited) throw new Error('Browser termination was not confirmed; profile retained');
    this.context = undefined; return { disconnected, processExited, forced };
  }
}
