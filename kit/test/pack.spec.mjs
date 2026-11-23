import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeSum, hasClient } from '../lib/pack.mjs';
import { estimate, totals, RATES } from '../lib/plan.mjs';
import { parseSize, fmtBytes, fmtDuration } from '../lib/util.mjs';

test('nodeSum finds win-x64/node.exe in SHASUMS256.txt', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const text = `${a}  node-v24.13.1-win-x64.zip\n${b}  win-x64/node.exe\n${'c'.repeat(64)}  win-x86/node.exe\n`;
  assert.equal(nodeSum(text), 'b'.repeat(64));
  assert.equal(nodeSum(`${a}  win-x86/node.exe`), null);
});

test('hasClient: any client unit, repository, by-hand entry, link or push-first entry', () => {
  const empty = { units: [], repos: [], byHand: [], links: [], pushFirst: [] };
  assert.equal(hasClient(empty), false);
  assert.equal(hasClient({ ...empty, units: [{ group: 'data' }] }), false);
  assert.equal(hasClient({ ...empty, units: [{ group: 'mixed' }] }), true);
  assert.equal(hasClient({ ...empty, repos: [{ group: 'client' }] }), true);
  assert.equal(hasClient({ ...empty, byHand: [{ group: 'client' }] }), true);
  assert.equal(hasClient({ ...empty, links: [{ group: 'client' }] }), true);
  assert.equal(hasClient({ ...empty, pushFirst: [{}] }), true);
});

test('sizes, parts and time estimate', () => {
  assert.equal(parseSize('4g'), 4 * 1024 ** 3);
  assert.equal(parseSize('500m'), 500 * 1024 ** 2);
  assert.equal(parseSize('1.5GB'), 1.5 * 1024 ** 3);
  assert.throws(() => parseSize('lots'), /not a size/);
  const e = estimate(10 * 1024 ** 3, 4 * 1024 ** 3);
  assert.equal(e.archive, Math.round(10 * 1024 ** 3 * RATES.ratio));
  assert.equal(e.parts, 2);
  assert.equal(estimate(0, 4 * 1024 ** 3).parts, 0);
  assert.equal(estimate(1, 4 * 1024 ** 3).parts, 1);
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtDuration(30), 'under a minute');
  assert.equal(fmtDuration(600), '10 min');
  assert.equal(fmtDuration(3 * 3600), '3.0 h');
});

test('totals split data and client and count the carried uncommitted files', () => {
  const plan = {
    volumeBytes: 1024 ** 3,
    units: [
      { group: 'data', files: [{ size: 100, group: 'data' }, { size: 50, group: 'client' }] },
      { group: 'client', fast: true, bytes: 1000, files: [] },
    ],
    repos: [
      { mode: 'bundle', group: 'data', bytes: 7, dirty: { changed: [{ rel: 'a', size: 7 }] } },
      { mode: 'clone', group: 'client', bytes: 999, dirty: { changed: [] } },
    ],
  };
  const t = totals(plan);
  assert.deepEqual(t.data, { bytes: 107, files: 2 });
  assert.deepEqual(t.client, { bytes: 1050, files: 1 });
  assert.equal(t.dataEstimate.parts, 1);
});
