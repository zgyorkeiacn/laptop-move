// The final folders: made before restore clones or moves anything into them, so that no clone, move or link fails
// half-way on a folder the user may not create (a folder at the drive root on a locked-down laptop, for example).
// The kit writes a PowerShell script (<work>\prepare-folders.ps1) and a list of the folders, runs the script, and checks
// from node that it can write into every folder. For the folders it cannot, it runs the same script once more as
// administrator (Windows asks once): that run makes them and gives the user Modify rights on them.
// The script can also be run by hand as administrator. It never removes or replaces anything.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { mapPath } from './paths.mjs';
import { run, fmtLimit, STEP_TIMEOUT } from './util.mjs';
import { TOOLS, windowsPowerShellEnv } from './env.mjs';

const w = path.win32;
const WHOAMI = w.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');

/** True for a drive root such as C:\. @param {string} p */
function isDriveRoot(p) {
  return /^[a-z]:\\?$/i.test(p);
}

/**
 * The folders the restore writes into, each once: the parent of every repository, worktree, folder, file and link it
 * puts back, and a loose unit's own folder. Something directly at a drive root gets its own folder made (empty: clone,
 * git worktree add and the move all take an empty folder), since the drive root itself is never made or changed.
 * @param {{repos?: any[], units?: any[], links?: any[]}} manifest
 * @param {{oldProfile?: string, newProfile?: string, targetRoot?: string}} mapping
 * @returns {string[]}
 */
export function targetFolders(manifest, mapping) {
  /** @type {Map<string, string>} */ const out = new Map();
  const addDir = (/** @type {string} */ d) => {
    const n = w.normalize(d).replace(/\\+$/, '');
    if (!isDriveRoot(n)) out.set(n.toLowerCase(), n);
  };
  /** @param {string} dest @param {boolean} ownFolderAtRoot */
  const addFor = (dest, ownFolderAtRoot) => {
    const parent = w.dirname(dest);
    if (!isDriveRoot(parent)) addDir(parent);
    else if (ownFolderAtRoot) addDir(dest);
  };
  for (const r of manifest.repos ?? []) {
    addFor(mapPath(r.path, mapping), true);
    if (r.worktreeOf) addFor(mapPath(r.worktreeOf, mapping), true);
  }
  for (const u of manifest.units ?? []) {
    const dest = mapPath(u.path, mapping);
    if (u.kind === 'loose') addDir(dest);
    else addFor(dest, u.kind === 'folder');
  }
  for (const l of manifest.links ?? []) if (l.path) addFor(mapPath(l.path, mapping), false);
  return [...out.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * True when this process can make a folder and a file in dir (and remove them again).
 * @param {string} dir
 * @returns {Promise<{ok: boolean, why: string}>}
 */
export async function canWrite(dir) {
  if (!existsSync(dir)) return { ok: false, why: 'missing' };
  const tag = `.laptop-move-probe-${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(w.join(dir, tag));
    await rmdir(w.join(dir, tag));
    await writeFile(w.join(dir, `${tag}.tmp`), '');
    await unlink(w.join(dir, `${tag}.tmp`));
    return { ok: true, why: '' };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { ok: false, why: err.code === 'EPERM' || err.code === 'EACCES' ? 'no write access' : String(err.code ?? err.message) };
  }
}

/** The PowerShell script: makes every folder of the list; with -Grant also gives the user (by SID) Modify rights. */
export const PREPARE_SCRIPT = `# Laptop move: makes the folders the restore puts things into, before it clones or moves anything there.
# The kit runs it itself (once as you, then once as administrator for the folders you may not make).
# To run it by hand, as administrator:
#   powershell -NoProfile -ExecutionPolicy Bypass -File prepare-folders.ps1 -List prepare-folders.json -Out result.json -Grant
# It never removes or replaces anything.
param([Parameter(Mandatory = $true)][string]$List, [Parameter(Mandatory = $true)][string]$Out, [switch]$Grant)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $List -Raw -Encoding UTF8 | ConvertFrom-Json
$rows = @()
foreach ($d in @($job.folders)) {
  $r = [ordered]@{ path = $d; existed = $false; created = $false; granted = $false; error = '' }
  try {
    $r.existed = Test-Path -LiteralPath $d -PathType Container
    if (-not $r.existed) {
      New-Item -ItemType Directory -Path $d -Force | Out-Null
      $r.created = $true
    }
    if ($Grant -and $job.sid) {
      $said = & icacls.exe $d /grant ('*' + $job.sid + ':(OI)(CI)M') 2>&1
      if ($LASTEXITCODE -eq 0) { $r.granted = $true } else { $r.error = ($said | Out-String).Trim() }
    }
  } catch { $r.error = $_.Exception.Message }
  $rows += [pscustomobject]$r
}
ConvertTo-Json -InputObject @($rows) -Depth 3 | Set-Content -LiteralPath $Out -Encoding UTF8
`;

/** The SID of the user running the kit (whoami /user), or null. */
export async function currentSid() {
  const r = await run(WHOAMI, ['/user', '/fo', 'csv', '/nh'], { timeout: 30000 });
  const m = /"(S-1-[0-9-]+)"/.exec(r.stdout);
  return m ? m[1] : null;
}

/** @param {string} file @returns {Promise<any[]|null>} */
async function readResult(file) {
  try {
    const j = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim());
    return Array.isArray(j) ? j : [j];
  } catch { return null; }
}

/**
 * Makes the final folders before restore writes into them (see the top of this file).
 * @param {string[]} folders
 * @param {{work: string, timeout?: number, emit?: (e: any) => void, elevate?: boolean,
 *   runScript?: (o: {script: string, list: string, out: string, admin: boolean, timeout: number}) => Promise<{code: number, timedOut?: boolean, why?: string}>}} o
 * @returns {Promise<{rows: {name: string, status: string, detail: string}[], failed: string[], script: string}>}
 */
export async function prepareFolders(folders, o) {
  const emit = o.emit ?? (() => {});
  const runScript = o.runScript ?? runPrepareScript;
  const script = w.join(o.work, 'prepare-folders.ps1');
  const list = w.join(o.work, 'prepare-folders.json');
  await mkdir(o.work, { recursive: true });
  for (const f of ['prepare-folders-result.json', 'prepare-folders-admin-result.json']) await unlink(w.join(o.work, f)).catch(() => {});
  await writeFile(script, PREPARE_SCRIPT, 'utf8');
  const sid = await currentSid();
  await writeFile(list, `${JSON.stringify({ sid, folders }, null, 1)}\n`, 'utf8');
  const before = new Map(folders.map((f) => [f.toLowerCase(), existsSync(f)]));

  const first = await runScript({ script, list, out: w.join(o.work, 'prepare-folders-result.json'), admin: false, timeout: 5 * 60 * 1000 });
  /** @type {string[]} */ const notes = [];
  if (first.code !== 0) notes.push(`the folder script did not run (${first.timedOut ? 'no answer after 5 min' : first.why || `exit ${first.code}`}): made with node instead`);
  // Whatever the script could not make (or a script that did not run at all), node tries as well.
  for (const f of folders) if (!existsSync(f)) await mkdir(f, { recursive: true }).catch(() => {});

  /** @type {Map<string, {ok: boolean, why: string}>} */ const probe = new Map();
  for (const f of folders) probe.set(f, await canWrite(f));
  let stuck = folders.filter((f) => !probe.get(f)?.ok);
  /** @type {Set<string>} */ const byAdmin = new Set();
  if (stuck.length && o.elevate !== false) {
    emit({ type: 'step', text: `${stuck.length} folder${stuck.length === 1 ? '' : 's'} need administrator rights (${stuck.slice(0, 3).join(', ')}${stuck.length > 3 ? ', ...' : ''}): Windows asks for permission now` });
    const adminList = w.join(o.work, 'prepare-folders-admin.json');
    await writeFile(adminList, `${JSON.stringify({ sid, folders: stuck }, null, 1)}\n`, 'utf8');
    const limit = o.timeout ?? STEP_TIMEOUT;
    const second = await runScript({ script, list: adminList, out: w.join(o.work, 'prepare-folders-admin-result.json'), admin: true, timeout: limit });
    if (second.timedOut) notes.push(`the administrator run got no answer in ${fmtLimit(limit)}: stopped`);
    else if (second.code !== 0) notes.push(`the administrator run did not happen (${second.why || `exit ${second.code}`}): the permission was refused or the script was blocked`);
    for (const f of stuck) {
      const p = await canWrite(f);
      if (p.ok) byAdmin.add(f);
      probe.set(f, p);
    }
    stuck = stuck.filter((f) => !probe.get(f)?.ok);
  }

  // What the script itself said about a folder it could not make (the administrator run's word counts last).
  /** @type {Map<string, string>} */ const said = new Map();
  for (const f of ['prepare-folders-result.json', 'prepare-folders-admin-result.json']) {
    for (const r of (await readResult(w.join(o.work, f))) ?? []) if (r?.path && r.error) said.set(String(r.path).toLowerCase(), String(r.error).split(/\r?\n/)[0]);
  }
  const rows = folders.map((f) => {
    const p = probe.get(f) ?? { ok: false, why: '?' };
    const made = !before.get(f.toLowerCase()) && existsSync(f);
    const err = said.get(f.toLowerCase());
    if (!p.ok) return { name: f, status: 'failed', detail: `${p.why}${err ? ` (${err})` : ''}: make it as administrator and give yourself write access (run ${script} as administrator, see its first lines), then run restore again` };
    if (byAdmin.has(f)) return { name: f, status: made ? 'created as administrator' : 'made writable as administrator', detail: 'you have Modify rights on it now' };
    return { name: f, status: made ? 'created' : 'ready', detail: '' };
  });
  if (notes.length && rows[0]) rows[0] = { ...rows[0], detail: [rows[0].detail, ...notes].filter(Boolean).join('; ') };
  for (const n of notes) emit({ type: 'warn', text: `folders: ${n}` });
  return { rows, failed: stuck, script };
}

/**
 * Runs the folder script with Windows PowerShell: as the user, or elevated through Start-Process -Verb RunAs (the UAC
 * prompt). Paths reach the outer PowerShell through the environment, never inside its command text.
 * @param {{script: string, list: string, out: string, admin: boolean, timeout: number}} o
 * @returns {Promise<{code: number, timedOut?: boolean, why?: string}>}
 */
export async function runPrepareScript(o) {
  const ps = TOOLS.POWERSHELL;
  if (!o.admin) {
    const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', o.script, '-List', o.list, '-Out', o.out],
      { timeout: o.timeout, env: windowsPowerShellEnv({}), label: `powershell -File ${o.script} (as you)` });
    return { code: existsSync(o.out) ? r.code : r.code || 1, timedOut: r.timedOut, why: (r.stderr || r.stdout).trim().split(/\r?\n/).pop() };
  }
  const cmd = "$a = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('\"' + $env:LM_PS1 + '\"'),'-List',('\"' + $env:LM_LIST + '\"'),'-Out',('\"' + $env:LM_OUT + '\"'),'-Grant'); "
    + '$p = Start-Process -FilePath $env:LM_PS -ArgumentList $a -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode';
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    timeout: o.timeout,
    env: windowsPowerShellEnv({ LM_PS: ps, LM_PS1: o.script, LM_LIST: o.list, LM_OUT: o.out }),
    label: `powershell -File ${o.script} -Grant (as administrator)`,
  });
  return { code: r.code === 0 && existsSync(o.out) ? 0 : r.code || 1, timedOut: r.timedOut, why: (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).pop() };
}
