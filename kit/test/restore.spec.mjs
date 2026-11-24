import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveTree, checkParts, loadManifest, defaultFrom, unitSkipper } from '../lib/restore.mjs';
import { archiveRel } from '../lib/paths.mjs';
import { sha256File } from '../lib/util.mjs';

const w = path.win32;

/** @param {import('node:test').TestContext} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('moveTree: a missing folder moves whole; an existing file is kept and listed as a conflict', async (t) => {
  const d = await scratch(t, 'move');
  const src = w.join(d, 'src');
  const dest = w.join(d, 'dest');
  await mkdir(w.join(src, 'a', 'b'), { recursive: true });
  await writeFile(w.join(src, 'a', 'b', 'new.txt'), 'new');
  await writeFile(w.join(src, 'a', 'same.txt'), 'from the old laptop');
  await mkdir(w.join(dest, 'a'), { recursive: true });
  await writeFile(w.join(dest, 'a', 'same.txt'), 'already here');

  const acc = await moveTree(src, dest, { backupDir: w.join(d, 'replaced') });
  assert.equal(await readFile(w.join(dest, 'a', 'b', 'new.txt'), 'utf8'), 'new');
  assert.equal(await readFile(w.join(dest, 'a', 'same.txt'), 'utf8'), 'already here', 'never replaced without overwrite');
  assert.deepEqual(acc.conflicts, [w.join(dest, 'a', 'same.txt')]);
  assert.equal(acc.replaced, 0);
  assert.deepEqual(acc.errors, []);
});

test('moveTree with overwrite: the replaced file is backed up first', async (t) => {
  const d = await scratch(t, 'over');
  const src = w.join(d, 'src');
  const dest = w.join(d, 'dest');
  const backupDir = w.join(d, 'replaced');
  await mkdir(src, { recursive: true });
  await mkdir(dest, { recursive: true });
  await writeFile(w.join(src, 'settings.json'), '{"new":true}');
  await writeFile(w.join(dest, 'settings.json'), '{"old":true}');

  const acc = await moveTree(src, dest, { overwrite: true, backupDir });
  assert.equal(await readFile(w.join(dest, 'settings.json'), 'utf8'), '{"new":true}');
  const { drive, rel } = archiveRel(w.join(dest, 'settings.json'));
  assert.equal(await readFile(w.join(backupDir, drive, rel), 'utf8'), '{"old":true}');
  assert.equal(acc.replaced, 1);
  assert.equal(acc.conflicts.length, 0);
});

test('moveTree: loose takes only the files, skip leaves paths alone', async (t) => {
  const d = await scratch(t, 'loose');
  const src = w.join(d, 'src');
  const dest = w.join(d, 'dest');
  await mkdir(w.join(src, 'sub'), { recursive: true });
  await mkdir(w.join(src, 'repo'), { recursive: true });
  await writeFile(w.join(src, '.gitconfig'), '[user]');
  await writeFile(w.join(src, 'sub', 'x.txt'), 'x');
  await writeFile(w.join(src, 'repo', 'dirty.txt'), 'x');

  await moveTree(src, dest, { loose: true, backupDir: w.join(d, 'r') });
  assert.equal(existsSync(w.join(dest, '.gitconfig')), true);
  assert.equal(existsSync(w.join(dest, 'sub')), false);

  const dest2 = w.join(d, 'dest2');
  const skipDir = w.join(src, 'repo');
  await moveTree(src, dest2, { backupDir: w.join(d, 'r'), skip: (p) => p.toLowerCase() === skipDir.toLowerCase(), skipInside: (p) => skipDir.toLowerCase().startsWith(p.toLowerCase()) });
  assert.equal(existsSync(w.join(dest2, 'sub', 'x.txt')), true);
  assert.equal(existsSync(w.join(dest2, 'repo')), false);
  assert.equal(existsSync(w.join(src, 'repo', 'dirty.txt')), true, 'the skipped folder stays in the unpacked tree');
});

test('checkParts: ok, missing, damaged by size, damaged by hash, client skipped', async (t) => {
  const d = await scratch(t, 'parts');
  await writeFile(w.join(d, 'data-C.7z.001'), 'part one');
  await writeFile(w.join(d, 'data-C.7z.002'), 'part two');
  const sum1 = await sha256File(w.join(d, 'data-C.7z.001'));
  const sum2 = await sha256File(w.join(d, 'data-C.7z.002'));
  const manifest = {
    archives: [
      { name: 'data-C', group: 'data', parts: [{ file: 'data-C.7z.001', size: 8, sha256: sum1 }, { file: 'data-C.7z.002', size: 8, sha256: sum2 }] },
      { name: 'client-C', group: 'client', parts: [{ file: 'client-C.7z.001', size: 5, sha256: 'x' }] },
    ],
  };
  const ok = await checkParts(manifest, d, { hash: true });
  assert.equal(ok.archives[0].status, 'ok');
  assert.equal(ok.archives[1].status, 'missing');
  assert.deepEqual(ok.rows.map((r) => r.status), ['ok', 'ok', 'missing']);

  const skipped = await checkParts(manifest, d, { skipClient: true });
  assert.equal(skipped.archives[1].status, 'skipped');

  await writeFile(w.join(d, 'data-C.7z.002'), 'part 2!!');
  const badHash = await checkParts(manifest, d, { hash: true });
  assert.equal(badHash.archives[0].status, 'damaged');
  assert.match(badHash.rows[1].detail, /SHA-256 differs/);
  const sizeOnly = await checkParts(manifest, d, {});
  assert.equal(sizeOnly.archives[0].status, 'ok', 'without hash only the sizes are checked');

  await writeFile(w.join(d, 'data-C.7z.001'), 'short');
  const badSize = await checkParts(manifest, d, {});
  assert.equal(badSize.archives[0].status, 'damaged');
  assert.match(badSize.rows[0].detail, /download it again/);
});

test('loadManifest and defaultFrom', async (t) => {
  const d = await scratch(t, 'man');
  const kit = w.join(d, 'laptop-move-kit');
  await mkdir(kit);
  await assert.rejects(loadManifest(kit, d), /manifest\.json not found/);
  await writeFile(w.join(kit, 'manifest.json'), JSON.stringify({ kind: 'something else' }));
  await assert.rejects(loadManifest(kit, d), /not a laptop move manifest/);
  await writeFile(w.join(kit, 'manifest.json'), JSON.stringify({ kind: 'laptop-move', archives: [] }));
  assert.equal((await loadManifest(kit, d)).manifest.kind, 'laptop-move');
  assert.equal(defaultFrom(kit), kit, 'no SHA256SUMS.txt anywhere: the kit folder');
  await writeFile(w.join(d, 'SHA256SUMS.txt'), '');
  assert.equal(defaultFrom(kit), d, 'the parts next to the unpacked kit folder');
});

test('unitSkipper: a unit picked below a cloned repository is put back, the repository itself and its other folders stay', () => {
  const repoDir = 'C:\\x\\unp\\C\\git\\orch';
  const out = `${repoDir}\\out`;
  const skipped = unitSkipper([repoDir], [out]);
  assert.equal(skipped(`${repoDir}\\src\\a.ts`), true, 'the repository tree is left to the clone and its dirty overlay');
  assert.equal(skipped(`${repoDir}\\outer`), true, 'a sibling whose name starts the same is not the unit');
  assert.equal(skipped(out), false, 'the unit folder itself');
  assert.equal(skipped(`${out}\\cli\\aao.cjs`), false, 'and what lies in it');
  assert.equal(unitSkipper([repoDir], [])(`${out}\\cli\\aao.cjs`), true, 'without the keep it is skipped, as before');
  assert.equal(unitSkipper([repoDir], [repoDir])(`${repoDir}\\a.txt`), true, 'a unit equal to the repository root keeps nothing');
});
