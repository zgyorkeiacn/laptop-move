// Small shared helpers: running commands (no shell unless a .cmd needs cmd.exe), sizes, slugs, logging.
// Every command the kit starts has a time limit: when it is reached, the command and every process it started are
// stopped (taskkill /t), and the caller gets timedOut, records the step as timed out and goes on with the next one.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

/** The limit of a captured command that names none. */
export const DEFAULT_TIMEOUT = 10 * 60 * 1000;
/** The default limit of one long step of the restore (an install, a clone, a download): --step-timeout overrides it. */
export const STEP_TIMEOUT = 30 * 60 * 1000;

const TASKKILL = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

/** @typedef {{type: 'command', state: 'start'|'end', id: number, text: string, limit: number|null, code?: number, ms?: number, timedOut?: boolean}} CommandEvent */
/** @type {Set<(e: CommandEvent) => void>} */ const listeners = new Set();
let commandSeq = 0;

/**
 * Hears every command the kit starts and ends (the restore log and its dashboard). Returns the function that stops it.
 * @param {(e: CommandEvent) => void} fn
 */
export function onCommand(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** @param {CommandEvent} e */
function tell(e) {
  for (const fn of listeners) { try { fn(e); } catch { /* a listener never stops a command */ } }
}

/**
 * Tells the listeners a command starts; the returned function tells them how it ended.
 * @param {string} text what runs, as the log shows it (never a password: the kit never puts one on a command line)
 * @param {number|null|undefined} limit
 * @returns {(r: {code: number, timedOut?: boolean}) => void}
 */
export function track(text, limit) {
  const id = ++commandSeq;
  const t0 = Date.now();
  tell({ type: 'command', state: 'start', id, text, limit: limit ?? null });
  return (r) => tell({ type: 'command', state: 'end', id, text, limit: limit ?? null, code: r.code, ms: Date.now() - t0, timedOut: !!r.timedOut });
}

/** A command as the log shows it: the program's name and its arguments, cut to a readable length. @param {string} file @param {string[]} args */
export function commandText(file, args) {
  const q = (/** @type {string} */ a) => (/[\s"]/.test(a) ? `"${a}"` : a);
  const s = [path.win32.basename(file), ...args.map((a) => q(String(a)))].join(' ');
  return s.length > 400 ? `${s.slice(0, 397)}...` : s;
}

/**
 * Stops a process and every process it started (an installer that winget or cmd.exe started, git's helpers).
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  if (!child.pid) { child.kill(); return; }
  try {
    const k = spawn(TASKKILL, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
  } catch {
    child.kill();
  }
}

/** A limit in words: "30 min". @param {number} ms */
export function fmtLimit(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/**
 * Runs a program and captures its output. Never goes through a shell. A command without a timeout gets DEFAULT_TIMEOUT.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number, verbatim?: boolean, input?: string, label?: string}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string, error?: string, timedOut?: boolean}>}
 */
export function run(file, args, opts = {}) {
  const limit = opts.timeout ?? DEFAULT_TIMEOUT;
  const ended = track(opts.label ?? commandText(file, args), limit);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    const finish = (/** @type {{code: number, stdout: string, stderr: string, error?: string, timedOut?: boolean}} */ r) => { ended(r); resolve(r); };
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        windowsVerbatimArguments: !!opts.verbatim,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ code: -1, stdout: '', stderr: '', error: String(/** @type {Error} */ (e).message) });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, limit);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, stdout, stderr, error: e.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code: timedOut ? -1 : code ?? -1, stdout, stderr, timedOut }); });
    child.stdin?.on('error', () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input); else child.stdin?.end();
  });
}

/**
 * Runs a program on the user's own console (it may ask its own questions, e.g. 7-Zip's password, a sign-in or an
 * installer), within a time limit when one is given.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, verbatim?: boolean, timeout?: number, label?: string}} [opts]
 * @returns {Promise<{code: number, timedOut: boolean}>}
 */
export function runLive(file, args, opts = {}) {
  const ended = track(opts.label ?? commandText(file, args), opts.timeout);
  return new Promise((resolve) => {
    const finish = (/** @type {{code: number, timedOut: boolean}} */ r) => { ended(r); resolve(r); };
    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: 'inherit', windowsVerbatimArguments: !!opts.verbatim });
    } catch {
      finish({ code: -1, timedOut: false });
      return;
    }
    let timedOut = false;
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; killTree(child); }, opts.timeout) : null;
    child.on('error', () => { if (timer) clearTimeout(timer); finish({ code: -1, timedOut }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); finish({ code: timedOut ? -1 : code ?? -1, timedOut }); });
  });
}

/**
 * runLive without a limit, for the old laptop (7-Zip packing many GB on the console). Returns the exit code.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, verbatim?: boolean}} [opts]
 * @returns {Promise<number>}
 */
export async function runInherit(file, args, opts = {}) {
  return (await runLive(file, args, opts)).code;
}

/** @param {number} n bytes */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** @param {number} seconds */
export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  if (seconds < 60) return 'under a minute';
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

/**
 * Parses a size such as 4g, 500m, 1.5g into bytes.
 * @param {string} s
 */
export function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a size: ${s} (use for example 4g or 500m)`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/** A file-name-safe slug of a path, unique enough for a folder name. @param {string} p */
export function slug(p) {
  const base = p.replace(/^[a-z]:\\/i, '').replace(/[\\/:*?"<>|%\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const h = createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 6);
  return `${base.slice(-60)}-${h}`;
}

/** SHA-256 of a file, streamed. @param {string} file */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** SHA-512 of a file, streamed. @param {string} file */
export function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha512');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Escapes text for HTML. @param {unknown} s */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** A timestamp for folder names: 20261123-0915. @param {Date} [d] */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** A log that also keeps every line for the report. */
export class Log {
  constructor() { /** @type {string[]} */ this.lines = []; }
  /** @param {...unknown} a */
  info(...a) { const s = a.join(' '); this.lines.push(s); console.log(s); }
  /** @param {...unknown} a */
  warn(...a) { const s = `WARNING: ${a.join(' ')}`; this.lines.push(s); console.log(s); }
}
