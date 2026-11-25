// scripts/auto-select.mjs: the rules on a made-up scan result (sample paths only), and --dry writing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRules, parseArgs, shorten, BUNDLE, COPY } from '../../scripts/auto-select.mjs';

const w = path.win32;
const HOME = 'C:\\Users\\sample';
const APPDATA = 'C:\\Users\\sample\\AppData\\Roaming';
const repo = (/** @type {string} */ p, /** @type {any} */ x = {}) => ({ path: p, kind: 'repo', parent: null, remote: true, client: false, secret: null, mode: BUNDLE, note: '', worktree: false, ...x });
const FOUND = [
  repo('C:\\git_accenture\\aao-wt-merged', { worktree: true }),
  repo('C:\\git_accenture\\aao-wt-open', { worktree: true }),
  repo('C:\\git_accenture\\aao-wt-dirty', { worktree: true }),
  repo('C:\\git_accenture\\AI-Agent-Orchestrator'),
  repo('C:\\git_personal\\SmakMal'),
  repo('C:\\git_personal\\other'),
  { path: `${HOME}\\.claude`, kind: 'folder', parent: null, remote: false, client: false, secret: null, mode: 'by hand', note: '' },
];
const MERGED = { 'c:\\git_accenture\\aao-wt-merged': { merged: true, why: 'tip is in origin/master' } };
const isMerged = async (/** @type {string} */ d) => MERGED[d.toLowerCase()] ?? { merged: false, why: d.endsWith('dirty') ? 'has uncommitted or untracked changes' : 'tip is not in the remote default branch' };
const run = (/** @type {any} */ extra = {}) => applyRules({ found: FOUND, folders: [{ path: 'C:\\git_accenture\\aao-wt-merged', mode: BUNDLE }, { path: 'C:\\keep\\me', mode: COPY }], names: ['ai-agent-orchestrator', 'smakmal', 'lego-tracker'], home: HOME, appdata: APPDATA, isMerged, ...extra });

test('a merged clean worktree is unticked, unmerged and dirty ones stay ticked', async () => {
  const r = await run();
  const by = (/** @type {string} */ p) => r.folders.find((f) => f.path === p);
  assert.equal(by('C:\\git_accenture\\aao-wt-merged'), undefined);
  assert.equal(by('C:\\git_accenture\\aao-wt-open')?.mode, BUNDLE);
  assert.equal(by('C:\\git_accenture\\aao-wt-dirty')?.mode, BUNDLE);
  assert.equal(r.counts.worktreesUnticked, 1);
  assert.ok(r.decisions.some((d) => /aao-wt-merged: UNTICKED, merged/.test(d)));
  assert.ok(r.decisions.some((d) => /aao-wt-dirty: ticked.*uncommitted/.test(d)));
  assert.ok(by('C:\\keep\\me'), 'other rows are kept');
});

test('the named repositories are forced, case-insensitively; a missing name is reported', async () => {
  const r = await run();
  assert.equal(r.folders.find((f) => f.path === 'C:\\git_accenture\\AI-Agent-Orchestrator')?.mode, BUNDLE);
  assert.equal(r.folders.find((f) => f.path === 'C:\\git_personal\\SmakMal')?.mode, BUNDLE);
  assert.equal(r.folders.find((f) => /other/.test(f.path)), undefined, 'an unnamed repository is not ticked');
  assert.deepEqual(r.notFound, ['lego-tracker']);
});

test('.claude and AIxOrchestrator are copy whole, even when the scan suggested by hand', async () => {
  const r = await run();
  assert.equal(r.folders.find((f) => f.path === `${HOME}\\.claude`)?.mode, COPY);
  assert.equal(r.folders.find((f) => f.path === `${APPDATA}\\AIxOrchestrator`)?.mode, COPY);
});

test('a client repository keeps what the scan suggests', async () => {
  const r = await run({ found: [repo('C:\\git_vodafone\\SmakMal', { client: true, mode: 'by hand' })], folders: [] });
  assert.equal(r.folders.find((f) => /SmakMal/.test(f.path)), undefined);
});

test('arguments and path shortening', () => {
  assert.deepEqual(parseArgs(['--dry', '--repo', 'a', '--repo', 'b']).repos, ['a', 'b']);
  assert.throws(() => parseArgs(['--nope']));
  assert.equal(shorten(`${HOME}\\x`, HOME, APPDATA), '%USERPROFILE%\\x');
});

test('--dry prints the summary and writes nothing', async (t) => {
  const d = await mkdtemp(w.join(os.tmpdir(), 'lmk-auto-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  const home = w.join(d, 'home');
  await mkdir(w.join(home, '.claude'), { recursive: true });
  const sel = w.join(d, 'sel.json');
  const text = `${JSON.stringify({ savedAt: '2026-01-01T00:00:00Z', folders: [{ path: 'C:\\x', mode: COPY }], applications: [], settings: [], questions: [], comments: {}, commentLabels: {} }, null, 1)}\n`;
  await writeFile(sel, text);
  const script = w.resolve(import.meta.dirname, '..', '..', 'scripts', 'auto-select.mjs');
  const r = spawnSync(process.execPath, [script, '--dry', '--selection', sel, '--scan-root', home], {
    encoding: 'utf8', env: { ...process.env, USERPROFILE: home, APPDATA: w.join(home, 'AppData', 'Roaming') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim().split('\n').pop() ?? '', /^Summary: \d+ ticked, 0 worktrees unticked as merged, \d+ forced, 7 names not found.*\[dry/);
  assert.equal(await readFile(sel, 'utf8'), text);
  assert.equal((await import('node:fs/promises').then((m) => m.readdir(d))).filter((n) => n.endsWith('.bak.json')).length, 0);
  assert.ok(!existsSync(w.join(home, 'Downloads')));
});
