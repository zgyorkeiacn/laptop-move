// discover: read only. Finds what could move, for the page's choose screens: the top-level folders of the user folder
// and of the system drive, the repositories one level below them (remote or not, client or not: read from .git\config,
// the URL itself is never returned), the settings the kit knows, and (when asked) the apps winget lists. Sizes come
// later, from the dry run of the chosen folders.
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyDir, SYSTEM_LINK_NAMES } from './filters.mjs';
import { isClientPath, isClientRemote, emptyRules } from './rules.mjs';
import { settingTargets } from './plan.mjs';
import { isOneDrive, norm } from './paths.mjs';
import { run, stamp } from './util.mjs';

const w = path.win32;

/** Top-level folders of a system drive that are Windows' or the programs' own. */
const DRIVE_SKIP = /^(windows|program files( \(x86\))?|programdata|users|\$recycle\.bin|\$windows\..*|\$winreagent|perflogs|recovery|system volume information|config\.msi|msocache|intel|amd|nvidia|drivers|onedrivetemp|windows\.old|boot|efi|documents and settings|xboxgames|inetpub)$/i;
/** Top-level folders of the user folder that are never offered: app data, synced and Windows' own. */
const PROFILE_SKIP = /^(appdata|onedrive( - .*)?|application data|local settings|cookies|nethood|printhood|recent|sendto|start menu|templates|intelguides|ansel|saved games|searches|contacts|links|favorites|3d objects|music|videos|pictures)$/i;

/** The settings rows the kit knows how to carry, with the form's wording. */
export const KNOWN_SETTINGS = [
  { app: 'Git', how: 'copy the file; credentials are entered again through the Credential Manager sign-in, never copied' },
  { app: 'VS Code', how: 'copy %APPDATA%\\Code\\User (without globalStorage and workspaceStorage) and install its extensions again' },
  { app: 'Cursor', how: 'copy %APPDATA%\\Cursor\\User and install its extensions again; sign in again' },
  { app: 'Windows Terminal', how: 'copy LocalState\\settings.json from the Packages\\Microsoft.WindowsTerminal_* folder' },
  { app: 'Claude Code', how: 'copy the folder; its credentials stay behind: sign in again' },
];

/**
 * The remotes of a repository from its .git\config: how many, and whether any is a client remote. No URL leaves here.
 * @param {string} dir
 * @param {import('./rules.mjs').Rules} rules
 */
export async function remoteFacts(dir, rules) {
  let cfg = w.join(dir, '.git', 'config');
  try {
    const st = await lstat(w.join(dir, '.git'));
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(await readFile(w.join(dir, '.git'), 'utf8'));
      if (!m) return { remotes: 0, client: false, worktree: true };
      const gd = w.resolve(dir, m[1].trim());
      const common = existsSync(w.join(gd, 'commondir')) ? w.resolve(gd, (await readFile(w.join(gd, 'commondir'), 'utf8')).trim()) : gd;
      cfg = w.join(common, 'config');
    }
  } catch { return { remotes: 0, client: false, worktree: false }; }
  let text = '';
  try { text = await readFile(cfg, 'utf8'); } catch { /* no config */ }
  let remotes = 0;
  let client = false;
  let inRemote = false;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (sec) { inRemote = sec[1].toLowerCase() === 'remote'; continue; }
    const m = /^\s*url\s*=\s*(.+?)\s*$/i.exec(line);
    if (inRemote && m) { remotes++; if (isClientRemote(m[1], rules)) client = true; }
  }
  return { remotes, client, worktree: cfg !== w.join(dir, '.git', 'config') };
}

/**
 * @typedef {{path: string, kind: 'folder'|'repo'|'loose', parent: string|null, remote: boolean, client: boolean,
 *   secret: string|null, mode: string, note: string, worktree?: boolean}} Found
 */

/** The mode the form would suggest for a find. @param {{kind: string, remote: boolean, client: boolean, secret: string|null, worktree?: boolean}} f */
export function suggestMode(f) {
  if (f.secret) return 'by hand';
  if (f.kind === 'repo') return f.remote || f.worktree ? 'clone again + bundle/dirty' : 'copy whole';
  return 'copy whole';
}

/** What the kit does with a find, in the page's words. @param {Found} f */
export function findNote(f) {
  if (f.secret) return `never copied (${f.secret}): it is on the by-hand list`;
  if (f.kind === 'repo') {
    if (f.worktree) return 'a git worktree: restored with git worktree add after its main repository is cloned, its local commits and changed files carried (the scan ticks it; untick it when its work is finished and merged)';
    if (f.client && f.remote) return 'client, has remote: stays out of the bundle; push its work, then it is cloned again';
    if (f.client) return 'client, no remote: goes into the separate client part, Accenture OneDrive only';
    return f.remote ? 'has remote: cloned again, its local commits, stashes and changed files carried' : 'no remote: packed whole in the data part';
  }
  if (f.client) return 'client folder: goes into the separate client part, Accenture OneDrive only';
  return f.kind === 'loose' ? 'the files lying directly in the user folder, .gitconfig included' : 'packed in the data part, without node_modules, build output and secret files';
}

/** @param {string} dir */
async function entries(dir) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * Finds what could move. Read only.
 * @param {{roots?: string[], rules?: import('./rules.mjs').Rules|null, appLookup?: boolean, maxChildren?: number,
 *   emit?: (e: any) => void}} [o]
 */
export async function discover(o = {}) {
  const emit = o.emit ?? (() => {});
  const rules = o.rules ?? emptyRules();
  const home = norm(process.env.USERPROFILE ?? os.homedir());
  const sys = `${(process.env.SystemDrive ?? 'C:').replace(/\\$/, '')}\\`;
  const roots = (o.roots?.length ? o.roots : [home, sys]).map(norm);
  const maxChildren = o.maxChildren ?? 300;
  /** @type {Found[]} */ const found = [];
  /** @type {string[]} */ const notes = [];
  const seen = new Set();
  const add = (/** @type {Found} */ f) => { const k = f.path.toLowerCase(); if (!seen.has(k)) { seen.add(k); found.push(f); } };

  emit({ type: 'phase', name: 'discover', text: 'Looking for folders and repositories' });
  let n = 0;
  for (const root of roots) {
    n++;
    emit({ type: 'progress', done: n, total: roots.length, text: root });
    const isHome = root.toLowerCase() === home.toLowerCase();
    const isDrive = /^[a-z]:\\?$/i.test(root);
    if (isHome) add({ path: `${home}\\ (loose files and .gitconfig)`, kind: 'loose', parent: null, remote: false, client: false, secret: null, mode: 'copy whole', note: '' });
    for (const d of await entries(root)) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const name = d.name;
      const p = w.join(root, name);
      if (isDrive && DRIVE_SKIP.test(name)) continue;
      if (isHome && (PROFILE_SKIP.test(name) || SYSTEM_LINK_NAMES.has(name.toLowerCase()))) continue;
      if (isOneDrive(p)) continue;
      if (!isHome && p.toLowerCase() === home.toLowerCase()) continue;
      let st;
      try { st = await lstat(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      const kids = await entries(p);
      const cls = classifyDir(name, root.toLowerCase(), kids.map((k) => k.name));
      if (cls?.kind === 'skip') continue;
      const secret = cls?.kind === 'secret' ? cls.why : null;
      const client = isClientPath(p, rules);
      if (!secret && kids.some((k) => k.name === '.git')) {
        const r = await remoteFacts(p, rules);
        add({ path: p, kind: 'repo', parent: null, remote: r.remotes > 0, client: client || r.client, secret: null, mode: '', note: '', worktree: r.worktree });
        continue;
      }
      add({ path: p, kind: 'folder', parent: null, remote: false, client, secret, mode: '', note: '' });
      if (secret) continue;
      let c = 0;
      for (const k of kids) {
        if (!k.isDirectory() || k.isSymbolicLink()) continue;
        const kp = w.join(p, k.name);
        if (!existsSync(w.join(kp, '.git'))) continue;
        if (++c > maxChildren) { notes.push(`${p}: more than ${maxChildren} repositories, the rest are not listed`); break; }
        const r = await remoteFacts(kp, rules);
        add({ path: kp, kind: 'repo', parent: p, remote: r.remotes > 0, client: client || isClientPath(kp, rules) || r.client, secret: null, mode: '', note: '', worktree: r.worktree });
      }
    }
  }
  for (const f of found) { f.mode = f.mode || suggestMode(f); f.note = findNote(f); }

  /** @type {{app: string, how: string, present: boolean}[]} */
  const settings = [];
  for (const s of KNOWN_SETTINGS) {
    const t = await settingTargets(s.app);
    settings.push({ ...s, present: t.some((x) => existsSync(x.path)) });
  }

  /** @type {{name: string, wingetId: string, source: string}[]} */
  let apps = [];
  if (o.appLookup !== false) {
    emit({ type: 'phase', name: 'apps', text: 'Asking winget which apps are installed' });
    const r = await wingetExport();
    apps = r.apps;
    if (r.why) notes.push(`apps: ${r.why}`);
  } else notes.push('apps: not looked up (the list comes from the selection only)');
  emit({ type: 'done', text: `Found ${found.length} folders and repositories` });
  return { roots, found, settings, apps, notes };
}

/** Parses winget export's JSON into package ids. @param {any} json */
export function parseWingetExport(json) {
  /** @type {{name: string, wingetId: string, source: string}[]} */
  const out = [];
  const seen = new Set();
  for (const s of json?.Sources ?? []) {
    const src = String(s?.SourceDetails?.Name ?? 'winget').toLowerCase();
    if (src !== 'winget') continue; // msstore ids need the store: listed by hand instead
    for (const p of s?.Packages ?? []) {
      const id = String(p?.PackageIdentifier ?? '').trim();
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      out.push({ name: id, wingetId: id, source: 'winget' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The installed apps winget knows, by id (read only: winget export into a temporary file, deleted after). */
export async function wingetExport() {
  const dir = w.join(process.env.LOCALAPPDATA ?? w.join(os.homedir(), 'AppData', 'Local'), 'LaptopMove', `discover-${stamp()}`);
  const file = w.join(dir, 'winget-export.json');
  try {
    await mkdir(dir, { recursive: true });
    const r = await run('winget', ['export', '-o', file, '--accept-source-agreements', '--disable-interactivity'], { timeout: 180000 });
    if (!existsSync(file)) return { apps: [], why: `winget export wrote nothing (exit ${r.code})` };
    return { apps: parseWingetExport(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))), why: null };
  } catch (e) {
    return { apps: [], why: `winget is not available (${/** @type {Error} */ (e).message})` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
