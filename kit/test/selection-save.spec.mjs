// Saving and loading a selection from the page: the form's own format and key order, so data\select.html and the
// kit read the same file; an existing file is backed up first. Sample data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveSelection, readSelectionRaw, normalizeSelection, parseSelection, selectionText } from '../lib/selection.mjs';

const w = path.win32;
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** A selection as the old form saved it (sample paths). */
const OLD = {
  savedAt: '2026-10-01T09:30:00Z',
  folders: [
    { path: 'C:\\Users\\sample\\ (loose files and .gitconfig)', mode: 'copy whole' },
    { path: 'C:\\git\\tools', mode: 'clone again + bundle/dirty' },
    { path: 'C:\\Users\\sample\\.ssh', mode: 'by hand' },
    { path: 'C:\\old\\stuff', mode: "don't move" },
  ],
  applications: [{ name: 'Git', wingetId: 'Git.Git', source: 'winget' }, { name: 'Some tool', wingetId: '', source: 'download' }],
  settings: [{ app: 'Git', how: 'copy the file' }],
  questions: [{ q: 'Anything else?', a: 'no' }],
  comments: { 'C:\\git\\tools': 'keep the branches' },
  commentLabels: { 'C:\\git\\tools': 'note' },
};

test('normalizeSelection keeps the form format and key order, and fields the kit does not know', () => {
  const messy = { comments: OLD.comments, extra: 42, folders: [...OLD.folders, { path: '   ' }, null], settings: OLD.settings, applications: [...OLD.applications, { wingetId: 'x' }], savedAt: OLD.savedAt };
  const n = normalizeSelection(messy, { savedAt: '2026-11-23T10:00:00Z' });
  assert.deepEqual(Object.keys(n), ['savedAt', 'folders', 'applications', 'settings', 'questions', 'comments', 'commentLabels', 'extra']);
  assert.equal(n.savedAt, '2026-11-23T10:00:00Z');
  assert.equal(n.folders.length, 4);
  assert.equal(n.applications.length, 2);
  assert.deepEqual(n.questions, []);
  assert.deepEqual(n.commentLabels, {});
  assert.equal(n.extra, 42);
  assert.throws(() => normalizeSelection({ applications: [] }), /no folders list/);
});

test('saveSelection writes the form text, backs up an old file, and the result reads back', async (t) => {
  const d = await scratch(t, 'sel');
  const file = w.join(d, 'laptop-move-selection.json');
  const one = await saveSelection(file, OLD, { savedAt: '2026-11-23T10:00:00Z' });
  assert.equal(one.backup, null);
  assert.equal(await readFile(file, 'utf8'), selectionText(one.json));
  assert.match(await readFile(file, 'utf8'), /^\{\n "savedAt": "2026-11-23T10:00:00Z",\n "folders": \[/);

  const back = await readSelectionRaw(file);
  assert.deepEqual(back.folders, OLD.folders);
  assert.deepEqual(back.applications, OLD.applications);
  assert.deepEqual(back.comments, OLD.comments);
  assert.deepEqual(back.commentLabels, OLD.commentLabels);

  const changed = { ...back, folders: back.folders.map((/** @type {any} */ f) => (f.path === 'C:\\git\\tools' ? { ...f, mode: 'clone again' } : f)) };
  const two = await saveSelection(file, changed);
  assert.ok(two.backup && /laptop-move-selection\.\d{4}-\d{2}-\d{2}T\d{6}\.bak\.json$/.test(two.backup), String(two.backup));
  assert.equal((await readSelectionRaw(String(two.backup))).folders[1].mode, 'clone again + bundle/dirty');
  assert.equal((await readSelectionRaw(file)).folders[1].mode, 'clone again');
  assert.ok(!(await readdir(d)).some((f) => f.endsWith('.tmp')), 'no temporary file is left');
});

test('a selection the old form saved, with a byte order mark, loads unchanged', async (t) => {
  const d = await scratch(t, 'old');
  const file = w.join(d, 'old.json');
  await writeFile(file, `\ufeff${JSON.stringify(OLD, null, 1)}\n`, 'utf8');
  const raw = await readSelectionRaw(file);
  assert.deepEqual(raw, OLD);
  const p = parseSelection(raw);
  const modes = Object.fromEntries(p.entries.map((e) => [e.path, e.mode]));
  assert.equal(modes['C:\\git\\tools'], 'bundle');
  assert.equal(modes['C:\\Users\\sample\\.ssh'], 'byhand');
  assert.equal(modes['C:\\old\\stuff'], 'skip');
  assert.ok(p.entries.some((e) => e.loose && e.path === 'C:\\Users\\sample'));
});

test('a file that is not a selection is refused', async (t) => {
  const d = await scratch(t, 'bad');
  const file = w.join(d, 'other.json');
  await writeFile(file, '{"hello": 1}', 'utf8');
  await assert.rejects(readSelectionRaw(file), /no folders list/);
});
