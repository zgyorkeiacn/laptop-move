// The new laptop's environment: PATH after an install, Authenticode signatures, downloads over https.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run, runInherit } from './util.mjs';
import { publisherMatches } from './winget.mjs';

const w = path.win32;
const SYS = process.env.SystemRoot || 'C:\\Windows';
const REG = w.join(SYS, 'System32', 'reg.exe');
const CURL = w.join(SYS, 'System32', 'curl.exe');
const POWERSHELL = w.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MACHINE_ENV = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/** Parses one value of `reg query <key> /v <name>`. @param {string} out @param {string} name */
export function parseRegValue(out, name) {
  const re = new RegExp(`^\\s*${name}\\s+(REG_EXPAND_SZ|REG_SZ)\\s+(.*)$`, 'im');
  const m = re.exec(out);
  return m ? { type: m[1], value: m[2].trim() } : null;
}

/** @param {string} key @param {string} name */
async function regRead(key, name) {
  const r = await run(REG, ['query', key, '/v', name], { timeout: 30000 });
  return r.code === 0 ? parseRegValue(r.stdout, name) : null;
}

/** Expands %VAR% in a registry PATH. @param {string} s */
function expand(s) {
  return s.replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m);
}

/** Reads PATH again from the registry (machine, then user), so tools installed a moment ago are found. */
export async function refreshPath() {
  const machine = await regRead(MACHINE_ENV, 'Path');
  const user = await regRead('HKCU\\Environment', 'Path');
  const parts = [machine?.value, user?.value].filter(Boolean).map((v) => expand(/** @type {string} */ (v)));
  if (parts.length) process.env.Path = parts.join(';');
  return process.env.Path;
}

/**
 * Adds a folder to the user's PATH (HKCU\Environment), unless it is there already. New windows see it after sign-out.
 * @param {string} dir
 */
export async function addUserPath(dir) {
  const cur = await regRead('HKCU\\Environment', 'Path');
  const list = (cur?.value ?? '').split(';').filter(Boolean);
  if (list.some((p) => expand(p).toLowerCase().replace(/\\$/, '') === dir.toLowerCase().replace(/\\$/, ''))) return { ok: true, changed: false };
  const value = [...list, dir].join(';');
  const r = await run(REG, ['add', 'HKCU\\Environment', '/v', 'Path', '/t', cur?.type ?? 'REG_EXPAND_SZ', '/d', value, '/f'], { timeout: 30000 });
  return { ok: r.code === 0, changed: r.code === 0 };
}

/**
 * The environment for Windows PowerShell: without PSModulePath, which PowerShell 7 sets to its own module folders when
 * the kit is started from pwsh; Windows PowerShell then cannot load its own Microsoft.PowerShell.Security module.
 * Left out, Windows PowerShell builds its default module path again.
 * @param {Record<string, string|undefined>} extra
 */
export function windowsPowerShellEnv(extra) {
  /** @type {Record<string, string|undefined>} */ const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  return env;
}

/**
 * The Authenticode signature of a file (Windows PowerShell's Get-AuthenticodeSignature, no profile, no change to the
 * execution policy). The path goes through the environment, never into the command text.
 * @param {string} file
 * @returns {Promise<{status: string, subject: string}>}
 */
export async function signature(file) {
  const cmd = '$s = Get-AuthenticodeSignature -LiteralPath $env:LM_FILE -ErrorAction Stop; '
    + '$o = @{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject }; ConvertTo-Json -Compress -InputObject $o';
  const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: windowsPowerShellEnv({ LM_FILE: file }), timeout: 120000 });
  try {
    const j = JSON.parse(r.stdout.trim());
    return { status: String(j.status || 'Unknown'), subject: String(j.subject ?? '') };
  } catch {
    const why = r.stderr.split(/\r?\n/).find((l) => l.trim()) ?? `exit ${r.code}`;
    return { status: `not checked (${why.trim().slice(0, 160)})`, subject: '' };
  }
}

/**
 * True when a file is validly signed by the publisher. @param {string} file @param {string|undefined} publisher
 * @returns {Promise<{ok: boolean, why: string, subject: string}>}
 */
export async function signedBy(file, publisher) {
  const s = await signature(file);
  if (s.status !== 'Valid') return { ok: false, why: `signature ${s.status || 'missing'}`, subject: s.subject };
  if (!publisherMatches(publisher, s.subject)) return { ok: false, why: `signed by ${s.subject}, not by ${publisher ?? '?'}`, subject: s.subject };
  return { ok: true, why: 'signature valid', subject: s.subject };
}

/**
 * Downloads a file over https with Windows' own curl.exe (redirects followed, https only).
 * @param {string} url
 * @param {string} file
 * @param {{quiet?: boolean}} [o]
 */
export async function download(url, file, o = {}) {
  if (!/^https:\/\//i.test(url)) return { ok: false, why: 'not an https link' };
  await mkdir(w.dirname(file), { recursive: true });
  const args = ['-L', '--fail', '--retry', '3', '--proto', '=https', '--proto-redir', '=https', '-o', file, url];
  const code = o.quiet
    ? (await run(CURL, ['-sS', ...args], { timeout: 3600000 })).code
    : await runInherit(CURL, ['-#', ...args]);
  return code === 0 && existsSync(file) ? { ok: true, why: '' } : { ok: false, why: `download failed (curl exit ${code})` };
}

/** Text of a small https resource (a checksum list). @param {string} url */
export async function fetchText(url) {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (r.ok) return await r.text();
  } catch { /* the curl fallback below */ }
  const r = await run(CURL, ['-sS', '-L', '--fail', '--proto', '=https', '--proto-redir', '=https', url], { timeout: 120000 });
  return r.code === 0 ? r.stdout : null;
}

/** Opens a file with its default app (the report in the browser). @param {string} file */
export function openFile(file) {
  return run(w.join(SYS, 'explorer.exe'), [file], { timeout: 30000 });
}

export const TOOLS = { REG, CURL, POWERSHELL };
