// The password path of the user interface: the rules a typed password must meet, and 7-Zip fed through a pipe (never
// an argument). The round trip runs only where 7-Zip 26.03 or newer is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { run7z, passwordProblem, MIN_PASSWORD, addArgs, extractArgs, check7z } from '../lib/sevenzip.mjs';

const w = path.win32;
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('passwordProblem takes 12 or more printable ASCII characters and nothing else', () => {
  assert.equal(MIN_PASSWORD, 12);
  assert.match(String(passwordProblem('')), /type a password/);
  assert.match(String(passwordProblem(undefined)), /type a password/);
  assert.match(String(passwordProblem(12345678901234)), /type a password/);
  assert.match(String(passwordProblem('abcdefgh\nijklmn')), /line break/);
  assert.match(String(passwordProblem('abcdefgh\rijklmn')), /line break/);
  assert.match(String(passwordProblem('\u00e9'.repeat(13))), /accented/);
  assert.match(String(passwordProblem('a'.repeat(11))), /at least 12/);
  assert.equal(passwordProblem('a'.repeat(12)), null);
  assert.equal(passwordProblem('three blue Horses 7!'), null);
});

test('a problem text never repeats the password', () => {
  for (const pw of ['short pw', 'x\u00e9'.repeat(8), 'abcdefgh\nijklmnop']) assert.ok(!String(passwordProblem(pw)).includes(pw));
});

test('run7z refuses a password argument and a password with a line break, before starting anything', async () => {
  await assert.rejects(run7z('C:\\nowhere\\7z.exe', ['a', 'x.7z', '-pSecret123456']), /never passed as an argument/);
  await assert.rejects(run7z('C:\\nowhere\\7z.exe', ['x', 'x.7z'], { password: 'abc\ndefghijklm' }), /line break/);
});

test('addArgs asks 7-Zip for the password (a bare -p) and encrypts the names', () => {
  const a = addArgs({ archive: 'C:\\o\\data.7z', listFile: 'C:\\o\\list.txt', volumeBytes: 4 * 1024 ** 3, encrypt: true });
  assert.ok(a.includes('-p'));
  assert.ok(a.includes('-mhe=on'));
  assert.ok(!a.some((x) => /^-p./.test(x)));
  const b = addArgs({ archive: 'C:\\o\\data.7z', listFile: 'C:\\o\\list.txt', volumeBytes: 4 * 1024 ** 3, encrypt: false });
  assert.ok(!b.includes('-p'));
});

test('a piped password packs and unpacks with the installed 7-Zip; a wrong one is refused', async (t) => {
  const sz = await check7z();
  if (!sz.ok) { t.skip(`7-Zip 26.03 or newer is not installed (${sz.why})`); return; }
  const d = await scratch(t, 'pw');
  const src = w.join(d, 'src');
  const out = w.join(d, 'out');
  const bad = w.join(d, 'bad');
  for (const f of [src, out, bad]) await mkdir(f);
  await writeFile(w.join(src, 'a.txt'), 'hello from the old laptop\n');
  const list = w.join(d, 'list.txt');
  await writeFile(list, 'a.txt\n');
  const password = randomBytes(12).toString('base64url');
  const archive = w.join(d, 'data.7z');

  const packed = await run7z(sz.exe, addArgs({ archive, listFile: list, volumeBytes: 64 * 1024 * 1024, encrypt: true }), { cwd: src, password, confirm: true, timeout: 60000 });
  assert.equal(packed.code, 0, packed.out);
  assert.ok(!packed.out.includes(password));
  const parts = (await readdir(d)).filter((f) => /^data\.7z\.\d{3}$/.test(f));
  assert.deepEqual(parts, ['data.7z.001']);
  const first = w.join(d, 'data.7z.001');

  const wrong = await run7z(sz.exe, extractArgs(first, bad), { password: `${password}x`, timeout: 60000 });
  assert.equal(wrong.code, 2, wrong.out);
  assert.ok(!wrong.out.includes(password));

  const right = await run7z(sz.exe, extractArgs(first, out), { password, timeout: 60000 });
  assert.equal(right.code, 0, right.out);
  assert.ok(!right.out.includes(password));
  assert.equal(await readFile(w.join(out, 'a.txt'), 'utf8'), 'hello from the old laptop\n');
});
