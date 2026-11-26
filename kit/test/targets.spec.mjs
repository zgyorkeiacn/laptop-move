// The final folders are made before restore clones or moves anything into them: which folders, the PowerShell script
// that makes them, and the administrator run for the ones the user may not make. Sample paths and scratch folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { targetFolders, prepareFolders, canWrite, PREPARE_SCRIPT } from '../lib/targets.mjs';

const w = path.win32;
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('targetFolders: the parents of what restore puts back, an own folder at the drive root, never the root itself', () => {
  const got = targetFolders({
    repos: [{ path: 'C:\\git_personal\\cv' }, { path: 'C:\\work\\wt', worktreeOf: 'C:\\work\\main' }, { path: 'C:\\toprepo' }],
    units: [
      { path: 'C:\\temp', kind: 'folder' },
      { path: 'C:\\Users\\old\\AppData\\Roaming\\Code\\User', kind: 'setting' },
      { path: 'C:\\Users\\old', kind: 'loose' },
      { path: 'C:\\git_accenture\\notes.txt', kind: 'file' },
    ],
    links: [{ path: 'C:\\newgit\\link', target: 'C:\\x', dir: true }, { path: 'C:\\rootlink', target: 'C:\\x', dir: true }],
  }, { oldProfile: 'C:\\Users\\old', newProfile: 'C:\\Users\\new' });
  assert.deepEqual(got, [
    'C:\\git_accenture', 'C:\\git_personal', 'C:\\newgit', 'C:\\temp', 'C:\\toprepo',
    'C:\\Users\\new', 'C:\\Users\\new\\AppData\\Roaming\\Code', 'C:\\work',
  ]);
  assert.ok(!got.includes('C:\\rootlink'), 'a link at the drive root gets no folder (mklink needs the path free)');
  const trial = targetFolders({ repos: [{ path: 'C:\\toprepo' }], units: [], links: [] }, { targetRoot: 'D:\\trial' });
  assert.deepEqual(trial, ['D:\\trial\\C'], 'in a trial everything is below the trial folder');
});

test('prepareFolders makes the folders with the PowerShell script, odd names too, and checks it can write into them', async (t) => {
  const d = await scratch(t, 'prep');
  const work = w.join(d, 'work');
  await mkdir(w.join(d, 'there'));
  const folders = [w.join(d, 'a', 'deep', 'one'), w.join(d, 'with space', 'x[1]'), w.join(d, 'EAC%20Single%20CICD'), w.join(d, 'there')];
  /** @type {any[]} */ const events = [];
  const r = await prepareFolders(folders, { work, emit: (e) => events.push(e) });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.rows.map((x) => x.status), ['created', 'created', 'created', 'ready']);
  for (const f of folders) assert.ok(existsSync(f), f);
  assert.equal(await readFile(r.script, 'utf8'), PREPARE_SCRIPT, 'the script is in the work folder, to read or run by hand');
  const said = JSON.parse((await readFile(w.join(work, 'prepare-folders-result.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(said.length, 4, 'the script itself made them (not the node fallback)');
  assert.deepEqual(said.map((/** @type {any} */ x) => x.created), [true, true, true, false]);
  assert.ok(!events.some((e) => e.type === 'warn'), JSON.stringify(events));
});

test('prepareFolders runs the script as administrator only for the folders it cannot write to', async (t) => {
  const d = await scratch(t, 'admin');
  const work = w.join(d, 'work');
  const fine = w.join(d, 'fine');
  const locked = w.join(d, 'locked');
  // A file where the folder should be: the user's run cannot make that folder (as a folder without rights would be).
  await writeFile(locked, 'in the way');
  /** @type {any[]} */ const runs = [];
  const r = await prepareFolders([fine, locked], {
    work,
    emit: () => {},
    runScript: async (o) => {
      runs.push({ admin: o.admin, folders: JSON.parse(await readFile(o.list, 'utf8')).folders });
      if (o.admin) { await unlink(locked); await mkdir(locked); }
      return { code: 0 };
    },
  });
  assert.deepEqual(runs.map((x) => x.admin), [false, true]);
  assert.deepEqual(runs[1].folders, [locked], 'the administrator run gets only the folder that failed');
  assert.deepEqual(r.rows.map((x) => [x.name, x.status]), [[fine, 'created'], [locked, 'made writable as administrator']]);
  assert.deepEqual(r.failed, []);
  assert.ok((await canWrite(locked)).ok);
});

test('prepareFolders reports a folder still not writable after a refused administrator run, and says what to do', async (t) => {
  const d = await scratch(t, 'refused');
  const locked = w.join(d, 'locked');
  await writeFile(locked, 'in the way');
  /** @type {any[]} */ const events = [];
  const r = await prepareFolders([locked], { work: w.join(d, 'work'), emit: (e) => events.push(e), runScript: async (o) => (o.admin ? { code: 1, why: 'The operation was canceled by the user.' } : { code: 0 }) });
  assert.deepEqual(r.failed, [locked]);
  assert.equal(r.rows[0].status, 'failed');
  assert.match(r.rows[0].detail, /as administrator/);
  assert.ok(events.some((e) => e.type === 'step' && /administrator rights/.test(e.text)), 'the user is told Windows asks for permission');
  assert.ok(events.some((e) => e.type === 'warn' && /refused or the script was blocked/.test(e.text)));
});
