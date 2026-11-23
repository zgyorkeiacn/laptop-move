import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mklinkCommand, planLinks, safeForCmd } from '../lib/links.mjs';

test('mklinkCommand: a junction through cmd /c mklink /J, quoted, no shell of its own', () => {
  const c = mklinkCommand('C:\\Users\\new\\work link', 'D:\\work target', true);
  assert.equal(c.file, 'cmd.exe');
  assert.deepEqual(c.args, ['/d', '/s', '/c', '"mklink /J "C:\\Users\\new\\work link" "D:\\work target""']);
  assert.equal(c.text, 'cmd /c mklink /J "C:\\Users\\new\\work link" "D:\\work target"');
  const f = mklinkCommand('C:\\a.txt', 'C:\\b.txt', false);
  assert.equal(f.text, 'cmd /c mklink "C:\\a.txt" "C:\\b.txt"');
});

test('planLinks maps link and target paths like every other path', () => {
  const m = { oldProfile: 'C:\\Users\\old', newProfile: 'C:\\Users\\new' };
  const p = planLinks([
    { path: 'C:\\Users\\old\\proj', target: 'C:\\Users\\old\\real\\proj', dir: true },
    { path: 'C:\\work\\cur', target: '..\\versions\\v2', dir: true },
    { path: 'C:\\work\\note.lnk.txt', target: 'note.txt', dir: false },
    { path: 'C:\\work\\broken', target: '', dir: true },
  ], m);
  assert.equal(p.length, 3, 'a link without a readable target is left out');
  assert.equal(p[0].link, 'C:\\Users\\new\\proj');
  assert.equal(p[0].target, 'C:\\Users\\new\\real\\proj');
  assert.equal(p[0].cmd.text, 'cmd /c mklink /J "C:\\Users\\new\\proj" "C:\\Users\\new\\real\\proj"');
  assert.equal(p[1].target, 'C:\\versions\\v2', 'a relative junction target is resolved against the link\'s folder');
  assert.equal(p[2].target, 'note.txt', 'a relative file link stays relative');
});

test('planLinks with a target root', () => {
  const p = planLinks([{ path: 'D:\\x\\link', target: 'D:\\y', dir: true }], { targetRoot: 'C:\\scratch\\r' });
  assert.equal(p[0].link, 'C:\\scratch\\r\\D\\x\\link');
  assert.equal(p[0].target, 'C:\\scratch\\r\\D\\y');
});

test('paths cmd would misread go through node instead', () => {
  assert.equal(safeForCmd('C:\\work\\plain path'), true);
  assert.equal(safeForCmd('C:\\a&b'), false);
  assert.equal(safeForCmd('C:\\100%'), false);
  assert.equal(safeForCmd('C:\\x"y'), false);
});
