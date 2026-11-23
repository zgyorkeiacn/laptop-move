import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dryRun } from '../lib/pack.mjs';

const w = path.win32;

/** @param {import('node:test').TestContext} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('dry run of a tiny sample: sizes, parts, time estimate, secrets by hand, nothing written', async (t) => {
  const root = await scratch(t, 'dry');
  const outParent = await scratch(t, 'dryout');
  const out = w.join(outParent, 'bundle');
  await mkdir(w.join(root, 'docs'), { recursive: true });
  await writeFile(w.join(root, 'docs', 'a.md'), 'a'.repeat(300));
  await writeFile(w.join(root, 'notes.txt'), 'n'.repeat(200));
  await writeFile(w.join(root, '.env'), 'X=1');
  await mkdir(w.join(root, 'node_modules', 'big'), { recursive: true });
  await writeFile(w.join(root, 'node_modules', 'big', 'index.js'), 'x'.repeat(100000));
  await mkdir(w.join(root, 'left-out'), { recursive: true });
  await writeFile(w.join(root, 'left-out', 'huge.bin'), 'h'.repeat(50000));
  const before = (await readdir(root, { recursive: true })).sort();

  /** @type {any[]} */ const events = [];
  const r = await dryRun({
    selectionData: {
      savedAt: '2026-11-23T09:00:00Z',
      folders: [{ path: root, mode: 'copy whole' }, { path: w.join(root, 'left-out'), mode: 'leave' }],
      applications: [],
      settings: [{ app: 'Some web app', how: 'sign in again' }],
    },
    rules: null,
    noClientRules: true,
    out,
    volumeBytes: 1024 * 1024 * 1024,
    appLookup: false,
    extensions: false,
  }, (e) => events.push(e));

  assert.equal(existsSync(out), false, 'the output folder is not created');
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, 'the picked folder is unchanged');
  assert.equal(r.plan.totals.data.bytes, 500, 'node_modules, the left-out folder and .env are not counted');
  assert.equal(r.plan.totals.data.files, 2);
  assert.equal(r.plan.totals.client.bytes, 0);
  assert.ok(events.some((e) => e.type === 'phase'), 'progress events are emitted');

  const text = r.text;
  assert.match(text, /^Laptop move, dry run: what pack would do\. Nothing is written, copied or changed\./);
  assert.match(text, /\nTotals\n {2}data part: 500 B in 2 files, about 375 B packed, 1 part of 1\.0 GB; packing about under a minute, upload at 10 MB\/s about under a minute, unpacking about under a minute/);
  assert.match(text, / {2}client part: empty/);
  const byHand = text.slice(text.indexOf('Move by hand (never copied)'), text.indexOf('Links and junctions'));
  assert.match(byHand, /\.env {2}\(environment file\)/);
  assert.match(text, /\(1 regenerable folders left out\)/);
  assert.match(text, /Left out by choice \(1\)\n {2}.*left-out {2}\(left out \(leave\)\)/);
  assert.match(text, /Some web app: sign in again/);
  assert.ok(text.includes(`Output folder: ${out}`));
  const notSevenZip = r.problems.filter((p) => !/7-Zip/.test(p));
  assert.deepEqual(notSevenZip, [], 'only a missing 7-Zip may stop this sample');
});

test('dry run refuses a missing rules file and an output folder inside a picked folder', async (t) => {
  const root = await scratch(t, 'dry2');
  await writeFile(w.join(root, 'a.txt'), 'a');
  const r = await dryRun({
    selectionData: { folders: [{ path: root, mode: 'copy whole' }] },
    out: w.join(root, 'bundle'),
    appLookup: false,
    extensions: false,
  });
  assert.ok(r.problems.some((p) => /no client rules file/.test(p)));
  assert.ok(r.problems.some((p) => /inside a picked folder/.test(p)));
  assert.match(r.text, /Pack would stop here:/);
  assert.equal(existsSync(w.join(root, 'bundle')), false);
});

test('fast dry run takes the sizes from an inventory', async (t) => {
  const d = await scratch(t, 'fast');
  const inv = w.join(d, 'inventory.json');
  await writeFile(inv, JSON.stringify({ folders: [{ path: 'C:\\nowhere\\big', sizeMB: 2048 }] }));
  const r = await dryRun({
    selectionData: { folders: [{ path: 'C:\\nowhere\\big', mode: 'copy whole' }] },
    rules: null,
    noClientRules: true,
    out: w.join(d, 'bundle'),
    fast: true,
    inventory: inv,
    volumeBytes: 1024 * 1024 * 1024,
  });
  assert.equal(r.plan.totals.data.bytes, 2048 * 1024 * 1024);
  assert.equal(r.plan.totals.dataEstimate.parts, 2);
  assert.match(r.text, /Fast mode/);
  assert.match(r.text, /--fast: a real pack walks every folder/);
});
