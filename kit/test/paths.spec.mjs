import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, isInside, driveOf, archiveRel, mapPath, isOneDrive, outProblem, relFrom } from '../lib/paths.mjs';
import { parseRules, isClientPath, isClientRemote, emptyRules } from '../lib/rules.mjs';

test('norm and isInside', () => {
  assert.equal(norm('c:/work/x/'), 'C:\\work\\x');
  assert.equal(norm('C:\\'), 'C:\\');
  assert.equal(isInside('C:\\work\\x\\y.txt', 'c:\\WORK\\x'), true);
  assert.equal(isInside('C:\\work\\x', 'C:\\work\\x'), true);
  assert.equal(isInside('C:\\work\\xy', 'C:\\work\\x'), false);
  assert.equal(isInside('C:\\a', 'C:\\'), true);
  assert.equal(driveOf('d:\\data'), 'D');
  assert.throws(() => driveOf('relative\\path'), /not an absolute drive path/);
  assert.deepEqual(archiveRel('c:\\git\\repo\\file.txt'), { drive: 'C', rel: 'git\\repo\\file.txt' });
  assert.equal(relFrom('C:\\a', 'C:\\a\\b\\c'), 'b\\c');
});

test('mapPath: old profile to new profile, other paths unchanged', () => {
  const m = { oldProfile: 'C:\\Users\\old.name', newProfile: 'C:\\Users\\new.name' };
  assert.equal(mapPath('C:\\Users\\old.name\\.gitconfig', m), 'C:\\Users\\new.name\\.gitconfig');
  assert.equal(mapPath('c:\\users\\OLD.NAME\\AppData\\Roaming\\Code\\User', m), 'C:\\Users\\new.name\\AppData\\Roaming\\Code\\User');
  assert.equal(mapPath('C:\\Users\\old.name', m), 'C:\\Users\\new.name');
  assert.equal(mapPath('C:\\Users\\old.name2\\x', m), 'C:\\Users\\old.name2\\x', 'a sibling profile with a common prefix is not mapped');
  assert.equal(mapPath('C:\\git\\repo', m), 'C:\\git\\repo');
  assert.equal(mapPath('D:\\data', m), 'D:\\data');
});

test('mapPath: a target root re-roots every path by drive', () => {
  const m = { oldProfile: 'C:\\Users\\old', newProfile: 'C:\\Users\\new', targetRoot: 'C:\\scratch\\restored' };
  assert.equal(mapPath('C:\\Users\\old\\notes.txt', m), 'C:\\scratch\\restored\\C\\Users\\new\\notes.txt');
  assert.equal(mapPath('D:\\data\\x', m), 'C:\\scratch\\restored\\D\\data\\x');
});

test('OneDrive folders and the client output ban', () => {
  assert.equal(isOneDrive('C:\\Users\\x\\OneDrive - Some Org\\Docs'), true);
  assert.equal(isOneDrive('C:\\Users\\x\\OneDrive'), true);
  assert.equal(isOneDrive('C:\\LaptopMove\\bundle'), false);
  const rules = parseRules({ forbiddenOut: ['C:\\Users\\x\\OneDrive - Client Org'] });
  assert.match(String(outProblem('C:\\Users\\x\\OneDrive - Client Org\\move', rules, true)), /client folder/);
  assert.match(String(outProblem('C:\\Users\\x\\OneDrive - Own Org\\move', rules, false)), /synced by OneDrive/);
  assert.equal(outProblem('C:\\Users\\x\\OneDrive - Own Org\\move', rules, true), null);
  assert.equal(outProblem('C:\\LaptopMove\\bundle-1', rules), null);
  assert.match(String(outProblem('bundle', rules)), /absolute folder/);
});

test('client rules: roots, remote patterns, %VAR% expansion', () => {
  process.env.LMK_TEST_ROOT = 'C:\\clientroot';
  const r = parseRules({ clientRoots: ['%LMK_TEST_ROOT%\\'], clientRemotePatterns: ['example-client\\.visualstudio\\.com', 'dev\\.azure\\.com/example-client'] }, 'x.json');
  assert.deepEqual(r.clientRoots, ['C:\\clientroot']);
  assert.equal(isClientPath('C:\\clientroot\\repo', r), true);
  assert.equal(isClientPath('C:\\clientrootx\\repo', r), false);
  assert.equal(isClientRemote('https://dev.azure.com/example-client/p/_git/r', r), true);
  assert.equal(isClientRemote('https://github.com/me/r.git', r), false);
  assert.equal(isClientRemote(null, r), false);
  assert.equal(isClientPath('C:\\clientroot', emptyRules()), false);
});
