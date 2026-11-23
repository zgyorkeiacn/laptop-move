// 7-Zip: only the installed one in Program Files, version 26.03 or newer, checked before every use.
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

/** Meaning of 7-Zip's exit code. @param {number} code */
export function exitMeaning(code) {
  return ({ 0: 'ok', 1: 'warning (some files were locked or changed: see the lines above)', 2: 'fatal error', 7: 'command line error', 8: 'not enough memory', 255: 'stopped by the user' })[code] ?? `exit code ${code}`;
}
