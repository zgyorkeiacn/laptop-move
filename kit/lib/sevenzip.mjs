// 7-Zip: only the installed one in Program Files, version 26.03 or newer, checked before every use.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from './util.mjs';

export const MIN_VERSION = { major: 26, minor: 3 };

/** The only 7-Zip the kit uses. */
export function sevenZipPath() {
  return path.win32.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe');
}

/**
 * Reads the version from 7-Zip's banner ("7-Zip 26.03 (x64) : Copyright ..."). Null when there is none.
 * @param {string} text
 * @returns {{major: number, minor: number, text: string}|null}
 */
export function parseVersion(text) {
  const m = /7-Zip(?: \(a\)| \(r\))?(?: \[\d+\])? (\d+)\.(\d+)/.exec(String(text));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), text: `${m[1]}.${m[2]}` };
}

/** @param {{major: number, minor: number}|null} v */
export function versionOk(v) {
  if (!v) return false;
  return v.major > MIN_VERSION.major || (v.major === MIN_VERSION.major && v.minor >= MIN_VERSION.minor);
}

/**
 * Checks the installed 7-Zip.
 * @param {string} [exe]
 * @returns {Promise<{ok: boolean, exe: string, version: string|null, why?: string}>}
 */
export async function check7z(exe = sevenZipPath()) {
  if (!existsSync(exe)) return { ok: false, exe, version: null, why: `7-Zip is not installed at ${exe}` };
  const r = await run(exe, ['i'], { timeout: 30000 });
  const v = parseVersion(r.stdout.split(/\r?\n/).slice(0, 5).join('\n'));
  if (!v) return { ok: false, exe, version: null, why: 'cannot read the 7-Zip version' };
  if (!versionOk(v)) return { ok: false, exe, version: v.text, why: `7-Zip ${v.text} is older than 26.03` };
  return { ok: true, exe, version: v.text };
}

/**
 * Arguments to add the files of a list file to a split archive. With encrypt, -p has no value: 7-Zip asks for the
 * password on the console, so it is never on a command line, in a file or in the kit's memory.
 * @param {{archive: string, listFile: string, volumeBytes: number, encrypt: boolean, level?: number}} o
 */
export function addArgs(o) {
  const mb = Math.max(1, Math.floor(o.volumeBytes / (1024 * 1024)));
  return [
    'a', '-t7z', o.archive, `@${o.listFile}`, '-scsUTF-8', `-mx${o.level ?? 3}`, '-mmt=on', `-v${mb}m`, '-ssw', '-spd', '-bb0', '-bsp1',
    ...(o.encrypt ? ['-p', '-mhe=on'] : []),
  ];
}

/**
 * Arguments to unpack a split archive (its first part) into a folder. An encrypted archive makes 7-Zip ask for the password.
 * @param {string} firstPart
 * @param {string} outDir
 */
export function extractArgs(firstPart, outDir) {
  return ['x', firstPart, `-o${outDir}`, '-aoa', '-bb0', '-bsp1'];
}

/**
 * Runs 7-Zip with its output piped (no console needed), for the user interface. An encrypted archive's password goes
 * to 7-Zip's own prompt through standard input: it is never an argument, never in a file and never in the returned
 * output (scrubbed if 7-Zip ever echoed it). Arguments that carry a password (-pSECRET) are refused.
 * @param {string} exe
 * @param {string[]} args
 * @param {{cwd?: string, password?: string, confirm?: boolean, onPercent?: (pct: number) => void, timeout?: number}} [o]
 * @returns {Promise<{code: number, out: string}>}
 */
export function run7z(exe, args, o = {}) {
  if (args.some((a) => /^-p./.test(String(a)))) return Promise.reject(new Error('run7z: a password is never passed as an argument'));
  const pw = o.password ?? '';
  if (/[\r\n]/.test(pw)) return Promise.reject(new Error('run7z: the password cannot hold a line break'));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    let last = -1;
    const keep = (/** @type {Buffer} */ chunk) => {
      const s = chunk.toString('utf8');
      tail = (tail + s).slice(-16384);
      if (o.onPercent) {
        const all = [...s.replaceAll('\b', ' ').matchAll(/(\d{1,3})%/g)];
        const p = all.length ? Number(all[all.length - 1][1]) : -1;
        if (p >= 0 && p <= 100 && p !== last) { last = p; o.onPercent(p); }
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timer = null;
    if (o.timeout) timer = setTimeout(() => child.kill(), o.timeout);
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      let out = tail.replaceAll('\b', '');
      if (pw) out = out.split(pw).join('***');
      resolve({ code: code ?? 255, out: out.slice(-8192) });
    });
    child.stdin.on('error', () => {});
    // 7-Zip reads the password once from a pipe; a second line (the confirmation a console would ask for) is harmless.
    child.stdin.end(pw ? (o.confirm ? `${pw}\n${pw}\n` : `${pw}\n`) : '');
  });
}

/** The shortest password the user interface takes. */
export const MIN_PASSWORD = 12;

/**
 * Why a typed password is not taken, or null. Printable ASCII only, so the same keys give the same bytes on the new
 * laptop whatever its keyboard layout or console code page; at least MIN_PASSWORD characters; no line break (the
 * pipe would cut it). The text never contains the password.
 * @param {unknown} pw
 */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || !pw.length) return 'type a password';
  if (/[\r\n]/.test(pw)) return 'the password may not hold a line break';
  if (!/^[\x20-\x7E]+$/.test(pw)) return 'use only letters, digits, spaces and the signs of a US keyboard (no accented letters)';
  if (pw.length < MIN_PASSWORD) return `use at least ${MIN_PASSWORD} characters (a passphrase of three or four words is easy to type)`;
  return null;
}

/** The last few non-empty lines of 7-Zip's output, for an error message. @param {string} out @param {number} [n] */
export function lastLines(out, n = 4) {
  return String(out).split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l && !/^\d{1,3}%/.test(l)).slice(-n).join(' | ');
}

/** Meaning of 7-Zip's exit code. @param {number} code */
export function exitMeaning(code) {
  return ({ 0: 'ok', 1: 'warning (some files were locked or changed: see the lines above)', 2: 'fatal error', 7: 'command line error', 8: 'not enough memory', 255: 'stopped by the user' })[code] ?? `exit code ${code}`;
}
