import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, versionOk, addArgs, extractArgs, exitMeaning, MIN_VERSION, sevenZipPath } from '../lib/sevenzip.mjs';

test('parseVersion reads the 7-Zip banner', () => {
  assert.deepEqual(parseVersion('\n7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-10-01\n'), { major: 26, minor: 3, text: '26.03' });
  assert.deepEqual(parseVersion('7-Zip (a) 24.09 (x64) : Copyright'), { major: 24, minor: 9, text: '24.09' });
  assert.deepEqual(parseVersion('7-Zip [64] 16.02 : Copyright'), { major: 16, minor: 2, text: '16.02' });
  assert.equal(parseVersion('p7zip Version 16.02'), null);
  assert.equal(parseVersion(''), null);
});

test('only 26.03 or newer is accepted', () => {
  assert.deepEqual(MIN_VERSION, { major: 26, minor: 3 });
  assert.equal(versionOk({ major: 26, minor: 3 }), true);
  assert.equal(versionOk({ major: 26, minor: 10 }), true);
  assert.equal(versionOk({ major: 27, minor: 0 }), true);
  assert.equal(versionOk({ major: 26, minor: 2 }), false);
  assert.equal(versionOk({ major: 25, minor: 99 }), false);
  assert.equal(versionOk(null), false);
});

test('the only 7-Zip is the one in Program Files', () => {
  assert.match(sevenZipPath(), /\\7-Zip\\7z\.exe$/i);
});

test('addArgs: split volumes, password asked on the console, headers encrypted', () => {
  const a = addArgs({ archive: 'C:\\out\\data-C.7z', listFile: 'C:\\out\\list.txt', volumeBytes: 4 * 1024 ** 3, encrypt: true });
  assert.deepEqual(a.slice(0, 4), ['a', '-t7z', 'C:\\out\\data-C.7z', '@C:\\out\\list.txt']);
  assert.ok(a.includes('-v4096m'));
  assert.ok(a.includes('-scsUTF-8'));
  assert.ok(a.includes('-mx3'));
  assert.ok(a.includes('-p'), 'a bare -p: 7-Zip asks for the password');
  assert.ok(!a.some((x) => /^-p./.test(x)), 'never a password on the command line');
  assert.ok(a.includes('-mhe=on'));
  const plain = addArgs({ archive: 'a.7z', listFile: 'l.txt', volumeBytes: 500 * 1024 ** 2, encrypt: false, level: 1 });
  assert.ok(plain.includes('-v500m'));
  assert.ok(plain.includes('-mx1'));
  assert.ok(!plain.includes('-p'));
  assert.ok(!plain.includes('-mhe=on'));
});

test('extractArgs and exit codes', () => {
  assert.deepEqual(extractArgs('C:\\in\\data-C.7z.001', 'C:\\work\\unpacked\\data-C'), ['x', 'C:\\in\\data-C.7z.001', '-oC:\\work\\unpacked\\data-C', '-aoa', '-bb0', '-bsp1']);
  assert.equal(exitMeaning(0), 'ok');
  assert.match(exitMeaning(1), /warning/);
  assert.equal(exitMeaning(2), 'fatal error');
  assert.equal(exitMeaning(42), 'exit code 42');
});
