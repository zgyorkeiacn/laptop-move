// scan: reads the selection and the disk (read only) and plans what pack would do. formatPlan: the dry run's text.
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSelection, parseSelection } from './selection.mjs';
import { readRules, emptyRules, isClientPath, isClientRemote } from './rules.mjs';
import { walk } from './walk.mjs';
import { repoInfo, remotesOf, mainRepoOf } from './git.mjs';
import { classifyDir, classifyFile } from './filters.mjs';
import { norm, isInside, expandEnv } from './paths.mjs';
import { planApps, scanDeps, listExtensions } from './apps.mjs';
import { fmtBytes, fmtDuration, stamp } from './util.mjs';

const w = path.win32;
const MB = 1024 * 1024;

/** Rough rates for the estimate: packed size, 7-Zip speed on a busy laptop, upload and unpack speed. */
export const RATES = { ratio: 0.75, packBps: 25 * MB, uploadBps: 10 * MB, unpackBps: 60 * MB };

/** Where the selection file is looked for when none is named. */
export function selectionCandidates() {
  const list = [w.join(process.cwd(), 'laptop-move-selection.json')];
  if (process.env.APPDATA) list.push(w.join(process.env.APPDATA, 'AIxOrchestrator', 'reports', 'laptop-move-selection.json'));
  if (process.env.USERPROFILE) list.push(w.join(process.env.USERPROFILE, 'Downloads', 'laptop-move-selection.json'));
  return list;
}

/** The client rules file next to the selection. @param {string} selectionFile */
export function defaultRulesFile(selectionFile) {
  return w.join(w.dirname(selectionFile), 'laptop-move-client.json');
}

/** The default output folder: local, outside OneDrive. */
export function defaultOut() {
  return w.join(`${process.env.SystemDrive || 'C:'}\\`, 'LaptopMove', `bundle-${stamp()}`);
}

/** @param {number} bytes @param {number} volumeBytes */
export function estimate(bytes, volumeBytes) {
  const archive = Math.round(bytes * RATES.ratio);
  return {
    raw: bytes,
    archive,
    parts: archive > 0 ? Math.max(1, Math.ceil(archive / volumeBytes)) : 0,
    packSeconds: bytes / RATES.packBps,
    uploadSeconds: archive / RATES.uploadBps,
    unpackSeconds: bytes / RATES.unpackBps,
  };
}

/**
 * Maps one settings line of the form to the files or folders it stands for. Empty when it is a step for the user.
 * @param {string} app
 */
export async function settingTargets(app) {
  const home = process.env.USERPROFILE ?? os.homedir();
  const roaming = process.env.APPDATA ?? w.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA ?? w.join(home, 'AppData', 'Local');
  /** @type {{path: string, kind: 'folder'|'file'}[]} */
  const out = [];
  if (/^(vs ?code|visual studio code)$/i.test(app.trim())) out.push({ path: w.join(roaming, 'Code', 'User'), kind: 'folder' });
  else if (/^cursor$/i.test(app.trim())) out.push({ path: w.join(roaming, 'Cursor', 'User'), kind: 'folder' });
  else if (/windows terminal/i.test(app)) {
    try {
      for (const n of await readdir(w.join(local, 'Packages'))) {
        if (/^Microsoft\.WindowsTerminal(Preview)?_/i.test(n)) out.push({ path: w.join(local, 'Packages', n, 'LocalState', 'settings.json'), kind: 'file' });
      }
    } catch { /* no packages folder */ }
  } else if (/^git$/i.test(app.trim())) out.push({ path: w.join(home, '.gitconfig'), kind: 'file' });
  else if (/^claude code$/i.test(app.trim())) out.push({ path: w.join(home, '.claude'), kind: 'folder' });
  else {
    const m = /\((AppData\\[^)]+)\)/i.exec(app);
    if (m) out.push({ path: w.join(home, m[1]), kind: 'folder' });
  }
  return out;
}

/**
 * Plans the move. Read only: walks the picked folders, asks git, looks the apps up in winget.
 * @param {{selection?: string, selectionData?: any, rulesFile?: string, rules?: import('./rules.mjs').Rules|null, out?: string,
 *   volumeBytes?: number, clientData?: boolean, fast?: boolean, inventory?: string, appLookup?: boolean, extensions?: boolean}} o
 * @param {(e: any) => void} [emit]
 */
export async function scan(o, emit = () => {}) {
  emit({ type: 'phase', name: 'scan', text: 'Reading the selection' });
  let selectionFile = o.selection ?? null;
  if (!o.selectionData && !selectionFile) selectionFile = selectionCandidates().find((f) => existsSync(f)) ?? null;
  if (!o.selectionData && !selectionFile) throw new Error(`no selection file: save it from the form, then name it with --selection <file> (looked in ${selectionCandidates().join(', ')})`);
  const sel = o.selectionData ? parseSelection(o.selectionData) : await readSelection(/** @type {string} */ (selectionFile));
  const rulesFile = o.rulesFile ?? (selectionFile ? defaultRulesFile(selectionFile) : null);
  const rules = o.rules !== undefined ? (o.rules ?? emptyRules()) : ((rulesFile ? await readRules(rulesFile) : null) ?? emptyRules());
  const rulesFound = !!(o.rules || (rules.file && existsSync(rules.file)));
  const volumeBytes = o.volumeBytes ?? 4 * 1024 * MB;
  const clientData = !!o.clientData;
  const outExclude = [o.out, process.env.LOCALAPPDATA ? w.join(process.env.LOCALAPPDATA, 'LaptopMove') : null].filter(Boolean).map((p) => norm(/** @type {string} */ (p)));

  const plan = {
    version: 1,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    oldProfile: norm(process.env.USERPROFILE ?? os.homedir()),
    selectionFile,
    savedAt: sel.savedAt,
    rulesFile: rules.file ?? rulesFile,
    rulesFound,
    rules,
    fast: !!o.fast,
    clientData,
    volumeBytes,
    /** @type {any[]} */ units: [],
    /** @type {any[]} */ repos: [],
    /** @type {{path: string, why: string, group?: string}[]} */ byHand: [],
    /** @type {{path: string, why: string}[]} */ skipped: [],
    /** @type {any[]} */ pushFirst: [],
    /** @type {any[]} */ links: [],
    /** @type {any[]} */ settings: [],
    /** @type {any[]} */ apps: [],
    /** @type {{code: string[]|null, cursor: string[]|null}} */ extensions: { code: null, cursor: null },
    /** @type {{nodePins: string[], playwright: string[], npmCi: string[]}} */ deps: { nodePins: [], playwright: [], npmCi: sel.npmCi },
    /** @type {string[]} */ userSteps: [],
    /** @type {string[]} */ warnings: [...sel.warnings],
    totals: /** @type {any} */ ({}),
  };
  if (!rulesFound) plan.warnings.push(`no client rules file (${rulesFile ?? 'laptop-move-client.json next to the selection'}): nothing is treated as client data`);

  /** @type {Map<string, number>} */
  const invSizes = new Map();
  if (o.fast && o.inventory) {
    try {
      const inv = JSON.parse((await readFile(o.inventory, 'utf8')).replace(/^﻿/, ''));
      for (const f of inv.folders ?? []) if (f?.path) invSizes.set(norm(f.path).toLowerCase(), Math.round(Number(f.packMB ?? f.sizeMB ?? 0) * MB));
    } catch (e) { plan.warnings.push(`inventory not read: ${/** @type {any} */ (e).message}`); }
  }

  const live = sel.entries.filter((e) => !e.covered);
  let n = 0;
  for (const e of live) {
    n++;
    emit({ type: 'progress', done: n, total: live.length, text: e.path });
    if (e.mode === 'skip') { plan.skipped.push({ path: e.path, why: `left out (${e.raw || 'skip'})` }); continue; }
    if (e.mode === 'byhand') { plan.byHand.push({ path: e.path, why: 'picked as by hand', group: isClientPath(e.path, rules) ? 'client' : 'data' }); continue; }
    if (o.fast) {
      const bytes = invSizes.get(e.path.toLowerCase()) ?? 0;
      plan.units.push({ id: `u${plan.units.length + 1}`, path: e.path, kind: e.loose ? 'loose' : 'folder', mode: e.mode, files: [], fileCount: null, bytes, repoRoots: [], clientRepoRoots: [], dropped: [], group: isClientPath(e.path, rules) ? 'client' : 'data', fast: true });
      continue;
    }
    if (!existsSync(e.path)) { plan.warnings.push(`not found, left out: ${e.path}`); continue; }
    const exclude = [...e.exclude, ...outExclude];
    if (e.mode === 'clone' || e.mode === 'bundle') {
      const info = await repoInfo(e.path);
      if (!info) { plan.warnings.push(`not a git repository, copied whole instead: ${e.path}`); await addCopy(plan, e.path, 'folder', exclude, rules, clientData, null); continue; }
      if (!info.isRoot && !info.isWorktree) { plan.warnings.push(`inside a repository, not its top folder, copied whole instead: ${e.path}`); await addCopy(plan, e.path, 'folder', exclude, rules, clientData, null); continue; }
      if (!info.origin && !info.isWorktree) { await addCopy(plan, e.path, 'folder', exclude, rules, clientData, null); continue; }
      await addRepo(plan, info, e.mode, exclude, rules, clientData);
      continue;
    }
    await addCopy(plan, e.path, e.loose ? 'loose' : 'folder', exclude, rules, clientData, null);
  }

  emit({ type: 'phase', name: 'settings', text: 'Settings' });
  for (const s of sel.settings) {
    const targets = o.fast ? [] : await settingTargets(s.app);
    if (!targets.length || /sign in|by hand|enter(ed)? again|set by hand/i.test(s.how)) plan.userSteps.push(`${s.app}: ${s.how}`);
    for (const t of targets) {
      if (!existsSync(t.path)) { plan.warnings.push(`${s.app}: ${t.path} not found`); continue; }
      const covered = plan.units.some((u) => (u.kind === 'loose' ? norm(w.dirname(t.path)).toLowerCase() === u.path.toLowerCase() && t.kind === 'file' : u.kind !== 'setting' && isInside(t.path, u.path) && !u.dropped?.some((/** @type {string} */ d) => isInside(t.path, d))));
      plan.settings.push({ app: s.app, path: norm(t.path), kind: t.kind, covered });
      if (!covered) await addCopy(plan, t.path, 'setting', outExclude, rules, clientData, s.app);
    }
  }

  if (!o.fast) {
    emit({ type: 'phase', name: 'deps', text: 'Code dependencies' });
    const roots = new Set(plan.repos.map((r) => r.path));
    for (const u of plan.units) for (const r of u.repoRoots ?? []) roots.add(r);
    const d = await scanDeps([...roots]);
    plan.deps.nodePins = d.nodePins;
    plan.deps.playwright = d.playwright;
  }

  emit({ type: 'phase', name: 'apps', text: 'Apps' });
  plan.apps = await planApps(sel.apps, plan.deps, { lookup: o.appLookup !== false && !o.fast, emit });
  const mentions = (/** @type {RegExp} */ re) => sel.apps.some((a) => re.test(a.name) || re.test(a.wingetId)) || sel.settings.some((s) => re.test(s.app));
  if (!o.fast && o.extensions !== false) {
    if (mentions(/vs ?code|visual ?studio ?code/i)) plan.extensions.code = await listExtensions('code');
    if (mentions(/cursor/i)) plan.extensions.cursor = await listExtensions('cursor');
  }
  for (const a of plan.apps) if (a.kind === 'own' || a.kind === 'company' || a.kind === 'byhand') plan.userSteps.push(`${a.name}: ${a.note}`);
  plan.userSteps.push('Sign in to Edge and Chrome with your account and let them sync (profiles are never copied).');
  plan.userSteps.push('Git asks you to sign in (Git Credential Manager) the first time it clones from each host.');
  if (plan.byHand.length) plan.userSteps.push(`Move the ${plan.byHand.length} secret-bearing files and folders listed under "move by hand" yourself, or create them again.`);
  if (plan.pushFirst.length) plan.userSteps.push(`Before packing, push the local work of ${plan.pushFirst.length} client repositories (listed under "push first").`);

  plan.totals = totals(plan);
  return plan;
}

/**
 * Walks one folder or file into a copy unit; repositories met inside it are checked for client remotes and passwords.
 * @param {any} plan
 * @param {string} p
 * @param {'folder'|'loose'|'setting'} kind
 * @param {string[]} exclude
 * @param {import('./rules.mjs').Rules} rules
 * @param {boolean} clientData
 * @param {string|null} app
 */
async function addCopy(plan, p, kind, exclude, rules, clientData, app) {
  const r = await walk(p, { exclude, loose: kind === 'loose' });
  if (r.missing) { plan.warnings.push(`not found, left out: ${p}`); return; }
  for (const b of r.byHand) plan.byHand.push({ ...b, group: isClientPath(b.path, rules) ? 'client' : 'data' });
  for (const e of r.errors.slice(0, 20)) plan.warnings.push(`cannot read ${e.path} (${e.why})`);
  if (r.errors.length > 20) plan.warnings.push(`${r.errors.length - 20} more unreadable paths below ${p}`);
  /** @type {Set<string>} */ const dropped = new Set();
  /** @type {Set<string>} */ const clientRepos = new Set();
  /** @type {string[]} */ const repoRoots = [];
  /** @type {string[]} */ const clientRepoRoots = [];
  for (const repo of r.repos) {
    const remotes = await remotesOf(repo);
    let gitIsFile = false;
    try { gitIsFile = (await lstat(w.join(repo, '.git'))).isFile(); } catch { /* no .git */ }
    if (remotes.some((x) => x.hasPassword)) {
      const cfg = w.join(repo, '.git', 'config');
      r.files = r.files.filter((f) => f.path.toLowerCase() !== cfg.toLowerCase());
      plan.byHand.push({ path: cfg, why: 'a remote URL holds a password: remove it (git remote set-url) and sign in through Git Credential Manager instead', group: isClientPath(repo, rules) ? 'client' : 'data' });
    }
    const client = isClientPath(repo, rules) || remotes.some((x) => isClientRemote(x.url, rules));
    if (gitIsFile || (client && remotes.length > 0 && !clientData)) {
      const info = await repoInfo(repo);
      if (info) { dropped.add(repo.toLowerCase()); await addRepo(plan, info, 'copy', [], rules, clientData); continue; }
    }
    if (client) { clientRepos.add(repo.toLowerCase()); clientRepoRoots.push(repo); }
    repoRoots.push(repo);
  }
  const keptInside = (/** @type {string} */ fp) => {
    const owners = [...dropped].filter((d) => isInside(fp, d));
    if (!owners.length) return true;
    const deepest = owners.sort((a, b) => b.length - a.length)[0];
    return repoRoots.some((k) => k.length > deepest.length && isInside(fp, k) && isInside(k, deepest));
  };
  const files = r.files.filter((f) => keptInside(f.path)).map((f) => ({
    path: f.path,
    size: f.size,
    group: isClientPath(f.path, rules) || (f.repo && clientRepos.has(f.repo.toLowerCase())) ? 'client' : 'data',
  }));
  const links = r.links.filter((l) => keptInside(l.path)).map((l) => ({ ...l, group: isClientPath(l.path, rules) ? 'client' : 'data' }));
  plan.links.push(...links);
  const bytes = files.reduce((s, f) => s + f.size, 0);
  plan.units.push({
    id: `u${plan.units.length + 1}`, path: r.root, kind: kind === 'folder' && files.length === 1 && files[0].path === r.root ? 'file' : kind, app,
    files, fileCount: files.length, bytes, skippedCount: r.skipped.length, dropped: [...dropped],
    repoRoots, clientRepoRoots,
    group: isClientPath(r.root, rules) || (files.length > 0 && files.every((f) => f.group === 'client')) ? 'client' : files.some((f) => f.group === 'client') ? 'mixed' : 'data',
  });
}

/**
 * Records one repository: clone only, or clone plus a bundle of its local work and a copy of its uncommitted files.
 * @param {any} plan
 * @param {any} info from repoInfo
 * @param {'clone'|'bundle'|'copy'} requested
 * @param {string[]} exclude
 * @param {import('./rules.mjs').Rules} rules
 * @param {boolean} clientData
 */
async function addRepo(plan, info, requested, exclude, rules, clientData) {
  const client = isClientPath(info.path, rules) || info.remotes.some((/** @type {any} */ x) => isClientRemote(x.url, rules));
  const local = info.unpushed.length + info.stashes.length + info.dirty.changed.length + info.dirty.deleted.length > 0;
  let mode = requested === 'copy' ? 'bundle' : requested;
  let note = '';
  if (client && !clientData) mode = 'clone';
  else if (requested === 'clone' && local) { mode = 'bundle'; note = 'has local work: carried as a bundle and a copy of the uncommitted files'; }
  const worktreeOf = info.isWorktree ? await mainRepoOf(info.path) : null;
  if (info.remotes.some((/** @type {any} */ x) => x.hasPassword)) {
    plan.warnings.push(`${info.path}: a remote URL holds a password; the kit records it without the password, the clone asks you to sign in`);
  }
  /** @type {{rel: string, size: number}[]} */ const changed = [];
  if (mode === 'bundle') {
    for (const rel of info.dirty.changed) {
      const abs = w.join(info.path, rel);
      if (exclude.some((x) => isInside(abs, x))) continue;
      const why = dirtyProblem(info.path, rel);
      if (why?.kind === 'secret') { plan.byHand.push({ path: abs, why: why.why, group: client ? 'client' : 'data' }); continue; }
      if (why) continue;
      let st;
      try { st = await lstat(abs); } catch { continue; }
      if (st.isDirectory()) { plan.warnings.push(`untracked folder (a nested repository?) not carried: ${abs}`); continue; }
      if (!st.isFile()) continue;
      changed.push({ rel, size: st.size });
    }
  }
  const rec = {
    id: `r${plan.repos.length + 1}`,
    path: info.path,
    mode,
    requested,
    note,
    client,
    group: client ? 'client' : 'data',
    origin: info.origin,
    remotes: info.remotes.map((/** @type {any} */ x) => ({ name: x.name, url: x.url })),
    branch: info.branch,
    detached: info.detached,
    head: info.head,
    branches: info.branches,
    unpushed: info.unpushed.length,
    unpushedList: info.unpushed.slice(0, 20),
    stashes: info.stashes.map((/** @type {any} */ s) => ({ ...s })),
    dirty: mode === 'bundle' ? { changed, deleted: info.dirty.deleted } : { changed: [], deleted: [] },
    dirtyCount: info.dirty.changed.length + info.dirty.deleted.length,
    worktreeOf,
    bytes: changed.reduce((s, f) => s + f.size, 0),
  };
  plan.repos.push(rec);
  if (client && !clientData && local) {
    plan.pushFirst.push({ path: info.path, origin: info.origin, branch: info.branch, unpushed: info.unpushed.length, unpushedList: info.unpushed.slice(0, 10), stashes: info.stashes.length, dirty: rec.dirtyCount });
  }
}

/** Why an uncommitted file is not carried: a secret, a regenerable folder or a Windows file. @param {string} root @param {string} rel */
export function dirtyProblem(root, rel) {
  const parts = rel.split('\\');
  let parent = root.toLowerCase();
  for (const seg of parts.slice(0, -1)) {
    const c = classifyDir(seg, parent);
    if (c) return c;
    parent = `${parent}\\${seg.toLowerCase()}`;
  }
  return classifyFile(parts[parts.length - 1], parent);
}

/** Sizes per part (data and client), from the units and the repositories' uncommitted files. @param {any} plan */
export function totals(plan) {
  const t = { data: { bytes: 0, files: 0 }, client: { bytes: 0, files: 0 } };
  for (const u of plan.units) {
    if (u.fast) { t[u.group === 'client' ? 'client' : 'data'].bytes += u.bytes; continue; }
    for (const f of u.files) { const g = f.group === 'client' ? t.client : t.data; g.bytes += f.size; g.files++; }
  }
  for (const r of plan.repos) {
    if (r.mode !== 'bundle') continue;
    const g = r.group === 'client' ? t.client : t.data;
    g.bytes += r.bytes; g.files += r.dirty.changed.length;
  }
  return { ...t, dataEstimate: estimate(t.data.bytes, plan.volumeBytes), clientEstimate: estimate(t.client.bytes, plan.volumeBytes) };
}

/**
 * The dry run's text.
 * @param {any} plan
 * @param {{all?: boolean}} [o]
 */
export function formatPlan(plan, o = {}) {
  const cap = o.all ? Infinity : 40;
  /** @type {string[]} */ const L = [];
  /** @param {string} title @param {string[]} rows */
  const section = (title, rows) => {
    L.push('', `${title} (${rows.length})`);
    if (!rows.length) { L.push('  none'); return; }
    for (const r of rows.slice(0, cap)) L.push(`  ${r}`);
    if (rows.length > cap) L.push(`  ... ${rows.length - cap} more (add --all to list them all)`);
  };
  L.push('Laptop move, dry run: what pack would do. Nothing is written, copied or changed.');
  L.push(`Selection: ${plan.selectionFile ?? '(given in code)'}${plan.savedAt ? ` (saved ${plan.savedAt})` : ''}`);
  L.push(`Client rules: ${plan.rulesFound ? plan.rulesFile : 'none found, nothing is treated as client data'}`);
  if (plan.fast) L.push('Fast mode: no folder walk, no git, no winget; sizes from the inventory where it has them.');
  section('Folders and files to copy', plan.units.map((/** @type {any} */ u) => {
    const what = u.kind === 'setting' ? `setting (${u.app})` : u.kind;
    const count = u.fileCount == null ? '' : ` ${u.fileCount} files`;
    const grp = u.group === 'client' ? ' [client part]' : u.group === 'mixed' ? ' [some files in the client part]' : '';
    return `${what.padEnd(9)} ${fmtBytes(u.bytes).padStart(9)}${count}  ${u.path}${grp}${u.skippedCount ? `  (${u.skippedCount} regenerable folders left out)` : ''}`;
  }));
  section('Repositories', plan.repos.map((/** @type {any} */ r) => {
    const how = r.mode === 'clone' ? (r.client && !plan.clientData ? 'clone only (client)' : 'clone') : 'clone + bundle';
    const bits = [r.branch ? `on ${r.branch}` : 'detached', r.unpushed ? `${r.unpushed} unpushed` : '', r.stashes.length ? `${r.stashes.length} stashes` : '', r.dirtyCount ? `${r.dirtyCount} uncommitted` : '', r.worktreeOf ? `worktree of ${r.worktreeOf}` : ''].filter(Boolean).join(', ');
    return `${how.padEnd(20)} ${r.path}  (${bits})${r.note ? `  ${r.note}` : ''}`;
  }));
  section('Push first: client repositories with local work (nothing of them goes into the bundle)', plan.pushFirst.map((/** @type {any} */ p) =>
    `${p.path}: ${[p.unpushed ? `${p.unpushed} unpushed commits` : '', p.stashes ? `${p.stashes} stashes` : '', p.dirty ? `${p.dirty} uncommitted files` : ''].filter(Boolean).join(', ')}`));
  section('Move by hand (never copied)', plan.byHand.map((/** @type {any} */ b) => `${b.path}  (${b.why})`));
  section('Links and junctions to recreate', plan.links.map((/** @type {any} */ l) => `${l.dir ? 'junction' : 'file link'}  ${l.path} -> ${l.target}`));
  section('Apps', plan.apps.map((/** @type {any} */ a) => {
    if (a.kind === 'winget') return `winget    ${a.name}  ${a.wingetId}${a.version ? ` ${a.version}` : ''}`;
    if (a.kind === 'download') return `download  ${a.name} ${a.version}  ${a.url}`;
    if (a.kind === 'npm') return `npm -g    ${a.pkg}`;
    if (a.kind === 'playwright') return `browsers  Playwright ${(a.versions ?? []).join(', ') || 'latest'}`;
    return `by hand   ${a.name}: ${a.note ?? ''}`;
  }));
  const ext = [...(plan.extensions.code ?? []).map((/** @type {string} */ x) => `code    ${x}`), ...(plan.extensions.cursor ?? []).map((/** @type {string} */ x) => `cursor  ${x}`)];
  section('Editor extensions', ext);
  section('Your own steps on the new laptop', plan.userSteps);
  section('Left out by choice', plan.skipped.map((/** @type {any} */ s) => `${s.path}  (${s.why})`));
  section('Warnings', plan.warnings);
  const t = plan.totals;
  L.push('', 'Totals');
  for (const [name, g, e] of [['data part', t.data, t.dataEstimate], ['client part', t.client, t.clientEstimate]]) {
    if (!g.bytes && !g.files) { L.push(`  ${name}: empty`); continue; }
    L.push(`  ${name}: ${fmtBytes(g.bytes)} in ${g.files} files, about ${fmtBytes(e.archive)} packed, ${e.parts} part${e.parts === 1 ? '' : 's'} of ${fmtBytes(plan.volumeBytes)}; packing about ${fmtDuration(e.packSeconds)}, upload at 10 MB/s about ${fmtDuration(e.uploadSeconds)}, unpacking about ${fmtDuration(e.unpackSeconds)}`);
  }
  if (t.client.bytes || plan.repos.some((/** @type {any} */ r) => r.group === 'client')) L.push('  The client part belongs on the company OneDrive only.');
  L.push('  Bundles of unpushed commits are not counted (usually small).');
  return L.join('\n');
}

/** @param {string} p */
export function expandPath(p) {
  return norm(expandEnv(p));
}
