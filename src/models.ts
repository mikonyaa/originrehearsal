export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Outcome = 'PASS' | 'VIOLATION' | 'ERROR' | 'UNSUPPORTED';
export type Observation<T> = { readonly state: 'present'; readonly value: T } |
  { readonly state: 'missing' | 'error' | 'unsupported'; readonly reason?: string };
export interface StoredRecord { readonly key: string | number; readonly value: Json }
export type StoreObservation = { readonly state: 'present'; readonly records: readonly StoredRecord[] } |
  { readonly state: 'missing' | 'error' | 'unsupported'; readonly reason?: string };
export type DatabaseObservation = { readonly state: 'present'; readonly version: number; readonly stores: Readonly<Record<string, StoreObservation>> } |
  { readonly state: 'missing' | 'error' | 'unsupported'; readonly reason?: string };
export interface StorageSnapshot {
  readonly capturedAt: string; readonly origin: string; readonly complete: boolean;
  readonly localStorage: Readonly<Record<string, Observation<string>>>;
  readonly indexedDB: Readonly<Record<string, DatabaseObservation>>;
  readonly problems: readonly { outcome: 'ERROR' | 'UNSUPPORTED'; subject: string; reason: string }[];
}
export interface CheckResult {
  id: string; subject: string; expected: Json; actual: Json; outcome: 'PASS' | 'VIOLATION'; explanation: string;
}
export interface LifecycleEvent { phase: string; startedAt: string; durationMs: number; outcome: Outcome; reason: string }
export interface BuildEvidence {
  backend: { runId: string; phase: string; buildHash: string; challenge: string };
  expectedAppId: string; executedAppId: string | null; appConfirmed: boolean; backendConfirmed: boolean;
  origin: string; profileId: string; userDataDirConfirmed: boolean;
  serviceWorkers: { controller: string | null; registrations: string[] };
}
export interface Leg {
  runId: string; kind: 'control' | 'upgrade'; profileId: string; outcome: Outcome;
  events: LifecycleEvent[]; builds: BuildEvidence[]; checks: Record<'seed' | 'cold' | 'upgrade', CheckResult[]>;
  seedFingerprint?: { digest: string; normalization: string[] };
  before?: StorageSnapshot; after?: StorageSnapshot;
  closure: { stage: string; disconnected: boolean; processExited: boolean; forced: boolean }[];
  cleanup: { browserClosed: boolean; profileRemoved: boolean };
}
export interface UpgradeRun {
  schemaVersion: 1; toolVersion: string; runId: string; caseId: string;
  startedAt: string; finishedAt: string; outcome: Outcome; exitCode: number;
  environment: { node: string; playwright: string; chromium: string; os: string; arch: string };
  digests: { config: string; hooks: string; old: string; new: string };
  buildIds: { old: string; new: string };
  origin: string; seed: { inputDigest: string; controlRunId: string; upgradeRunId: string; fingerprintsMatch: boolean };
  cachePolicy: 'no-store'; coverage: { localStorageKeys: string[]; indexedDB: { name: string; stores: string[] }[]; complete: boolean };
  control?: Leg; upgrade?: Leg; events: LifecycleEvent[];
  diagnostics: { outcome: 'ERROR' | 'UNSUPPORTED' | 'VIOLATION'; phase: string; reason: string }[];
  limitations: string[]; cleanup: { gatewayClosed: boolean; ownedRootRemoved: boolean };
}
