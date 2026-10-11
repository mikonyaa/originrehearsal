import type { Page } from 'playwright';
import type { UpgradeCase } from '../config/index.js';
import type { StorageSnapshot, StoreObservation, DatabaseObservation, Observation, Json, StoredRecord } from '../models.js';

/** All type validation happens in Chromium, before Playwright can serialize a value. */
export async function captureStorage(page: Page, storage: UpgradeCase['storage'], limits: UpgradeCase['limits']): Promise<StorageSnapshot> {
  return page.evaluate(async ({ storage, limits }) => {
    const local: Record<string, Observation<string>> = Object.create(null) as Record<string, Observation<string>>;
    const databases: Record<string, DatabaseObservation> = Object.create(null) as Record<string, DatabaseObservation>;
    const problems: { outcome: 'ERROR' | 'UNSUPPORTED'; subject: string; reason: string }[] = [];
    const problem = (outcome: 'ERROR' | 'UNSUPPORTED', subject: string, reason: string): void => { problems.push({ outcome, subject, reason }); };
    class UnsupportedValue extends Error {}
    const validate = (value: unknown, seen = new Set<object>(), depth = 0): void => {
      if (depth > 100) throw new UnsupportedValue('JSON nesting exceeds 100 levels');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (typeof value !== 'object') throw new UnsupportedValue(`Non-JSON value: ${typeof value}`);
      if (seen.has(value)) throw new UnsupportedValue('Cyclic value');
      const proto = Object.getPrototypeOf(value) as object | null;
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new UnsupportedValue(`Unsupported typed value: ${Object.prototype.toString.call(value)}`);
      if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new UnsupportedValue('Symbol property');
      seen.add(value);
      if (Array.isArray(value)) for (const item of value) validate(item, seen, depth + 1);
      else for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new UnsupportedValue('Non-JSON property descriptor');
        validate(descriptor.value, seen, depth + 1);
      }
      seen.delete(value);
    };
    const timeout = <T>(work: Promise<T>, label: string): Promise<T> => new Promise<T>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${label} timed out`)), limits.phaseTimeoutMs);
      work.then(res, rej).finally(() => clearTimeout(timer)).catch(() => {});
    });
    for (const key of storage.localStorageKeys) {
      try { const value = localStorage.getItem(key); local[key] = value === null ? { state: 'missing' } : { state: 'present', value }; }
      catch (error) { const reason = String(error); local[key] = { state: 'error', reason }; problem('ERROR', `localStorage/${key}`, reason); }
    }
    let listed: IDBDatabaseInfo[] = [];
    let listFailure: 'error' | 'unsupported' | undefined;
    let listReason = '';
    if (typeof indexedDB.databases !== 'function') { listFailure = 'unsupported'; listReason = 'indexedDB.databases() is unavailable'; }
    else try { listed = await timeout(indexedDB.databases(), 'Database enumeration'); }
    catch (error) { listFailure = 'error'; listReason = String(error); }
    for (const selection of storage.indexedDB) {
      const subject = `indexedDB/${selection.name}`;
      if (listFailure) { databases[selection.name] = { state: listFailure, reason: listReason }; problem(listFailure === 'error' ? 'ERROR' : 'UNSUPPORTED', subject, listReason); continue; }
      if (!listed.some(db => db.name === selection.name)) { databases[selection.name] = { state: 'missing' }; continue; }
      let db: IDBDatabase | undefined;
      let disappeared = false;
      try {
        db = await new Promise<IDBDatabase>((res, rej) => {
          let settled = false;
          const request = indexedDB.open(selection.name); // No version; never intentionally creates a DB.
          const fail = (error: Error): void => { if (!settled) { settled = true; clearTimeout(timer); rej(error); } };
          const timer = setTimeout(() => fail(new Error('Database open timed out')), limits.phaseTimeoutMs);
          request.onupgradeneeded = () => { disappeared = true; request.transaction?.abort(); };
          request.onerror = () => fail(new Error(disappeared ? 'Database disappeared; accidental creation was aborted' : `Database open failed: ${request.error?.message}`));
          request.onblocked = () => fail(new Error('Database open blocked'));
          request.onsuccess = () => {
            const connection = request.result;
            connection.onversionchange = () => connection.close();
            if (settled) { connection.close(); return; }
            settled = true; clearTimeout(timer); res(connection);
          };
        });
        const stores: Record<string, StoreObservation> = Object.create(null) as Record<string, StoreObservation>;
        for (const name of selection.stores) {
          if (!db.objectStoreNames.contains(name)) { stores[name] = { state: 'missing' }; continue; }
          try {
            const records = await new Promise<StoredRecord[]>((res, rej) => {
              const tx = db!.transaction(name, 'readonly');
              const rows: StoredRecord[] = []; let cause: Error | undefined; let bytes = 0;
              const timer = setTimeout(() => { cause = new Error('Readonly transaction timed out'); try { tx.abort(); } catch { /* already finished */ } }, limits.phaseTimeoutMs);
              const cursor = tx.objectStore(name).openCursor();
              cursor.onerror = () => { cause = new Error(`Cursor read failed: ${cursor.error?.message}`); };
              cursor.onsuccess = () => {
                const row = cursor.result; if (!row) return;
                try {
                  if (typeof row.key !== 'string' && !(typeof row.key === 'number' && Number.isFinite(row.key))) throw new UnsupportedValue(`Unsupported IDB key: ${Object.prototype.toString.call(row.key)}`);
                  validate(row.value);
                  const record = { key: row.key as string | number, value: row.value as Json };
                  bytes += new TextEncoder().encode(JSON.stringify(record)).length;
                  if (rows.length >= limits.maxRecordsPerStore) throw new UnsupportedValue('maxRecordsPerStore exceeded; incomplete observations discarded');
                  if (bytes > limits.maxSnapshotBytes) throw new UnsupportedValue('maxSnapshotBytes exceeded; incomplete observations discarded');
                  rows.push(record); row.continue();
                } catch (error) { cause = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
              };
              tx.oncomplete = () => { clearTimeout(timer); res(rows); };
              tx.onabort = () => { clearTimeout(timer); rej(cause ?? new Error(`Readonly transaction aborted: ${tx.error?.message}`)); };
              tx.onerror = () => { cause ??= new Error(`Readonly transaction failed: ${tx.error?.message}`); };
            });
            stores[name] = { state: 'present', records };
          } catch (error) {
            const state = error instanceof UnsupportedValue ? 'unsupported' : 'error'; const reason = String(error);
            stores[name] = { state, reason }; problem(state === 'error' ? 'ERROR' : 'UNSUPPORTED', `${subject}/${name}`, reason);
          }
        }
        databases[selection.name] = { state: 'present', version: db.version, stores };
      } catch (error) {
        const reason = String(error); databases[selection.name] = { state: disappeared ? 'missing' : 'error', reason };
        if (!disappeared) problem('ERROR', subject, reason);
      } finally { db?.close(); }
    }
    const snapshot = { capturedAt: new Date().toISOString(), origin: location.origin, complete: problems.length === 0, localStorage: local, indexedDB: databases, problems };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > limits.maxSnapshotBytes) {
      const reason = 'maxSnapshotBytes exceeded; observations discarded instead of truncating';
      for (const key of storage.localStorageKeys) local[key] = { state: 'unsupported', reason };
      for (const db of storage.indexedDB) databases[db.name] = { state: 'unsupported', reason };
      problem('UNSUPPORTED', 'snapshot', reason); snapshot.complete = false;
    }
    return snapshot;
  }, { storage, limits });
}
