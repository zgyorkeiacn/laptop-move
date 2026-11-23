import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../kit.mjs';

test('parseArgs: command, values, flags, --key=value', () => {
  const a = parseArgs(['pack', '--selection', 'sel.json', '--out=C:\\LaptopMove\\b', '--client-data', '--volume', '2g']);
  assert.equal(a.command, 'pack');
  assert.deepEqual(a.opts, { selection: 'sel.json', out: 'C:\\LaptopMove\\b', 'client-data': true, volume: '2g' });
  assert.equal(parseArgs([]).command, 'help');
  assert.equal(parseArgs(['RESTORE', '--dry-run']).command, 'restore');
});

test('parseArgs refuses typos and missing values', () => {
  assert.throws(() => parseArgs(['pack', '--selectoin', 'x']), /unknown option --selectoin/);
  assert.throws(() => parseArgs(['pack', '--out']), /--out needs a value/);
  assert.throws(() => parseArgs(['pack', '--out', '--fast']), /--out needs a value/);
  assert.throws(() => parseArgs(['pack', '--fast=yes']), /--fast takes no value/);
});
