import type { StorageSnapshot } from '../models.js';

type Subject =
  | { kind: 'localStorage'; key: string }
  | { kind: 'database'; database: string }
  | { kind: 'store'; database: string; store: string }
  | { kind: 'record'; database: string; store: string; key: string | number };
interface StorageRow { subject: Subject; value: unknown }

/** Names are opaque strings; only the typed tuple determines machine identity. */
function identity(subject: Subject): string {
  switch (subject.kind) {
    case 'localStorage': return JSON.stringify([subject.kind, subject.key]);
    case 'database': return JSON.stringify([subject.kind, subject.database]);
    case 'store': return JSON.stringify([subject.kind, subject.database, subject.store]);
    case 'record': return JSON.stringify([subject.kind, subject.database, subject.store, typeof subject.key, subject.key]);
  }
}
export function displaySubject(subject: Subject): string {
  switch (subject.kind) {
    case 'localStorage': return `localStorage/${JSON.stringify(subject.key)}`;
    case 'database': return `indexedDB/${JSON.stringify(subject.database)} [database]`;
    case 'store': return `indexedDB/${JSON.stringify(subject.database)}/${JSON.stringify(subject.store)} [store]`;
    case 'record': return `indexedDB/${JSON.stringify(subject.database)}/${JSON.stringify(subject.store)}/${typeof subject.key}:${JSON.stringify(subject.key)}`;
  }
}
export function storageRows(snapshot: StorageSnapshot | undefined): Map<string, StorageRow> {
  const result = new Map<string, StorageRow>();
  const add = (subject: Subject, value: unknown): void => { result.set(identity(subject), { subject, value }); };
  if (!snapshot) return result;
  for (const [key, value] of Object.entries(snapshot.localStorage)) add({ kind: 'localStorage', key }, value);
  for (const [name, db] of Object.entries(snapshot.indexedDB)) {
    add({ kind: 'database', database: name }, db.state === 'present' ? { state: db.state, version: db.version } : db);
    if (db.state === 'present') for (const [store, observation] of Object.entries(db.stores)) {
      add({ kind: 'store', database: name, store }, observation.state === 'present' ? { state: 'present', records: observation.records.length } : observation);
      if (observation.state === 'present') for (const record of observation.records) add({ kind: 'record', database: name, store, key: record.key }, record.value);
    }
  }
  return result;
}
export function observedValue(rows: Map<string, StorageRow>, id: string): unknown {
  return rows.has(id) ? rows.get(id)!.value : { state: 'not-observed' };
}
