import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection, normMode } from '../lib/selection.mjs';

test('normMode reads the form labels and loose wording', () => {
  assert.equal(normMode('copy whole'), 'copy');
  assert.equal(normMode('clone again + bundle/dirty'), 'bundle');
  assert.equal(normMode('clone again'), 'clone');
  assert.equal(normMode('by hand'), 'byhand');
  assert.equal(normMode('leave it'), 'skip');
  assert.equal(normMode("don't move"), 'skip');
  assert.equal(normMode('Copy'), 'copy');
  assert.equal(normMode('teleport'), 'unknown');
  assert.equal(normMode(undefined), 'unknown');
});

test('parseSelection keeps the form format: folders, apps, settings', () => {
  const s = parseSelection({
    savedAt: '2026-11-23T10:00:00Z',
    folders: [
      { path: 'c:/work/notes/', mode: 'copy whole' },
      { path: 'C:\\work\\repo', mode: 'clone again' },
    ],
    applications: [
      { name: 'Visual Studio Code', wingetId: 'Microsoft.VisualStudioCode', source: 'winget' },
      { name: 'Visual Studio Code again', wingetId: 'microsoft.visualstudiocode' },
      { name: 'Some tool' },
    ],
    settings: [{ app: 'Git', how: 'copy .gitconfig' }, { nope: 1 }],
    npmCi: ['C:\\work\\repo'],
  });
  assert.equal(s.savedAt, '2026-11-23T10:00:00Z');
  assert.deepEqual(s.entries.map((e) => [e.path, e.mode]), [['C:\\work\\repo', 'clone'], ['C:\\work\\notes', 'copy']]);
  assert.equal(s.apps.length, 2, 'the same winget id is kept once');
  assert.equal(s.apps[0].source, 'winget');
  assert.equal(s.apps[1].source, 'download');
  assert.deepEqual(s.settings, [{ app: 'Git', how: 'copy .gitconfig' }]);
  assert.deepEqual(s.npmCi, ['C:\\work\\repo']);
  assert.deepEqual(s.warnings, []);
});

test('parseSelection: loose files entry, unknown mode, duplicates', () => {
  const s = parseSelection({
    folders: [
      { path: 'C:\\Users\\someone\\ (loose files and .gitconfig)', mode: 'copy whole' },
      { path: 'C:\\Users\\someone', mode: 'by hand' },
      { path: 'C:\\data', mode: 'teleport' },
      { path: 'c:\\DATA\\', mode: 'copy whole' },
    ],
  });
  const loose = s.entries.find((e) => e.loose);
  assert.ok(loose);
  assert.equal(loose.path, 'C:\\Users\\someone');
  assert.equal(loose.mode, 'copy');
  assert.ok(s.entries.some((e) => !e.loose && e.path === 'C:\\Users\\someone' && e.mode === 'byhand'), 'the folder itself is a separate entry');
  const data = s.entries.filter((e) => e.path.toLowerCase() === 'c:\\data');
  assert.equal(data.length, 1);
  assert.equal(data[0].mode, 'byhand', 'unknown mode becomes by hand');
  assert.ok(s.warnings.some((w) => /unknown mode "teleport"/.test(w)));
  assert.ok(s.warnings.some((w) => /listed twice/.test(w)));
});

test('nesting: a copy inside a copy is covered, other picks are excluded from the parent', () => {
  const s = parseSelection({
    folders: [
      { path: 'C:\\work', mode: 'copy whole' },
      { path: 'C:\\work\\docs', mode: 'copy whole' },
      { path: 'C:\\work\\repo', mode: 'clone again' },
      { path: 'C:\\work\\big', mode: 'leave' },
      { path: 'C:\\workshop', mode: 'copy whole' },
    ],
  });
  const by = Object.fromEntries(s.entries.map((e) => [e.path, e]));
  assert.equal(by['C:\\work\\docs'].covered, true);
  assert.equal(by['C:\\work\\repo'].covered, undefined);
  assert.equal(by['C:\\work\\repo'].parent, 'C:\\work');
  assert.deepEqual(by['C:\\work'].exclude.sort(), ['C:\\work\\big', 'C:\\work\\repo']);
  assert.deepEqual(by['C:\\workshop'].exclude, [], 'a sibling with a common prefix is not nested');
});

test('parseSelection refuses a file without a folders list', () => {
  assert.throws(() => parseSelection({}), /no folders list/);
  assert.throws(() => parseSelection(null), /no folders list/);
});
