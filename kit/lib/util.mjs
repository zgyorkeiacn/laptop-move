// Small shared helpers: running commands (no shell unless a .cmd needs cmd.exe), sizes, slugs, logging.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Runs a program and captures its output. Never goes through a shell.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number, verbatim?: boolean, input?: string}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string, error?: string}>}
 */
export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        windowsVerbatimArguments: !!opts.verbatim,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', error: String(/** @type {Error} */ (e).message) });
      return;
    }
    const timer = opts.timeout ? setTimeout(() => child.kill(), opts.timeout) : null;
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr, error: e.message }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    if (opts.input !== undefined) child.stdin?.end(opts.input); else child.stdin?.end();
  });
}

/**
 * Runs a program on the user's own console (it may ask its own questions, e.g. 7-Zip's password or an installer).
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, verbatim?: boolean}} [opts]
 * @returns {Promise<number>}
 */
export function runInherit(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: 'inherit', windowsVerbatimArguments: !!opts.verbatim });
    } catch {
      resolve(-1);
      return;
    }
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
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
