import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusZ } from '../lib/git.mjs';
import { dirtyProblem } from '../lib/plan.mjs';

test('parseStatusZ: changed, added, untracked, renamed, deleted', () => {
  const out = [' M src/a.ts', 'A  src/new.ts', '?? notes/todo.md', 'R  src/renamed.ts', 'src/old.ts', ' D src/gone.ts', 'D  src/staged-gone.ts', '!! dist/x.js', ''].join('\0');
  const s = parseStatusZ(out);
  assert.deepEqual(s.changed, ['src\\a.ts', 'src\\new.ts', 'notes\\todo.md', 'src\\renamed.ts']);
  assert.deepEqual(s.deleted, ['src\\gone.ts', 'src\\staged-gone.ts']);
  assert.deepEqual(parseStatusZ(''), { changed: [], deleted: [] });
});

test('uncommitted files that are never carried', () => {
  assert.equal(dirtyProblem('C:\\repo', '.env')?.kind, 'secret');
  assert.equal(dirtyProblem('C:\\repo', 'packages\\app\\.env.local')?.kind, 'secret');
  assert.equal(dirtyProblem('C:\\repo', 'node_modules\\x\\index.js')?.kind, 'skip');
  assert.equal(dirtyProblem('C:\\repo', 'src\\.temp\\a.txt')?.kind, 'skip');
  assert.equal(dirtyProblem('C:\\repo', 'src\\index.ts'), null);
});
