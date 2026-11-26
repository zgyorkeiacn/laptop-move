// Every command has a time limit: run and runLive stop a command at its limit together with every process it started,
// say so (timedOut), and tell the command listeners (the restore log and dashboard). Real processes (node itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, runLive, onCommand, DEFAULT_TIMEOUT, fmtLimit, commandText } from '../lib/util.mjs';

const NODE = process.execPath;
/** A node that starts a child node which sleeps, prints the child's pid, then sleeps itself. */
const PARENT = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>{},60000)";

/** True while a process runs. @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

/** Waits until fn is true, or fails. @param {() => boolean} fn @param {string} what */
async function until(fn, what) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail(what);
}

test('run: a command past its limit is stopped with the processes it started, and says so', async () => {
  /** @type {any[]} */ const heard = [];
  const stop = onCommand((e) => heard.push(e));
  try {
    const t0 = Date.now();
    const r = await run(NODE, ['-e', PARENT], { timeout: 1500, label: 'sleepy parent' });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, -1);
    assert.ok(Date.now() - t0 < 20000, 'it did not wait for the minute');
    const child = Number(r.stdout.trim());
    assert.ok(child > 0, `the child pid was printed: ${r.stdout}`);
    await until(() => !alive(child), 'the grandchild was stopped too');
    const start = heard.find((e) => e.state === 'start' && e.text === 'sleepy parent');
    const end = heard.find((e) => e.state === 'end' && e.id === start?.id);
    assert.equal(start?.limit, 1500);
    assert.equal(end?.timedOut, true);
  } finally { stop(); }
});

test('run: a command in time keeps its exit code; one without a limit gets the default', async () => {
  /** @type {any[]} */ const heard = [];
  const stop = onCommand((e) => heard.push(e));
  try {
    const r = await run(NODE, ['-e', 'process.exit(3)']);
    assert.equal(r.code, 3);
    assert.equal(r.timedOut, false);
    assert.equal(heard.find((e) => e.state === 'start')?.limit, DEFAULT_TIMEOUT);
    assert.equal(heard.find((e) => e.state === 'end')?.code, 3);
  } finally { stop(); }
  const after = heard.length;
  await run(NODE, ['-e', '0']);
  assert.equal(heard.length, after, 'a listener that stopped hears nothing more');
});

test('runLive: the console command is stopped at its limit, or ends with its own code', async () => {
  const late = await runLive(NODE, ['-e', 'setTimeout(()=>{},60000)'], { timeout: 1000 });
  assert.deepEqual(late, { code: -1, timedOut: true });
  const fine = await runLive(NODE, ['-e', 'process.exit(0)'], { timeout: 30000 });
  assert.deepEqual(fine, { code: 0, timedOut: false });
});

test('limits and command texts read well', () => {
  assert.equal(fmtLimit(30 * 60 * 1000), '30 min');
  assert.equal(fmtLimit(1500), '2 s');
  assert.equal(fmtLimit(30000), '30 s', 'half a minute is not rounded up to a minute');
  assert.equal(commandText('C:\\Program Files\\Git\\cmd\\git.exe', ['clone', 'https://x/y.git', 'C:\\a b']), 'git.exe clone https://x/y.git "C:\\a b"');
});
