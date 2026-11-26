// A whole restore of a tiny packed sample (real 7-Zip, not encrypted, a trial folder): 7-Zip comes first, the target
// folders are made before anything is moved into them, and the log, the status file and the report say what happened.
// Sample data in scratch folders only; it needs 7-Zip 26.03 or newer in Program Files, like the kit itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pack } from '../lib/pack.mjs';
import { restore, unpackLimit } from '../lib/restore.mjs';
import { check7z } from '../lib/sevenzip.mjs';
import { mapPath } from '../lib/paths.mjs';

const w = path.win32;
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true, maxRetries: 3 }));
  return d;
}

test('a restore: 7-Zip first, target folders before anything moves in, then the log, the status and the report', { timeout: 300000 }, async (t) => {
  if (!(await check7z()).ok) { t.skip('7-Zip 26.03 or newer is not installed here'); return; }
  const root = await scratch(t, 'flow');
  const out = w.join(await scratch(t, 'flowout'), 'bundle');
  const trial = await scratch(t, 'flowtrial');
  const work = await scratch(t, 'flowwork');
  const kit = await scratch(t, 'flowkit');
  await mkdir(w.join(kit, 'lib'));
  await writeFile(w.join(kit, 'kit.mjs'), '// sample kit\n');
  await writeFile(w.join(kit, 'lib', 'sample.mjs'), '// sample lib\n');
  await mkdir(w.join(root, 'docs'), { recursive: true });
  await writeFile(w.join(root, 'docs', 'a.md'), 'sample text');
  await writeFile(w.join(root, 'notes.txt'), 'sample notes');

  await pack({
    selectionData: { savedAt: '2026-11-25T09:00:00Z', folders: [{ path: root, mode: 'copy whole' }], applications: [], settings: [] },
    rules: null, noClientRules: true, out, volumeBytes: 64 * 1024 * 1024, appLookup: false, extensions: false, encrypt: false, kitDir: kit,
  }, () => {});

  /** @type {any[]} */ const events = [];
  const r = await restore({ from: out, work, targetRoot: trial, skipApps: true, open: false, dashboard: false, stepTimeout: 5 * 60 * 1000, getPassword: async () => '' }, (e) => events.push(e));

  const phases = events.filter((e) => e.type === 'phase').map((e) => e.name);
  assert.deepEqual(phases, ['7zip', 'check', 'unpack', 'targets', 'repos', 'folders', 'links', 'report'], 'in this order: 7-Zip first, the folders before anything moves in');

  const dest = mapPath(w.join(root, 'docs', 'a.md'), { targetRoot: trial });
  assert.equal(await readFile(dest, 'utf8'), 'sample text', 'the file is back, below the trial folder');
  assert.deepEqual(r.results.targets.map((x) => x.status), ['created'], 'the parent of the restored folder was made first');
  assert.equal(r.results.apps[0].name, '7-Zip');
  assert.ok(existsSync(w.join(work, 'prepare-folders.ps1')), 'the folder script is in the work folder');

  const log = await readFile(w.join(work, 'restore-log.txt'), 'utf8');
  const at = (/** @type {RegExp} */ re) => log.search(re);
  assert.ok(at(/== 7-Zip first/) >= 0 && at(/== 7-Zip first/) < at(/== Unpacking/), log);
  assert.ok(at(/== Making the target folders/) > at(/== Unpacking/));
  assert.ok(at(/== Making the target folders/) < at(/== Folders, files and settings/));
  assert.match(log, /> 7z\.exe x .*\(limit \d+ min\)/, 'every command is logged with its limit');
  assert.match(log, /< exit 0, /);
  assert.match(log, /\[targets\] created: /);
  assert.match(log, /Restore finished\. Report: /);

  const st = JSON.parse(await readFile(w.join(work, 'restore-status.json'), 'utf8'));
  assert.equal(st.state, 'done');
  assert.equal(st.report, r.report);
  assert.equal(st.phases.find((/** @type {any} */ p) => p.name === 'apps').state, 'skipped');
  assert.equal(st.sections.targets.total, 1);
  assert.deepEqual(st.timedOut, []);
  assert.ok(events.some((e) => e.type === 'status' && e.status.state === 'done'), 'the page gets the last snapshot');
  assert.ok(events.some((e) => e.type === 'item' && e.section === 'units' && e.status === 'restored'));

  const report = await readFile(r.report, 'utf8');
  assert.match(report, /Target folders \(made before anything was put into them\)/);
  assert.match(report, /Timed out \(stopped and skipped\)/);
  assert.match(report, /none: every command ended within its limit/);
  assert.ok(report.includes(w.join(work, 'restore-log.txt')), 'the report names the log');
});

test('unpacking may take six times the planned rate plus 15 minutes, never less than one step', () => {
  const step = 30 * 60 * 1000;
  assert.equal(unpackLimit({ parts: [{ size: 1000 }] }, step), step);
  const big = unpackLimit({ parts: Array.from({ length: 40 }, () => ({ size: 512 * 1024 * 1024 })) }, step);
  assert.ok(big > step && big < 3 * 60 * 60 * 1000, `20 GB: ${Math.round(big / 60000)} min`);
});
