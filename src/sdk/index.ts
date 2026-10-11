import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { CheckResult, Json, Observation, StorageSnapshot, StoredRecord } from '../models.js';
export type { UpgradeCase, Hooks } from '../config/index.js';
export type { BuildEvidence, CheckResult, Json, LifecycleEvent, StorageSnapshot, UpgradeRun, Observation, StoredRecord } from '../models.js';

function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Contract values must be finite, acyclic JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Contract values must be plain JSON values');
  seen.add(value); for (const item of Array.isArray(value) ? value : Object.values(value)) assertJson(item, seen); seen.delete(value);
}

export function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as { readonly [key: string]: Json })[key]!)}`).join(',')}}`;
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
export function object(value: Json): Readonly<Record<string, Json>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Contract expected a JSON object');
  return value as Readonly<Record<string, Json>>;
}
export function records(snapshot: StorageSnapshot, database: string, store: string): readonly StoredRecord[] {
  const db = snapshot.indexedDB[database];
  if (!db) throw new Error(`Undeclared database: ${database}`);
  if (db.state === 'missing') return [];
  if (db.state !== 'present') throw new Error(`Cannot evaluate ${database}: ${db.reason}`);
  const result = db.stores[store];
  if (!result) throw new Error(`Undeclared store: ${database}/${store}`);
  if (result.state === 'error' || result.state === 'unsupported') throw new Error(`Cannot evaluate ${database}/${store}: ${result.reason}`);
  return result.state === 'present' ? result.records : [];
}
export function values(snapshot: StorageSnapshot, database: string, store: string): readonly Readonly<Record<string, Json>>[] {
  return records(snapshot, database, store).map(row => object(row.value));
}
export function localJSON(snapshot: StorageSnapshot, key: string): Observation<Json> {
  const observation = snapshot.localStorage[key];
  if (!observation) throw new Error(`Undeclared localStorage key: ${key}`);
  if (observation.state !== 'present') return observation;
  try { const value: unknown = JSON.parse(observation.value); assertJson(value); return { state: 'present', value: value as Json }; }
  catch { throw new Error(`localStorage/${key} is present but is not valid JSON`); }
}

/** Checks are pure assertions against selected storage observations. Hooks are trusted code. */
export class Checks {
  readonly results: CheckResult[] = [];
  fingerprintEvidence: { digest: string; normalization: string[] } | undefined;
  constructor(private readonly targets: string[]) {}
  equal(id: string, subject: string, actual: Json, expected: Json, explanation: string): void {
    if (!id || !subject || !explanation.trim()) throw new Error('Checks require id, subject and an explanation');
    if (!this.targets.some(target => subject === target || subject.startsWith(`${target}/`))) throw new Error(`Check subject is outside selected storage: ${subject}`);
    if (this.results.some(result => result.id === id)) throw new Error(`Duplicate check id: ${id}`);
    if (actual === undefined || expected === undefined) throw new Error(`Check ${id} used undefined; represent missing explicitly`);
    assertJson(actual); assertJson(expected);
    this.results.push({ id, subject, actual, expected, explanation, outcome: isDeepStrictEqual(actual, expected) ? 'PASS' : 'VIOLATION' });
  }
  requiredIds(id: string, subject: string, rows: readonly Readonly<Record<string, Json>>[], ids: readonly string[]): void {
    if (ids.length === 0) throw new Error('requiredIds needs at least one required ID');
    for (const wanted of ids) this.equal(`${id}.${wanted}`, `${subject}/${wanted}/id`, rows.find(row => row.id === wanted)?.id ?? { state: 'missing' }, wanted, 'This stable application ID must survive.');
  }
  preservedFields(id: string, subject: string, before: readonly Readonly<Record<string, Json>>[], after: readonly Readonly<Record<string, Json>>[], fields: readonly string[]): void {
    if (fields.length === 0 || before.length === 0) throw new Error('preservedFields requires baseline records and fields');
    for (const row of before) {
      const next = after.find(item => item.id === row.id);
      for (const field of fields) {
        if (!Object.hasOwn(row, field)) throw new Error(`Baseline field ${String(row.id)}/${field} is absent`);
        this.equal(`${id}.${String(row.id)}.${field}`, `${subject}/${String(row.id)}/${field}`, next && Object.hasOwn(next, field) ? next[field]! : { state: 'missing' }, row[field]!, `Preserve ${field} for the same ID.`);
      }
    }
  }
  transformed(id: string, subject: string, actual: Json, expected: Json, explanation: string): void { this.equal(id, subject, actual, expected, explanation); }
  allowedAbsent(id: string, subject: string, observation: { readonly state: string }, explanation: string): void {
    this.equal(id, subject, observation.state, 'missing', explanation);
  }
  requiredPresence(id: string, subject: string, observation: { readonly state: string }, explanation: string): void {
    this.equal(id, subject, observation.state, 'present', explanation);
  }
  references(id: string, subject: string, rows: readonly Readonly<Record<string, Json>>[], targets: readonly Readonly<Record<string, Json>>[], field = 'tagIds'): void {
    if (rows.length === 0) throw new Error('references needs observed records; use requiredIds to check missing records');
    const known = targets.map(row => row.id);
    for (const row of rows) {
      const refs = row[field];
      this.equal(`${id}.${String(row.id)}`, `${subject}/${String(row.id)}/${field}`, Array.isArray(refs) ? refs.filter(ref => !known.includes(ref)) : { state: 'invalid-reference-list' }, [], 'Every referenced ID must resolve to a preserved record.');
    }
  }
  fingerprint(value: Json, normalization: string[]): void {
    if (this.fingerprintEvidence || normalization.length === 0) throw new Error('Declare one logical fingerprint with explicit normalization rules');
    this.fingerprintEvidence = { digest: createHash('sha256').update(canonical(value)).digest('hex'), normalization: [...normalization] };
  }
  finish(): readonly CheckResult[] {
    if (this.results.length === 0) throw new Error('Empty storage contract: at least one substantive storage check is required');
    return deepFreeze(this.results);
  }
}
