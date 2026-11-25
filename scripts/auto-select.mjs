// auto-select: does by script what the page's Scan, folder settings and Save do by hand before packing.
//   node scripts/auto-select.mjs [--dry] [--fetch] [--repo <name>]... [--out <file>] [--selection <file>] [--scan-root "<a>;<b>"]
// The scan is the page's own (kit/lib/discover.mjs discover(), default roots: the user folder and the system drive, no
// winget lookup). It starts from the selection the page would load, ticks the worktrees the way the page does after a
// scan, unticks the merged ones, forces the named repositories and the two copy-whole folders, and saves with
// saveSelection() to the file the page's Save writes. Git is read only (GIT_OPTIONAL_LOCKS=0); fetch only with --fetch.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from '../kit/lib/discover.mjs';
import { gitRead } from '../kit/lib/git.mjs';
import { selectionCandidates, defaultRulesFile } from '../kit/lib/plan.mjs';
import { emptyRules, readRules } from '../kit/lib/rules.mjs';
import { isOneDrive } from '../kit/lib/paths.mjs';
import { readSelectionRaw, saveSelection } from '../kit/lib/selection.mjs';

const w = path.win32;

/** Repositories forced to "clone again + bundle/dirty" (folder names, case-insensitive). Add more with --repo <name>. */
export const FORCED_REPOS = [
  'ai-agent-orchestrator', 'ai-block-kit', 'ai-project-hub', // under C:\git_accenture
  'blok.ai', 'smakmal', 'budget-tracker' /* BrickBudget */, 'lego-tracker' /* Brick Tracker */, // under C:\git_personal
];
export const BUNDLE = 'clone again + bundle/dirty';
export const COPY = 'copy whole';
/** The remote default branches, as the last fetch left them. */
export const DEFAULT_REFS = ['refs/remotes/origin/master', 'refs/remotes/origin/main', 'refs/remotes/ado/master'];

/** @param {string} p @param {string} home @param {string} appdata */
export function shorten(p, home, appdata) {
  const lc = p.toLowerCase();
  if (home && (lc === home.toLowerCase() || lc.startsWith(`${home.toLowerCase()}\\`))) return `%USERPROFILE%${p.slice(home.length)}`;
  if (appdata && (lc === appdata.toLowerCase() || lc.startsWith(`${appdata.toLowerCase()}\\`))) return `%APPDATA%${p.slice(appdata.length)}`;
  return p;
}

/**
 * Whether a worktree's work is merged: its tip is an ancestor of a remote default branch AND it has no changes.
 * @param {string} dir
 * @returns {Promise<{merged: boolean, why: string}>}
 */
export async function gitMerged(dir) {
  const st = await gitRead(dir, ['status', '--porcelain']);
  if (st.code !== 0) return { merged: false, why: 'git status failed: kept' };
  if (st.stdout.trim()) return { merged: false, why: 'has uncommitted or untracked changes' };
  let seen = 0;
  for (const ref of DEFAULT_REFS) {
    if ((await gitRead(dir, ['rev-parse', '--verify', '--quiet', ref])).code !== 0) continue;
    seen++;
    if ((await gitRead(dir, ['merge-base', '--is-ancestor', 'HEAD', ref])).code === 0) return { merged: true, why: `tip is in ${ref.replace('refs/remotes/', '')}` };
  }
  return { merged: false, why: seen ? 'tip is not in the remote default branch' : 'no remote default branch known' };
}

/**
 * The rules, on a scan result and the selection's folder rows. Pure apart from isMerged and the git it calls.
 * @param {{found: any[], folders: {path: string, mode: string}[], names: string[], home: string, appdata: string,
 *   isMerged: (dir: string) => Promise<{merged: boolean, why: string}>}} o
 */
export async function applyRules(o) {
  const lc = (/** @type {string} */ s) => s.toLowerCase();
  /** @type {{path: string, mode: string}[]} */
  const folders = o.folders.map((f) => ({ ...f }));
  const find = (/** @type {string} */ p) => folders.find((f) => lc(f.path) === lc(p));
  const set = (/** @type {string} */ p, /** @type {string} */ mode) => { const f = find(p); if (f) f.mode = mode; else folders.push({ path: p, mode }); };
  const drop = (/** @type {string} */ p) => { const i = folders.findIndex((f) => lc(f.path) === lc(p)); if (i >= 0) folders.splice(i, 1); };
  /** @type {string[]} */ const decisions = [];
  /** @type {string[]} */ const notFound = [];
  const counts = { worktreesUnticked: 0, forced: 0 };
  const sh = (/** @type {string} */ p) => shorten(p, o.home, o.appdata);

  for (const f of o.found) {
    if (f.kind !== 'repo' || !f.worktree || f.secret) continue;
    if (f.client) { decisions.push(`worktree ${sh(f.path)}: client, keeps what the scan suggests`); if (!find(f.path)) set(f.path, f.mode); continue; }
    const r = await o.isMerged(f.path);
    if (r.merged) { drop(f.path); counts.worktreesUnticked++; decisions.push(`worktree ${sh(f.path)}: UNTICKED, merged (${r.why})`); }
    else { set(f.path, BUNDLE); decisions.push(`worktree ${sh(f.path)}: ticked, ${BUNDLE} (${r.why})`); }
  }

  for (const name of o.names) {
    const hits = o.found.filter((f) => f.kind === 'repo' && !f.secret && lc(w.basename(f.path)) === lc(name));
    if (!hits.length) { notFound.push(name); decisions.push(`${name}: not found by the scan`); continue; }
    for (const f of hits) {
      if (f.client) { decisions.push(`${sh(f.path)}: client, keeps what the scan suggests`); continue; }
      set(f.path, BUNDLE); counts.forced++; decisions.push(`${sh(f.path)}: forced ${BUNDLE}`);
    }
  }

  for (const p of [w.join(o.home, '.claude'), w.join(o.appdata, 'AIxOrchestrator')]) {
    const f = o.found.find((x) => lc(x.path) === lc(p));
    if (f && (f.client || f.secret)) { decisions.push(`${sh(p)}: ${f.client ? 'client' : 'secret'}, keeps what the scan suggests`); continue; }
    set(p, COPY); counts.forced++; decisions.push(`${sh(p)}: forced ${COPY}`);
  }
  return { folders, decisions, notFound, counts };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const o = { dry: false, fetch: false, /** @type {string[]} */ repos: [], out: '', selection: '', scanRoot: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (a === '--fetch') o.fetch = true;
    else if (a === '--repo') o.repos.push(String(argv[++i] ?? ''));
    else if (a === '--out') o.out = String(argv[++i] ?? '');
    else if (a === '--selection') o.selection = String(argv[++i] ?? '');
    else if (a === '--scan-root') o.scanRoot = String(argv[++i] ?? '');
    else throw new Error(`unknown option ${a} (--dry, --fetch, --repo <name>, --out <file>, --selection <file>, --scan-root "<a>;<b>")`);
  }
  if (o.repos.some((r) => !r)) throw new Error('--repo needs a folder name');
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const home = w.normalize(process.env.USERPROFILE ?? os.homedir());
  const appdata = w.normalize(process.env.APPDATA ?? w.join(home, 'AppData', 'Roaming'));
  const sh = (/** @type {string} */ p) => shorten(p, home, appdata);

  const first = o.selection ? w.resolve(o.selection) : selectionCandidates().find((f) => existsSync(f)) ?? null;
  const base = first ? await readSelectionRaw(first) : { savedAt: '', folders: [], applications: [], settings: [], questions: [], comments: {}, commentLabels: {} };
  console.log(first ? `Selection loaded: ${sh(first)} (${base.folders.length} folder rows)` : 'No selection file found: starting a new one');
  const rules = (first ? await readRules(defaultRulesFile(first)) : null) ?? emptyRules();

  const roots = o.scanRoot ? o.scanRoot.split(';').map((s) => s.trim()).filter(Boolean).map((p) => w.resolve(p)) : undefined;
  const disc = await discover({ roots, rules, appLookup: false });
  const worktrees = disc.found.filter((f) => f.kind === 'repo' && f.worktree && !f.secret);
  if (o.fetch) {
    for (const f of worktrees) await gitRead(f.path, ['fetch', '--quiet']);
  }
  const r = await applyRules({ found: disc.found, folders: base.folders, names: [...FORCED_REPOS, ...o.repos], home, appdata, isMerged: gitMerged });
  console.log(`Scan: ${disc.found.length} found, ${worktrees.length} worktrees`);
  for (const d of r.decisions) console.log(`  ${d}`);

  const json = { ...base, folders: r.folders };
  const outFile = o.out ? w.resolve(o.out) : first ?? w.join(home, 'Downloads', 'laptop-move-selection.json');
  if (o.dry) {
    console.log('Selection (not saved, --dry):');
    for (const f of r.folders) console.log(`  [x] ${f.mode.padEnd(28)} ${sh(f.path)}`);
  } else {
    if (isOneDrive(w.dirname(outFile)) || rules.forbiddenOut.some((/** @type {string} */ f) => w.dirname(outFile).toLowerCase().startsWith(f.toLowerCase()))) {
      throw new Error(`cannot save to ${sh(outFile)}: a client folder or a synced OneDrive folder`);
    }
    const s = await saveSelection(outFile, json);
    console.log(`Saved ${sh(s.file)}${s.backup ? ` (old file kept as ${sh(s.backup)})` : ''}`);
  }
  console.log(`Summary: ${r.folders.length} ticked, ${r.counts.worktreesUnticked} worktrees unticked as merged, ${r.counts.forced} forced, ${r.notFound.length} names not found${r.notFound.length ? ` (${r.notFound.join(', ')})` : ''}${o.dry ? ' [dry: nothing written]' : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === w.resolve(process.argv[1]).toLowerCase()) {
  main().catch((e) => { console.error(`auto-select: ${e.message}`); process.exit(1); });
}
