import { values, localJSON } from 'originrehearsal';
import { readFileSync } from 'node:fs';
const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8'));
const subject = 'indexedDB/notes/notes';
const byId = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id, 'en'));
export async function seed({ page, inputs }) {
  // Explicit app API; the runner never writes storage on behalf of the app.
  await page.evaluate(async data => { await window.notesApp.seed(data); }, inputs);
  await page.locator('[data-saved="true"]').waitFor();
}
export function assertSeed({ snapshot, checks }) {
  const notes = values(snapshot, 'notes', 'notes');
  checks.requiredIds('seed.ids', subject, notes, expected.notes.map(note => note.id));
  for (const note of expected.notes) checks.equal(`seed.value.${note.id}`, `${subject}/${note.id}`, notes.find(row => row.id === note.id) ?? { state: 'missing' }, note, 'Seed must match the independent synthetic application specification.');
  checks.equal('seed.tags', 'indexedDB/notes/tags', byId(values(snapshot, 'notes', 'tags')), byId(expected.tags), 'Seed tags must match the declared specification.');
  checks.equal('seed.scratch', 'indexedDB/notes/scratch', values(snapshot, 'notes', 'scratch'), expected.scratch, 'The OLD app persists its transient draft.');
  checks.equal('seed.preferences', 'localStorage/ui-prefs', localJSON(snapshot, 'ui-prefs'), { state: 'present', value: expected.preferences }, 'The OLD app persists its preference values.');
  checks.allowedAbsent('seed.new-key', 'localStorage/preferences', snapshot.localStorage.preferences, 'The new preference key does not exist yet.');
  checks.fingerprint({ notes: byId(notes), tags: byId(values(snapshot, 'notes', 'tags')), scratch: values(snapshot, 'notes', 'scratch'), preferences: localJSON(snapshot, 'ui-prefs') }, ['Sort notes and tags by stable application ID using English collation.', 'Keep fixed createdAt strings, text, tag IDs and preferences unchanged.', 'Exclude capture time and independent physical profile identity.']);
}
export function verifyCold({ before, after, checks }) {
  const old = values(before, 'notes', 'notes'), reopened = values(after, 'notes', 'notes');
  checks.requiredIds('cold.ids', subject, reopened, expected.notes.map(note => note.id));
  checks.preservedFields('cold.fields', subject, old, reopened, ['text', 'createdAt', 'tagIds']);
  checks.equal('cold.tags', 'indexedDB/notes/tags', values(after, 'notes', 'tags'), values(before, 'notes', 'tags'), 'OLD cold-start preserves tags.');
  checks.equal('cold.scratch', 'indexedDB/notes/scratch', values(after, 'notes', 'scratch'), values(before, 'notes', 'scratch'), 'OLD cold-start retains its own scratch store.');
  checks.equal('cold.preferences', 'localStorage/ui-prefs', localJSON(after, 'ui-prefs'), localJSON(before, 'ui-prefs'), 'OLD cold-start retains the OLD preference key.');
  checks.allowedAbsent('cold.new-key', 'localStorage/preferences', after.localStorage.preferences, 'OLD does not run the NEW key migration.');
}
export function verify({ before, after, checks }) {
  const old = values(before, 'notes', 'notes'), migrated = values(after, 'notes', 'notes');
  checks.requiredIds('upgrade.ids', subject, migrated, expected.notes.map(note => note.id));
  checks.preservedFields('upgrade.fields', subject, old, migrated, ['createdAt', 'tagIds']);
  for (const note of old) {
    const next = migrated.find(row => row.id === note.id);
    checks.transformed(`upgrade.body.${note.id}`, `${subject}/${note.id}/body`, next?.body ?? { state: 'missing' }, note.text, 'Rename text → body while preserving the exact content.');
    checks.equal(`upgrade.old-field.${note.id}`, `${subject}/${note.id}/text`, next && 'text' in next ? { state: 'present', value: next.text } : { state: 'missing' }, { state: 'missing' }, 'The obsolete text field is removed by the declared migration.');
  }
  checks.equal('upgrade.tags', 'indexedDB/notes/tags', values(after, 'notes', 'tags'), values(before, 'notes', 'tags'), 'Preserve tag IDs and names.');
  if (migrated.length) checks.references('upgrade.references', subject, migrated, values(after, 'notes', 'tags'));
  checks.equal('upgrade.preferences', 'localStorage/preferences', localJSON(after, 'preferences'), localJSON(before, 'ui-prefs'), 'Move the preference value to its new key unchanged.');
  checks.allowedAbsent('upgrade.old-key', 'localStorage/ui-prefs', after.localStorage['ui-prefs'], 'Removing the old key is intentional after successful transfer.');
  checks.allowedAbsent('upgrade.scratch', 'indexedDB/notes/scratch', after.indexedDB.notes.state === 'present' ? after.indexedDB.notes.stores.scratch : after.indexedDB.notes, 'Transient scratch data is intentionally removed.');
}
