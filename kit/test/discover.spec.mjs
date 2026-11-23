// discover: the read-only look for what could move, on a scratch tree with sample names. A remote's URL never leaves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover, parseWingetExport, suggestMode, findNote, KNOWN_SETTINGS } from '../lib/discover.mjs';
import { emptyRules, parseRules } from '../lib/rules.mjs';

const w = path.win32;
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

const URL_TEAM = 'https://git.example.invalid/team/tools.git';
const URL_CLIENT = 'https://code.sample-client.invalid/app/web.git';

/** @param {string} dir @param {string[]} urls */
async function repo(dir, urls) {
  await mkdir(w.join(dir, '.git'), { recursive: true });
  const remotes = urls.map((u, i) => `[remote "r${i}"]\n\turl = ${u}\n\tfetch = +refs/heads/*:refs/remotes/r${i}/*\n`).join('');
  await writeFile(w.join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remotes}`, 'utf8');
  await writeFile(w.join(dir, 'README.md'), '# sample\n', 'utf8');
}

/** @param {any} t */
async function tree(t) {
  const d = await scratch(t, 'disc');
  await mkdir(w.join(d, 'docs'));
  await writeFile(w.join(d, 'docs', 'note.txt'), 'sample\n');
  await repo(w.join(d, 'tools'), [URL_TEAM]);
  await mkdir(w.join(d, '.ssh'));
  await writeFile(w.join(d, '.ssh', 'id_sample'), 'not a real key\n');
  await mkdir(w.join(d, 'work'));
  await repo(w.join(d, 'work', 'local-only'), []);
  await repo(w.join(d, 'work', 'web'), [URL_CLIENT]);
  await writeFile(w.join(d, 'loose.txt'), 'a file, not a folder\n');
  return d;
}

test('discover lists folders, repositories and secret folders, and never a remote URL', async (t) => {
  const d = await tree(t);
  const before = await readdir(d);
  /** @type {any[]} */ const events = [];
  const r = await discover({ roots: [d], rules: emptyRules(), appLookup: false, emit: (e) => events.push(e) });
  const by = Object.fromEntries(r.found.map((f) => [w.relative(d, f.path), f]));

  assert.equal(by.docs.kind, 'folder');
  assert.equal(by.docs.mode, 'copy whole');
  assert.equal(by.tools.kind, 'repo');
  assert.equal(by.tools.remote, true);
  assert.equal(by.tools.client, false);
  assert.equal(by.tools.mode, 'clone again + bundle/dirty');
  assert.equal(by['.ssh'].kind, 'folder');
  assert.ok(by['.ssh'].secret, 'the .ssh folder is a secret');
  assert.equal(by['.ssh'].mode, 'by hand');
  assert.equal(by.work.kind, 'folder');
  assert.equal(by['work\\local-only'].kind, 'repo');
  assert.equal(by['work\\local-only'].remote, false);
  assert.equal(by['work\\local-only'].parent, w.join(d, 'work'));
  assert.equal(by['work\\local-only'].mode, 'copy whole');
  assert.equal(by['work\\web'].remote, true);
  assert.ok(!('loose.txt' in by), 'files are not finds');

  const text = JSON.stringify(r);
  assert.ok(!text.includes('example.invalid') && !text.includes('sample-client'), 'no remote URL in the result');
  assert.ok(!JSON.stringify(events).includes('invalid'), 'no remote URL in the events');
  assert.deepEqual(r.apps, []);
  assert.ok(r.notes.some((n) => /not looked up/.test(n)));
  assert.deepEqual(r.settings.map((s) => s.app), KNOWN_SETTINGS.map((s) => s.app));
  assert.deepEqual(await readdir(d), before, 'discover writes nothing');
  assert.ok(events.some((e) => e.type === 'phase' && e.name === 'discover'));
  assert.ok(events.some((e) => e.type === 'done'));
});

test('discover marks a client remote and a client folder with the client rules', async (t) => {
  const d = await tree(t);
  const rules = parseRules({ clientRemotePatterns: ['sample-client\\.invalid'], clientRoots: [w.join(d, 'docs')] });
  const r = await discover({ roots: [d], rules, appLookup: false });
  const by = Object.fromEntries(r.found.map((f) => [w.relative(d, f.path), f]));
  assert.equal(by['work\\web'].client, true);
  assert.match(by['work\\web'].note, /client, has remote/);
  assert.equal(by.tools.client, false);
  assert.equal(by.docs.client, true);
  assert.match(by.docs.note, /Accenture OneDrive only/);
  assert.ok(!JSON.stringify(r).includes('sample-client.invalid/app'));
});

test('suggestMode and findNote follow the kind of find', () => {
  const base = { path: 'C:\\x', parent: null, mode: '', note: '' };
  assert.equal(suggestMode({ kind: 'repo', remote: true, client: false, secret: null }), 'clone again + bundle/dirty');
  assert.equal(suggestMode({ kind: 'repo', remote: false, client: false, secret: null }), 'copy whole');
  assert.equal(suggestMode({ kind: 'folder', remote: false, client: false, secret: 'keys' }), 'by hand');
  assert.match(findNote({ ...base, kind: 'repo', remote: false, client: true, secret: null }), /client part, Accenture OneDrive only/);
  assert.match(findNote({ ...base, kind: 'folder', remote: false, client: false, secret: 'keys or tokens folder' }), /by-hand list/);
});

test('parseWingetExport keeps the winget source only, once per id, sorted', () => {
  const apps = parseWingetExport({
    Sources: [
      { SourceDetails: { Name: 'winget' }, Packages: [{ PackageIdentifier: 'Mozilla.Firefox' }, { PackageIdentifier: 'Git.Git' }, { PackageIdentifier: 'git.git' }, { PackageIdentifier: ' ' }] },
      { SourceDetails: { Name: 'msstore' }, Packages: [{ PackageIdentifier: '9NBLGGH4NNS1' }] },
    ],
  });
  assert.deepEqual(apps, [
    { name: 'Git.Git', wingetId: 'Git.Git', source: 'winget' },
    { name: 'Mozilla.Firefox', wingetId: 'Mozilla.Firefox', source: 'winget' },
  ]);
  assert.deepEqual(parseWingetExport(null), []);
  assert.deepEqual(parseWingetExport({ Sources: [{ Packages: [{ PackageIdentifier: 'A.B' }] }] }), [{ name: 'A.B', wingetId: 'A.B', source: 'winget' }]);
});
