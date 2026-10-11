// Each build embeds its own identity here, never in the initial HTML or gateway.
const BUILD_ID = 'notes-v1-sw';
const MODE = 'sw';
const OLD = MODE === 'old' || MODE === 'sw';
document.documentElement.setAttribute('data-app-build', BUILD_ID);
document.querySelector('#build').textContent = BUILD_ID;
let db;
const completed = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = tx.onerror = () => reject(new Error(tx.error?.message || 'Transaction aborted'));
});
function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('notes', OLD ? 1 : 2);
    request.onblocked = () => reject(new Error('Database upgrade blocked by another connection'));
    request.onerror = () => reject(new Error(`Database migration failed: ${request.error?.message}`));
    request.onupgradeneeded = event => {
      const database = request.result;
      if (event.oldVersion === 0) {
        database.createObjectStore('notes', { keyPath: 'id' });
        database.createObjectStore('tags', { keyPath: 'id' });
        if (OLD) database.createObjectStore('scratch', { keyPath: 'id' });
      } else if (!OLD) {
        if (MODE === 'abort') { request.transaction.abort(); return; }
        database.deleteObjectStore('scratch');
        const store = request.transaction.objectStore('notes');
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const value = row.value;
          if (MODE === 'bad' && value.id >= 'note-006') row.delete();
          else {
            value.body = value.text;
            delete value.text;
            if (MODE === 'mutant' && value.id === 'note-001') value.body = 'CORRUPTED but same count';
            if (MODE === 'mutant' && value.id === 'note-002') value.tagIds = ['tag-missing'];
            if (MODE === 'typed' && value.id === 'note-001') value.body = new Date('2020-01-01');
            row.update(value);
          }
          row.continue();
        };
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}
async function render() {
  const tx = db.transaction('notes', 'readonly');
  const end = completed(tx);
  const rows = tx.objectStore('notes').getAll();
  await end;
  document.querySelector('#count').textContent = `${rows.result.length} saved notes`;
  const list = document.querySelector('#notes');
  list.replaceChildren();
  for (const row of rows.result) {
    const item = document.createElement('li');
    const id = document.createElement('strong'); id.textContent = row.id;
    const text = document.createElement('p'); text.textContent = OLD ? row.text : row.body;
    item.append(id, text); list.append(item);
  }
}
async function seed(data) {
  const stores = OLD ? ['notes', 'tags', 'scratch'] : ['notes', 'tags'];
  const tx = db.transaction(stores, 'readwrite');
  const end = completed(tx);
  for (const note of data.notes) tx.objectStore('notes').put(OLD ? note : {
    id: note.id, body: note.text, createdAt: note.createdAt, tagIds: note.tagIds,
  });
  for (const tag of data.tags) tx.objectStore('tags').put(tag);
  if (OLD) for (const item of data.scratch) tx.objectStore('scratch').put(item);
  await end;
  localStorage.setItem(OLD ? 'ui-prefs' : 'preferences', JSON.stringify(data.preferences));
  await render();
  // The saved marker is only set after the real IDB transaction completes.
  document.documentElement.setAttribute('data-saved', 'true');
}
async function boot() {
  db = await open();
  if (!OLD && localStorage.getItem('ui-prefs') !== null) {
    localStorage.setItem('preferences', localStorage.getItem('ui-prefs'));
    localStorage.removeItem('ui-prefs');
  }
  if (MODE === 'sw') {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  }
  await render();
  window.notesApp = { seed };
  document.querySelector('#seed').onclick = async () => seed(await (await fetch('/dataset.json')).json());
  document.querySelector('#form').onsubmit = async event => {
    event.preventDefault();
    const text = document.querySelector('#text').value;
    const note = { id: 'fresh-note', createdAt: '2026-01-02T00:00:00Z', tagIds: [] };
    note[OLD ? 'text' : 'body'] = text;
    const tx = db.transaction('notes', 'readwrite'); const end = completed(tx);
    tx.objectStore('notes').put(note); await end; await render();
    document.querySelector('#saved').textContent = 'Note saved after transaction completion';
  };
  document.documentElement.setAttribute('data-app-ready', 'true');
}
boot().catch(error => {
  document.documentElement.setAttribute('data-app-error', error.message);
  document.querySelector('#error').textContent = error.message;
});
