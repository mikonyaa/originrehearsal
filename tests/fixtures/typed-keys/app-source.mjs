const mode = '__MODE__';
document.documentElement.dataset.appBuild = '__BUILD_ID__';
const definitions = [['audit-keyed-records', ['records']], ['a/b', ['c']], ['a', ['b/c', 'b']]];
const databases = new Map();
try {
  for (const [name, stores] of definitions) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, mode === 'old' ? 1 : 2);
      request.onupgradeneeded = event => {
        for (const store of stores) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        if (event.oldVersion === 1 && name === 'audit-keyed-records' && mode === 'bad') request.transaction.objectStore('records').delete(1);
        if (event.oldVersion === 1 && name === 'a/b') {
          const store = request.transaction.objectStore('c');
          store.delete('before-only');
          store.put({ nested: null, flag: false, count: 0, text: '' }, 'after-only');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Fixture database open blocked'));
    });
    db.onversionchange = () => db.close(); databases.set(name, db);
  }
  async function write(name, store, rows) {
    await new Promise((resolve, reject) => {
      const tx = databases.get(name).transaction(store, 'readwrite');
      for (const row of rows) tx.objectStore(store).put(row.value, row.key);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
  }
  window.typedFixture = { async seed(inputs) {
    await write('audit-keyed-records', 'records', inputs.core);
    if (inputs.edges) {
      await write('a/b', 'c', inputs.edges);
      await write('a', 'b/c', [{ key: 'd/e', value: '</script><img src=https://example.invalid/escaped onerror=alert(1)> & "quoted"' }]);
      await write('a', 'b', [{ key: 'c', value: 'RECORD_NOT_STORE' }]);
    }
    document.documentElement.dataset.saved = 'true';
  } };
  document.documentElement.dataset.appReady = 'true';
} catch (error) { document.documentElement.dataset.appError = String(error); }
