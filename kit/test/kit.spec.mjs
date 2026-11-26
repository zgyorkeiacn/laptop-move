import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, stepTimeout } from '../kit.mjs';
import { appBrowser } from '../lib/env.mjs';

test('the page window: Chrome first, else Edge, else none (the default browser)', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\U\\Local' };
  const chrome = 'C:\\U\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const edge = 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(appBrowser(env, (f) => f === chrome || f === edge), chrome);
  assert.equal(appBrowser(env, (f) => f === edge), edge);
  assert.equal(appBrowser(env, () => false), null);
  assert.deepEqual(parseArgs(['ui', '--no-app']).opts, { 'no-app': true });
});

test('restore takes a step limit in minutes and can leave the dashboard window closed', () => {
  const a = parseArgs(['restore', '--from', 'C:\\b', '--step-timeout', '45', '--no-dashboard']);
  assert.deepEqual(a.opts, { from: 'C:\\b', 'step-timeout': '45', 'no-dashboard': true });
  assert.equal(stepTimeout('45'), 45 * 60 * 1000);
  assert.equal(stepTimeout(undefined), undefined);
  assert.throws(() => stepTimeout('0'), /1 to 1440/);
  assert.throws(() => stepTimeout('soon'), /takes minutes/);
  assert.equal(parseArgs(['dashboard', '--work', 'C:\\w']).command, 'dashboard');
});

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
