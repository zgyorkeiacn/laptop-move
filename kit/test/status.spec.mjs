// Where a restore stands: the status snapshot the dashboards read, the log written line by line, and the console
// dashboard drawn from a snapshot. Made-up events only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStatus, openLog, verdict, fmtSpan, RESTORE_PHASES } from '../lib/status.mjs';
import { renderDashboard, dashboardCommand } from '../lib/dashboard.mjs';
import { run } from '../lib/util.mjs';
import { TOOLS, windowsPowerShellEnv } from '../lib/env.mjs';
import { writeFile } from 'node:fs/promises';

const w = path.win32;
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** A made-up restore halfway through the repositories, one clone timed out. @param {number} t0 */
function halfway(t0) {
  let now = t0;
  const s = createStatus({ now: () => now, every: 0 });
  const at = (/** @type {number} */ ms) => { now = t0 + ms; };
  s.apply({ type: 'phase', name: '7zip', text: '7-Zip first' });
  s.apply({ type: 'item', section: 'sevenzip', name: '7-Zip', status: 'installed already', detail: '26.06' });
  at(1000); s.apply({ type: 'phase', name: 'check', text: 'Checking the parts' });
  s.setTotal('parts', 2);
  s.apply({ type: 'item', section: 'parts', name: 'data-C.7z.001', status: 'ok', detail: '' });
  s.apply({ type: 'item', section: 'parts', name: 'data-C.7z.002', status: 'ok', detail: '' });
  at(5000); s.apply({ type: 'phase', name: 'repos', text: 'Repositories' });
  s.setTotal('repos', 10);
  s.apply({ type: 'item', section: 'repos', name: 'C:\\git\\a', status: 'restored', detail: 'cloned' });
  s.apply({ type: 'item', section: 'repos', name: 'C:\\git\\b', status: 'failed', detail: 'git clone exit 128' });
  s.apply({ type: 'command', state: 'start', id: 7, text: 'git clone https://example.invalid/c.git C:\\git\\c', limit: 1800000 });
  at(65000); s.apply({ type: 'command', state: 'end', id: 7, text: 'git clone https://example.invalid/c.git C:\\git\\c', limit: 1800000, code: -1, ms: 60000, timedOut: true });
  s.apply({ type: 'item', section: 'repos', name: 'C:\\git\\c', status: 'timed out', detail: 'no answer after 30 min: stopped and skipped' });
  s.apply({ type: 'command', state: 'start', id: 8, text: 'git clone https://example.invalid/d.git C:\\git\\d', limit: 1800000 });
  s.apply({ type: 'warn', text: 'sample warning' });
  at(70000);
  return { s, at, now: () => now };
}

test('the status follows phases, items, commands and timeouts', () => {
  const t0 = Date.parse('2026-11-25T15:00:00Z');
  const { s } = halfway(t0);
  const st = s.snapshot();
  assert.equal(st.phase, 'repos');
  assert.deepEqual(st.phases.filter((/** @type {any} */ p) => p.state !== 'waiting').map((/** @type {any} */ p) => [p.name, p.state]), [['7zip', 'done'], ['check', 'done'], ['repos', 'running']]);
  assert.deepEqual(st.sections.repos, { total: 10, counts: { restored: 1, failed: 1, 'timed out': 1 } });
  assert.deepEqual(st.problems.map((/** @type {any} */ p) => p.status), ['failed', 'timed out']);
  assert.equal(st.timedOut.length, 1);
  assert.equal(st.command.id, 8, 'the command running now');
  assert.equal(st.warnings, 1);
  assert.equal(st.state, 'running');
  s.finish({ ok: true, report: 'C:\\work\\restore-report.html' });
  const end = s.snapshot();
  assert.equal(end.state, 'done');
  assert.equal(end.command, null);
  assert.equal(end.phases.find((/** @type {any} */ p) => p.name === 'repos').state, 'done');
  assert.equal(end.phases.find((/** @type {any} */ p) => p.name === 'links').state, 'skipped', 'a phase that never started is skipped');
});

test('the status file is written whole and the page gets the same snapshot', async (t) => {
  const d = await scratch(t, 'status');
  const file = w.join(d, 'restore-status.json');
  /** @type {any[]} */ const snaps = [];
  const s = createStatus({ file, every: 5, onSnapshot: (x) => snaps.push(x), meta: { log: 'L', work: d } });
  s.apply({ type: 'phase', name: '7zip', text: '7-Zip first' });
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.phase, '7zip', 'a new phase is written at once');
  assert.equal(onDisk.log, 'L');
  assert.equal(onDisk.pid, process.pid);
  for (let i = 0; i < 50; i++) s.apply({ type: 'progress', done: i, total: 50, text: 'x' });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(snaps.length < 10, `progress is sent at most once per interval (${snaps.length} snapshots)`);
  s.finish({ ok: false, error: 'stopped for the test' });
  const last = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(last.state, 'failed');
  assert.equal(last.error, 'stopped for the test');
  assert.deepEqual(snaps.at(-1), last);
});

test('the log gets one line per event, the timeout spelled out', async (t) => {
  const d = await scratch(t, 'log');
  const log = openLog(w.join(d, 'restore-log.txt'), ['head line']);
  log.event({ type: 'phase', name: 'repos', text: 'Repositories' });
  log.event({ type: 'command', state: 'start', id: 1, text: 'git clone x', limit: 1800000 });
  log.event({ type: 'command', state: 'end', id: 1, text: 'git clone x', limit: 1800000, code: -1, ms: 1800000, timedOut: true });
  log.event({ type: 'item', section: 'repos', name: 'C:\\git\\x', status: 'timed out', detail: 'no answer after 30 min' });
  log.event({ type: 'progress', done: 1, total: 2 });
  const text = await readFile(log.file, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 6, text);
  assert.match(lines[1], /^\d\d:\d\d:\d\d {2}head line$/);
  assert.match(text, /== Repositories/);
  assert.match(text, /> git clone x {3}\(limit 30 min\)/);
  assert.match(text, /< TIMED OUT after 30 min: stopped with every process it started, skipped: git clone x/);
  assert.match(text, /\[repos\] timed out: C:\\git\\x/);
});

test('verdicts and spans', () => {
  assert.equal(verdict('timed out'), 'bad');
  assert.equal(verdict('failed'), 'bad');
  assert.equal(verdict('by hand'), 'warn');
  assert.equal(verdict('installed before unpacking'), 'ok');
  assert.equal(fmtSpan(65000), '1m 05s');
  assert.equal(fmtSpan(3720000), '1h 02m');
  assert.equal(RESTORE_PHASES[0].name, '7zip', '7-Zip is the first step');
  assert.ok(RESTORE_PHASES.findIndex((p) => p.name === 'targets') < RESTORE_PHASES.findIndex((p) => p.name === 'repos'), 'the target folders come before any clone');
});

test('the dashboard window command runs: it pins the window if it can, then starts node with the status file', async (t) => {
  const d = await scratch(t, 'dashcmd');
  // A stand-in for kit.mjs: it writes down what it was started with and ends (no window: the command runs hidden here).
  const stand = w.join(d, 'stand-in.mjs');
  const said = w.join(d, 'said.json');
  await writeFile(stand, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(said)}, JSON.stringify(process.argv.slice(2)));\n`);
  const status = w.join(d, 'with space', 'restore-status.json');
  const r = await run(TOOLS.POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', dashboardCommand()], {
    env: windowsPowerShellEnv({ LM_NODE: process.execPath, LM_KIT: stand, LM_STATUS: status }), timeout: 120000,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(await readFile(said, 'utf8')), ['dashboard', '--status', status], 'the path with a space arrives whole');
});

test('the console dashboard draws a snapshot: steps, counts, now, problems', () => {
  const t0 = Date.parse('2026-11-25T15:00:00Z');
  const { s, now } = halfway(t0);
  const lines = renderDashboard(s.snapshot(), { width: 120, now: now(), color: false, alive: true });
  const text = lines.join('\n');
  assert.ok(lines.every((l) => l.length <= 120), 'no line is wider than the window');
  assert.ok(!text.includes('\x1b['), 'no colour codes when colour is off');
  assert.match(text, /LAPTOP MOVE: RESTORE/);
  assert.match(text, /restore running/);
  assert.match(text, /\u2714 7-Zip/);
  assert.match(text, /\u25b6 Clone the repositories +3\/10/);
  assert.match(text, /about \d/, 'an estimate of the time left');
  assert.match(text, /git clone https:\/\/example\.invalid\/d\.git/);
  assert.match(text, /of 30 min at most/);
  assert.match(text, /Problems \(2 failed or timed out, 1 warnings\)/);
  assert.match(text, /C:\\git\\c: timed out/);
  const gone = renderDashboard(s.snapshot(), { width: 120, now: now(), color: false, alive: false }).join('\n');
  assert.match(gone, /not running any more/, 'a restore that died is not shown as running');
  assert.match(renderDashboard(null, { color: false, file: 'C:\\x\\restore-status.json' }).join('\n'), /Waiting for the restore to start/);
  s.finish({ ok: true, report: 'C:\\work\\restore-report.html' });
  const done = renderDashboard(s.snapshot(), { width: 120, now: now(), color: false }).join('\n');
  assert.match(done, /The restore has finished\. Report: C:\\work\\restore-report\.html/);
  assert.match(done, /This window can be closed now/);
});
