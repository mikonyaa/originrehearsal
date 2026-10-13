import { z } from 'zod';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, inspectBuild, type Build } from '../gateway/index.js';
import type { StorageSnapshot, Json } from '../models.js';
import type { Checks } from '../sdk/index.js';
import type { Page } from 'playwright';

const names = z.array(z.string().min(1).max(500)).max(100).refine(v => new Set(v).size === v.length, 'Duplicate names');
export const caseSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().min(1).max(200),
  old: z.strictObject({ dir: z.string().min(1), buildId: z.string().min(1).max(200) }),
  new: z.strictObject({ dir: z.string().min(1), buildId: z.string().min(1).max(200) }),
  app: z.strictObject({
    path: z.string().startsWith('/').default('/'), buildSelector: z.string().min(1), buildAttribute: z.string().min(1),
    readySelector: z.string().min(1), errorSelector: z.string().min(1).optional(),
    errorAttribute: z.string().min(1).default('data-app-error'),
  }),
  hooks: z.string().min(1), seedInputs: z.json(),
  storage: z.strictObject({ localStorageKeys: names.meta({ uniqueItems: true }), indexedDB: z.array(z.strictObject({ name: z.string().min(1).max(500), stores: names.min(1).meta({ uniqueItems: true }) })).max(50).meta({ uniqueItems: true }) })
    .refine(v => new Set(v.indexedDB.map(d => d.name)).size === v.indexedDB.length, 'Duplicate databases')
    .refine(v => v.localStorageKeys.length + v.indexedDB.length > 0, 'Declare at least one storage target'),
  limits: z.strictObject({
    phaseTimeoutMs: z.number().int().min(500).max(120_000).default(30_000),
    maxRecordsPerStore: z.number().int().min(1).max(100_000).default(1000),
    maxSnapshotBytes: z.number().int().min(256).max(50_000_000).default(5_000_000),
  }).default({ phaseTimeoutMs: 30_000, maxRecordsPerStore: 1000, maxSnapshotBytes: 5_000_000 }),
  gateway: z.strictObject({ port: z.number().int().min(0).max(65535).default(0), spaFallback: z.boolean().default(false) })
    .default({ port: 0, spaFallback: false }),
}).refine(v => v.old.buildId !== v.new.buildId, { message: 'OLD and NEW build IDs must differ', path: ['new', 'buildId'] });

export type UpgradeCase = z.infer<typeof caseSchema>;
export interface Hooks {
  seed: (args: { page: Page; origin: string; inputs: Json }) => Promise<void>;
  assertSeed: (args: { snapshot: StorageSnapshot; checks: Checks }) => void | Promise<void>;
  verifyCold: (args: { before: StorageSnapshot; after: StorageSnapshot; checks: Checks }) => void | Promise<void>;
  verify: (args: { before: StorageSnapshot; after: StorageSnapshot; checks: Checks }) => void | Promise<void>;
}
export interface LoadedCase { config: UpgradeCase; hooks: Hooks; old: Build; next: Build; configDigest: string; hooksDigest: string }
export async function loadCase(file: string): Promise<LoadedCase> {
  const raw = await readFile(file, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Config is not valid JSON'); }
  const validated = caseSchema.safeParse(parsed);
  if (!validated.success) throw new Error(`Invalid case: ${validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const config = validated.data;
  const base = dirname(resolve(file));
  if (!config.hooks.endsWith('.mjs') || /^[a-z][a-z0-9+.-]*:/i.test(config.hooks) || config.hooks.startsWith('//')) {
    throw new Error('hooks must explicitly name a local .mjs file (remote modules are not supported)');
  }
  const url = new URL(config.app.path, 'http://127.0.0.1:1');
  if (url.origin !== 'http://127.0.0.1:1' || config.app.path.startsWith('//') || config.app.path.includes('\\') || config.app.path.startsWith('/__originrehearsal__')) {
    throw new Error('app.path must stay on the gateway origin and outside reserved paths');
  }
  const hookPath = await realpath(isAbsolute(config.hooks) ? config.hooks : resolve(base, config.hooks));
  if (!(await stat(hookPath)).isFile()) throw new Error('hooks must be a regular local file');
  const hooksDigest = digest(await readFile(hookPath));
  const [old, next] = await Promise.all([inspectBuild(resolve(base, config.old.dir)), inspectBuild(resolve(base, config.new.dir))]);
  const module: Record<string, unknown> = await import(`${pathToFileURL(hookPath).href}?digest=${hooksDigest}`);
  for (const name of ['seed', 'assertSeed', 'verifyCold', 'verify']) {
    if (typeof module[name] !== 'function') throw new Error(`Hook ${name} must be an exported function`);
  }
  return { config, hooks: module as unknown as Hooks, old, next, configDigest: digest(raw), hooksDigest };
}
