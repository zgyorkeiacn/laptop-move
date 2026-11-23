import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyFile, classifyDir, isBrowserProfile, urlHasPassword, redactUrl } from '../lib/filters.mjs';
import { walk } from '../lib/walk.mjs';

const w = path.win32;

test('secret-bearing files are recognised by name', () => {
  for (const n of ['.env', '.env.local', '.npmrc', '.yarnrc.yml', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'cert.pfx', 'client_secret_123.json',
    'settings.xml', '.git-credentials', '.claude.json', 'Login Data', 'Cookies', 'Local State', 'token.json']) {
    assert.equal(classifyFile(n)?.kind, 'secret', n);
  }
  for (const n of ['README.md', 'package.json', 'env.ts', 'notes.txt', 'index.html', 'environment.md']) {
    assert.equal(classifyFile(n), null, n);
  }
  assert.equal(classifyFile('NTUSER.DAT')?.kind, 'system');
  assert.equal(classifyFile('config', 'c:\\repo\\.git'), null, 'git\'s own files are judged apart');
});

test('regenerable and secret folders', () => {
  assert.equal(classifyDir('node_modules', 'c:\\repo')?.kind, 'skip');
  assert.equal(classifyDir('.temp', 'c:\\repo')?.kind, 'skip');
  assert.equal(classifyDir('dist', 'c:\\repo')?.kind, 'skip');
  assert.equal(classifyDir('.ssh', 'c:\\users\\x')?.kind, 'secret');
  assert.equal(classifyDir('Cache', 'c:\\users\\x\\appdata\\roaming\\code')?.kind, 'skip');
  assert.equal(classifyDir('Cache', 'c:\\work\\project'), null, 'a Cache folder outside AppData is kept');
  assert.equal(classifyDir('workspaceStorage', 'c:\\users\\x\\appdata\\roaming\\code\\user')?.kind, 'skip');
  assert.equal(classifyDir('src', 'c:\\repo'), null);
  assert.equal(classifyDir('objects', 'c:\\repo\\.git'), null);
  assert.equal(classifyDir('User Data', 'c:\\x', ['Local State', 'Default'])?.kind, 'secret');
  assert.equal(isBrowserProfile(['Local State', 'Profile 2']), true);
  assert.equal(isBrowserProfile(['Default']), false);
});

test('remote URLs with a password', () => {
  assert.equal(urlHasPassword('https://user:secretvalue@example.com/org/repo.git'), true);
  assert.equal(urlHasPassword('https://user@example.com/org/repo.git'), false);
  assert.equal(urlHasPassword('git@example.com:org/repo.git'), false);
  assert.equal(redactUrl('https://user:secretvalue@example.com/r.git'), 'https://user@example.com/r.git');
});

test('walk of a scratch sample: secrets by hand, regenerable folders left out, junctions recorded, never followed', async (t) => {
  const root = await mkdtemp(w.join(os.tmpdir(), 'lmk-walk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(w.join(root, 'src'), { recursive: true });
  await writeFile(w.join(root, 'src', 'a.txt'), 'hello');
  await writeFile(w.join(root, 'README.md'), 'readme');
  await writeFile(w.join(root, '.env'), 'X=1');
  await writeFile(w.join(root, '.npmrc'), 'registry=https://example.com/');
  await mkdir(w.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(w.join(root, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(1000));
  await mkdir(w.join(root, '.temp'), { recursive: true });
  await writeFile(w.join(root, '.temp', 'scratch.txt'), 'tmp');
  await mkdir(w.join(root, '.ssh'), { recursive: true });
  await writeFile(w.join(root, '.ssh', 'id_ed25519'), 'not a real key');
  await mkdir(w.join(root, 'target-folder'), { recursive: true });
  await writeFile(w.join(root, 'target-folder', 'b.txt'), 'bb');
  await symlink(w.join(root, 'target-folder'), w.join(root, 'link-to-target'), 'junction');

  const r = await walk(root);
  const rel = (/** @type {string} */ p) => w.relative(root, p);
  assert.deepEqual(r.files.map((f) => rel(f.path)).sort(), ['README.md', 'src\\a.txt', 'target-folder\\b.txt']);
  assert.equal(r.bytes, 5 + 6 + 2);
  assert.deepEqual(r.byHand.map((b) => rel(b.path)).sort(), ['.env', '.npmrc', '.ssh']);
  assert.deepEqual(r.skipped.map((s) => rel(s.path)).sort(), ['.temp', 'node_modules']);
  assert.equal(r.links.length, 1);
  assert.equal(rel(r.links[0].path), 'link-to-target');
  assert.equal(r.links[0].dir, true);
  assert.equal(r.links[0].target.toLowerCase(), w.join(root, 'target-folder').toLowerCase());
  assert.deepEqual(r.repos, []);
});

test('walk: loose takes only the files directly in the folder', async (t) => {
  const root = await mkdtemp(w.join(os.tmpdir(), 'lmk-loose-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(w.join(root, '.gitconfig'), '[user]');
  await writeFile(w.join(root, '.npmrc'), 'x');
  await mkdir(w.join(root, 'sub'));
  await writeFile(w.join(root, 'sub', 'deep.txt'), 'x');
  const r = await walk(root, { loose: true });
  assert.deepEqual(r.files.map((f) => w.basename(f.path)), ['.gitconfig']);
  assert.deepEqual(r.byHand.map((b) => w.basename(b.path)), ['.npmrc']);
});
