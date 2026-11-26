// The restore dashboard in a console window of its own: it reads <work>\restore-status.json once a second and draws
// where the restore stands. It is read only: closing it (Ctrl+C or the window's X) never stops the restore.
// The restore opens it by itself (restore --no-dashboard leaves it closed); `kit.mjs dashboard` opens it again.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TOOLS, windowsPowerShellEnv } from './env.mjs';
import { RESTORE_PHASES, verdict, clock, fmtSpan } from './status.mjs';
import { fmtLimit } from './util.mjs';

const w = path.win32;
const E = '\x1b[';

/** @param {boolean} on */
function palette(on) {
  const f = (/** @type {string} */ code) => (on ? (/** @type {string} */ t) => `${E}${code}m${t}${E}0m` : (/** @type {string} */ t) => t);
  return { dim: f('2'), bold: f('1'), green: f('32'), yellow: f('33'), red: f('31'), cyan: f('36'), inv: f('7') };
}

/** Text without colour codes. @param {string} t */
const plain = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Cuts a line to n visible characters. @param {string} t @param {number} n */
function fit(t, n) {
  const p = plain(t);
  if (p.length <= n) return t;
  return `${p.slice(0, Math.max(0, n - 3))}...`;
}

/** Pads a coloured text to n visible characters. @param {string} t @param {number} n */
function pad(t, n) {
  const len = plain(t).length;
  return len >= n ? t : t + ' '.repeat(n - len);
}

/** A bar of width characters. @param {number} done @param {number} total @param {number} width @param {ReturnType<typeof palette>} c */
function bar(done, total, width, c) {
  const f = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const full = Math.round(f * width);
  return `${c.green('█'.repeat(full))}${c.dim('░'.repeat(width - full))} ${String(Math.round(f * 100)).padStart(3)}%`;
}

/** The counts of a section in words. @param {Record<string, number>} counts @param {ReturnType<typeof palette>} c */
function countText(counts, c) {
  const n = { ok: 0, warn: 0, bad: 0 };
  /** @type {string[]} */ const bad = [];
  for (const [k, v] of Object.entries(counts)) {
    const x = verdict(k);
    n[x] += v;
    if (x === 'bad') bad.push(`${v} ${k}`);
  }
  const parts = [c.green(`${n.ok} ok`)];
  if (n.warn) parts.push(c.yellow(`${n.warn} to check`));
  if (bad.length) parts.push(c.red(bad.join(', ')));
  return parts.join(' · ');
}

/** The mark of a result. @param {string} status @param {ReturnType<typeof palette>} c */
function markOf(status, c) {
  const v = verdict(status);
  return v === 'ok' ? c.green('✔') : v === 'warn' ? c.yellow('!') : c.red('✖');
}

/**
 * The dashboard's lines for one status snapshot.
 * @param {any} st the snapshot (null while the restore has not written one yet)
 * @param {{width?: number, now?: number, color?: boolean, alive?: boolean|null, file?: string}} [o]
 * @returns {string[]}
 */
export function renderDashboard(st, o = {}) {
  const W = Math.max(60, o.width ?? 100);
  const now = o.now ?? Date.now();
  const c = palette(o.color !== false);
  const out = [];
  const title = ' LAPTOP MOVE: RESTORE';
  out.push(c.inv(pad(`${title}${' '.repeat(Math.max(1, W - title.length - 10))}${clock(now)} `, W)));
  if (!st) {
    out.push('', c.yellow(`  Waiting for the restore to start${o.file ? ` (${o.file})` : ''}.`));
    return out;
  }
  const end = st.finishedAt ?? now;
  const quiet = now - (st.updatedAt ?? now);
  let state;
  if (st.state === 'done') state = c.green('restore finished');
  else if (st.state === 'failed') state = c.red(`restore stopped: ${st.error ?? 'see the log'}`);
  else if (o.alive === false) state = c.red('the restore is not running any more (stopped or closed): see the log');
  else state = c.green('restore running');
  out.push(`  started ${clock(st.startedAt)} · elapsed ${c.bold(fmtSpan(end - st.startedAt))} · ${state}${st.state === 'running' && quiet > 120000 ? c.yellow(` · no news for ${fmtSpan(quiet)}`) : ''}`);
  if (st.log) out.push(c.dim(`  log: ${st.log}`));
  if (st.target) out.push(c.dim(`  trial: everything goes below ${st.target}`));
  out.push('');

  out.push(c.bold(' Steps'));
  const phases = st.phases ?? RESTORE_PHASES.map((p) => ({ ...p, state: 'waiting' }));
  for (const p of phases) {
    const sec = p.section ? st.sections?.[p.section] : null;
    const counts = sec?.counts ?? {};
    const done = Object.values(counts).reduce((a, b) => a + Number(b), 0);
    const total = sec?.total ?? null;
    let mark;
    let label;
    if (p.state === 'done') { mark = c.green('✔'); label = p.label; }
    else if (p.state === 'running') { mark = c.cyan('▶'); label = c.bold(c.cyan(p.label)); }
    else if (p.state === 'failed') { mark = c.red('✖'); label = c.red(p.label); }
    else { mark = c.dim('·'); label = c.dim(p.label); }
    let extra = '';
    if (p.state === 'skipped') extra = c.dim('skipped');
    else if (total && (p.state === 'running' || p.state === 'done' || p.state === 'failed')) {
      let eta = '';
      if (p.state === 'running' && done >= 3 && done < total && p.startedAt) eta = c.dim(`  about ${fmtSpan((now - p.startedAt) / done * (total - done))} left`);
      extra = `${String(done).padStart(4)}/${String(total).padEnd(4)} ${bar(done, total, 18, c)}  ${countText(counts, c)}${eta}`;
    } else if (done) extra = countText(counts, c);
    else if (total && p.state === 'waiting') extra = c.dim(`${total} to do`);
    else if (p.state === 'running' && st.progress?.total) extra = bar(st.progress.done, st.progress.total, 18, c);
    const took = p.startedAt && (p.state === 'done' || p.state === 'failed') && p.endedAt ? c.dim(`  ${fmtSpan(p.endedAt - p.startedAt)}`) : '';
    out.push(fit(`  ${mark} ${pad(label, 30)} ${extra}${took}`, W));
  }
  out.push('');

  out.push(c.bold(' Now'));
  if (st.state !== 'running') {
    out.push(st.state === 'done' ? `  ${c.green('The restore has finished.')}${st.report ? ` Report: ${st.report}` : ''}` : `  ${c.red('The restore stopped.')} ${st.error ?? ''}`);
    out.push(c.dim('  This window can be closed now.'));
  } else {
    if (st.command) {
      const ran = now - st.command.startedAt;
      const limit = st.command.limit ? ` of ${fmtLimit(st.command.limit)} at most` : '';
      out.push(fit(`  ${c.cyan(st.command.text)}`, W));
      const late = st.command.limit && ran > st.command.limit * 0.75;
      out.push(`  ${late ? c.yellow(`running ${fmtSpan(ran)}${limit}`) : c.dim(`running ${fmtSpan(ran)}${limit}`)}`);
    }
    if (st.progress?.text) out.push(fit(`  ${c.dim(st.progress.total ? `[${st.progress.done}/${st.progress.total}] ${st.progress.text}` : st.progress.text)}`, W));
    if (st.step) out.push(fit(`  ${st.step}`, W));
    if (!st.command && !st.progress && !st.step) out.push(c.dim('  starting'));
  }
  out.push('');

  out.push(c.bold(' Recent'));
  const recent = (st.recent ?? []).slice(-6);
  if (!recent.length) out.push(c.dim('  nothing finished yet'));
  for (const r of recent) out.push(fit(`  ${markOf(r.status, c)} ${pad(c.dim(r.section), 11)} ${r.name}${verdict(r.status) === 'ok' ? '' : `  ${r.status}`}`, W));
  out.push('');

  const problems = st.problems ?? [];
  const timed = st.timedOut ?? [];
  out.push(c.bold(` Problems (${problems.length} failed or timed out${st.warnings ? `, ${st.warnings} warnings` : ''})`));
  if (!problems.length && !timed.length) out.push(c.dim('  none so far'));
  for (const p of problems.slice(-8)) out.push(fit(`  ${c.red('✖')} ${pad(c.dim(p.section), 11)} ${p.name}: ${p.status}${p.detail ? c.dim(`  ${p.detail}`) : ''}`, W));
  if (problems.length > 8) out.push(c.dim(`  ... and ${problems.length - 8} more in the log and the report`));
  const extraTimed = timed.filter((x) => !problems.some((p) => p.status === 'timed out' && Math.abs(p.at - x.at) < 5000));
  for (const x of extraTimed.slice(-3)) out.push(fit(`  ${c.red('✖')} timed out after ${fmtLimit(x.limit ?? 0)} and skipped: ${x.text}`, W));
  out.push('');
  out.push(c.dim(`  read only, refreshed every second · closing this window never stops the restore`));
  return out;
}

/** True when a process runs. @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

/**
 * Draws the dashboard of a status file until the window is closed.
 * @param {string} file
 * @param {{every?: number}} [o]
 */
export async function watchDashboard(file, o = {}) {
  const out = process.stdout;
  const paint = (/** @type {string[]} */ lines) => {
    const W = Math.max(60, (out.columns || 100) - 1);
    out.write(`${E}?25l${E}H${lines.map((l) => `${fit(l, W)}${E}K`).join('\n')}\n${E}J`);
  };
  out.write(`${E}2J`);
  const show = () => { out.write(`${E}?25h`); };
  process.on('exit', show);
  process.once('SIGINT', () => { show(); out.write('\n'); process.exit(0); });
  out.on('resize', () => out.write(`${E}2J`));
  for (;;) {
    /** @type {any} */ let st = null;
    try { st = JSON.parse(await readFile(file, 'utf8')); } catch { /* not written yet, or being replaced */ }
    paint(renderDashboard(st, { width: (out.columns || 100) - 1, alive: st?.pid ? alive(st.pid) : null, file }));
    await new Promise((r) => setTimeout(r, o.every ?? 1000));
  }
}

/**
 * The Windows PowerShell command of the dashboard window: its title and size, on top of the other windows (where
 * Windows and the company's PowerShell rules let it; it runs anyway when they do not), then node with the dashboard.
 * The paths come from the environment (LM_NODE, LM_KIT, LM_STATUS), never inside this text.
 */
export function dashboardCommand() {
  return [
    "$host.UI.RawUI.WindowTitle = 'Laptop move: restore dashboard'",
    'try { $r = $host.UI.RawUI; $b = $r.BufferSize; $b.Width = 124; if ($b.Height -lt 42) { $b.Height = 42 }; $r.BufferSize = $b; $s = $r.WindowSize; $s.Width = 124; $s.Height = 42; $r.WindowSize = $s } catch { }',
    'try { Add-Type -Name Win -Namespace LaptopMove -MemberDefinition \'[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);\'; [void][LaptopMove.Win]::SetWindowPos([LaptopMove.Win]::GetConsoleWindow(), [System.IntPtr](-1), 0, 0, 0, 0, 0x43) } catch { }',
    '& $env:LM_NODE $env:LM_KIT dashboard --status $env:LM_STATUS',
  ].join('; ');
}

/**
 * Opens the dashboard in a new console window, on top of the others when Windows lets it.
 * @param {{kitDir: string, statusFile: string}} o
 * @returns {boolean} false when the window could not be started
 */
export function openDashboardWindow(o) {
  try {
    const child = spawn(TOOLS.POWERSHELL, ['-NoProfile', '-NoLogo', '-Command', dashboardCommand()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: windowsPowerShellEnv({ LM_NODE: process.execPath, LM_KIT: w.join(o.kitDir, 'kit.mjs'), LM_STATUS: o.statusFile }),
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
