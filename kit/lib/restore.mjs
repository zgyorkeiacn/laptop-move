// restore, on the new laptop: makes sure 7-Zip is there first (the parts need it), checks the parts, unpacks them
// (7-Zip asks for the password on the console, or reads the one typed in the page through a pipe), makes the final
// folders (as administrator where needed), installs the apps one by one, clones the repositories and brings their local
// work back, puts folders and settings at their places, recreates the junctions and writes a report.
// Every command has a time limit (--step-timeout): one that is not done by then is stopped, logged and skipped, and the
// restore goes on. Everything is logged to <work>\restore-log.txt as it happens; <work>\restore-status.json tells the
// dashboards where the restore stands.
// It never deletes a file it did not bring and never replaces one, except settings (and every file with --overwrite):
// a replaced file is first copied to <work>\replaced.
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveRel, driveOf, isInside, mapPath, norm } from './paths.mjs';
import { check7z, extractArgs, exitMeaning, run7z, lastLines } from './sevenzip.mjs';
import { wingetAvailable, wingetInstall, wingetCommand, installMeaning } from './winget.mjs';
import { installApps, installFromLink, installExtensions, cmdLine, is7zip, lateText, TIMED_OUT } from './apps.mjs';
import { refreshPath, openFile } from './env.mjs';
import { gitLive, gitHere, applyRepoState, fetchBundle, dropTempRefs } from './git.mjs';
import { planLinks, createLink } from './links.mjs';
import { htmlReport } from './report.mjs';
import { RATES } from './plan.mjs';
import { run, runLive, onCommand, fmtBytes, fmtDuration, fmtLimit, sha256File, STEP_TIMEOUT } from './util.mjs';
import { targetFolders, prepareFolders } from './targets.mjs';
import { createStatus, openLog, RESTORE_PHASES, clock } from './status.mjs';
import { openDashboardWindow } from './dashboard.mjs';

const w = path.win32;

/** @typedef {{name: string, status: string, detail: string}} Row */

/**
 * Which paths of the unpacked tree a unit leaves alone: whatever lies inside a repository or stage folder (skips),
 * unless it lies inside a deeper keep that is itself inside that skip.
 * @param {string[]} skips @param {string[]} keeps
 * @returns {(p: string) => boolean}
 */
export function unitSkipper(skips, keeps) {
  return (p) => skips.some((s) => isInside(p, s) && !keeps.some((k) => k.length > s.length && isInside(p, k) && isInside(k, s)));
}

/** The default work folder (unpacked data, downloads, replaced files, the report). */
export function defaultWork() {
  return w.join(`${process.env.SystemDrive ?? 'C:'}\\`, 'LaptopMove', 'restore');
}

/** The folder holding the parts: the kit's folder or its parent, whichever has them. @param {string} kitDir */
export function defaultFrom(kitDir) {
  for (const d of [kitDir, w.dirname(kitDir)]) {
    if (existsSync(w.join(d, 'SHA256SUMS.txt'))) return d;
  }
  return kitDir;
}

/**
 * Reads the manifest: the kit's own copy first, else the one next to the parts.
 * @param {string|undefined} kitDir
 * @param {string|undefined} from
 */
export async function loadManifest(kitDir, from) {
  const files = [kitDir && w.join(kitDir, 'manifest.json'), from && w.join(from, 'manifest.json')].filter(Boolean);
  for (const f of /** @type {string[]} */ (files)) {
    if (!existsSync(f)) continue;
    const m = JSON.parse((await readFile(f, 'utf8')).trim());
    if (m?.kind !== 'laptop-move') throw new Error(`${f} is not a laptop move manifest`);
    return { manifest: m, file: f };
  }
  throw new Error('manifest.json not found: run kit.mjs from the unpacked laptop-move-kit.zip, or name the folder of the parts with --from');
}

/**
 * Checks that every part is there with its size, and with hash its SHA-256.
 * @param {any} manifest
 * @param {string} from
 * @param {{hash?: boolean, skipClient?: boolean, emit?: (e: any) => void}} o
 */
export async function checkParts(manifest, from, o = {}) {
  const emit = o.emit ?? (() => {});
  const total = manifest.archives.reduce((/** @type {number} */ s, /** @type {any} */ a) => s + a.parts.length, 0);
  let n = 0;
  /** @type {any[]} */ const archives = [];
  /** @type {Row[]} */ const rows = [];
  for (const a of manifest.archives) {
    if (a.group === 'client' && o.skipClient) {
      for (const p of a.parts) rows.push({ name: p.file, status: 'skipped', detail: '--skip-client' });
      archives.push({ ...a, status: 'skipped' });
      continue;
    }
    let status = 'ok';
    for (const p of a.parts) {
      n++;
      const f = w.join(from, p.file);
      emit({ type: 'progress', done: n, total, text: `checking ${p.file}` });
      if (!existsSync(f)) { rows.push({ name: p.file, status: 'missing', detail: f }); status = 'missing'; continue; }
      const size = (await lstat(f)).size;
      if (size !== p.size) { rows.push({ name: p.file, status: 'damaged', detail: `${fmtBytes(size)} instead of ${fmtBytes(p.size)}: download it again` }); if (status === 'ok') status = 'damaged'; continue; }
      if (o.hash && (await sha256File(f)) !== p.sha256) { rows.push({ name: p.file, status: 'damaged', detail: 'the SHA-256 differs: download it again' }); if (status === 'ok') status = 'damaged'; continue; }
      rows.push({ name: p.file, status: 'ok', detail: `${fmtBytes(p.size)}${o.hash ? ', SHA-256 checked' : ''}` });
    }
    archives.push({ ...a, status });
  }
  return { archives, rows };
}

/**
 * 7-Zip 26.03 or newer, before anything else (the parts cannot be unpacked without it): winget first (its own source
 * only), then the installer link recorded on the old laptop (checksum and signature checked), each within the limit.
 * Stops the restore when neither works.
 * @param {any} manifest
 * @param {string} work
 * @param {(e: any) => void} emit
 * @param {number} limit
 * @returns {Promise<{sz: {ok: boolean, exe: string, version: string|null}, row: Row}>}
 */
export async function ensure7z(manifest, work, emit, limit) {
  let sz = await check7z();
  if (sz.ok) return { sz, row: { name: '7-Zip', status: 'installed already', detail: `${sz.version}, ${sz.exe}` } };
  emit({ type: 'step', text: `${sz.why}: installing 7-Zip first (the parts need it)` });
  /** @type {string[]} */ const tried = [];
  if (await wingetAvailable()) {
    const r = await wingetInstall('7zip.7zip', { timeout: limit });
    tried.push(`winget: ${r.timedOut ? `no answer after ${fmtLimit(limit)}, stopped` : installMeaning(r.code).text}`);
    sz = await check7z();
  } else tried.push('winget is missing');
  const rec = (manifest.apps ?? []).find(is7zip);
  if (!sz.ok && rec?.url) {
    emit({ type: 'step', text: '7-Zip: trying the installer link recorded on the old laptop' });
    const r = await installFromLink(rec, work, { timeout: limit });
    tried.push(`the recorded link: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
    sz = await check7z();
  }
  if (!sz.ok) throw new Error(`${sz.why} (${tried.join('; ')}): install 7-Zip 26.03 or newer (Software Center, or ${wingetCommand('7zip.7zip')}), then run restore again`);
  emit({ type: 'step', text: `7-Zip ${sz.version}: installed` });
  return { sz, row: { name: '7-Zip', status: 'installed before unpacking', detail: tried.join('; ') } };
}

/**
 * How long one archive may take to unpack: six times the estimate at the planned rate, plus 15 minutes for typing the
 * password, and never less than one step.
 * @param {{parts: {size: number}[]}} a @param {number} step
 */
export function unpackLimit(a, step) {
  const bytes = a.parts.reduce((s, p) => s + (Number(p.size) || 0), 0);
  return Math.max(step, Math.round((bytes / RATES.unpackBps) * 6 * 1000) + 15 * 60 * 1000);
}

/**
 * Unpacks one split archive into <work>\unpacked\<name>. On the console a wrong password may be typed again (three
 * tries). With a password (from the user interface) 7-Zip reads it from a pipe, once: a wrong one stops the restore.
 * 7-Zip is stopped when it takes longer than limit.
 * @param {any} a
 * @param {string} from
 * @param {string} work
 * @param {string} exe
 * @param {boolean} encrypted
 * @param {(e: any) => void} emit
 * @param {string|null} [password]
 * @param {number} [limit]
 * @returns {Promise<{ok: boolean, dir: string, why?: string, warning?: string|null, again?: boolean, timedOut?: boolean}>}
 */
export async function unpack(a, from, work, exe, encrypted, emit, password = null, limit = unpackLimit(a, STEP_TIMEOUT)) {
  const dir = w.join(work, 'unpacked', a.name);
  const marker = w.join(work, 'unpacked', `${a.name}.done`);
  if (existsSync(marker)) return { ok: true, dir, again: true };
  const late = { ok: false, dir, why: `7-Zip was not done after ${fmtLimit(limit)}: stopped`, timedOut: true };
  if (password !== null) {
    emit({ type: 'progress', done: 0, total: 100, text: `unpacking ${a.name}`, part: a.name });
    const r = await run7z(exe, extractArgs(w.join(from, a.parts[0].file), dir), { password: encrypted ? password : '', timeout: limit,
      onPercent: (pct) => emit({ type: 'progress', done: pct, total: 100, text: `unpacking ${a.name}`, part: a.name }) });
    if (r.timedOut) return late;
    if (r.code === 0 || r.code === 1) {
      await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
      return { ok: true, dir, warning: r.code === 1 ? exitMeaning(1) : null };
    }
    if (r.code === 2 && encrypted) return { ok: false, dir, why: 'wrong password or a damaged part: type the password again and run restore again (it continues where it stopped)' };
    return { ok: false, dir, why: `${exitMeaning(r.code)}${lastLines(r.out) ? ` (${lastLines(r.out)})` : ''}` };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (encrypted) emit({ type: 'step', text: `7-Zip asks for the password of ${a.name} now, in this console window (the one you typed when packing)` });
    const r = await runLive(exe, extractArgs(w.join(from, a.parts[0].file), dir), { timeout: limit });
    if (r.timedOut) return late;
    if (r.code === 0 || r.code === 1) {
      await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
      return { ok: true, dir, warning: r.code === 1 ? exitMeaning(1) : null };
    }
    if (r.code === 2 && encrypted && attempt < 3) { emit({ type: 'warn', text: `${a.name}: wrong password or a damaged part; try again` }); continue; }
    return { ok: false, dir, why: exitMeaning(r.code) };
  }
  return { ok: false, dir, why: 'three wrong passwords' };
}

/**
 * Moves an unpacked file or folder tree into place. Never enters a link, never replaces a file unless overwrite,
 * which first copies the replaced file to backupDir\<drive>\<path>.
 * @param {string} src
 * @param {string} dest
 * @param {{overwrite?: boolean, loose?: boolean, backupDir: string, skip?: (p: string) => boolean, skipInside?: (p: string) => boolean}} o
 * @param {{moved: number, replaced: number, conflicts: string[], errors: string[]}} [acc]
 */
export async function moveTree(src, dest, o, acc = { moved: 0, replaced: 0, conflicts: [], errors: [] }) {
  if (o.skip?.(src)) return acc;
  let st;
  try { st = await lstat(src); } catch { return acc; }
  if (st.isSymbolicLink()) return acc;
  /** @type {import('node:fs').Stats|null} */ let dst = null;
  try { dst = await lstat(dest); } catch { /* free */ }
  if (st.isDirectory()) {
    if (dst && (dst.isSymbolicLink() || !dst.isDirectory())) { acc.conflicts.push(dest); return acc; }
    if (!dst && !o.loose && !o.skipInside?.(src)) {
      try {
        await mkdir(w.dirname(dest), { recursive: true });
        await rename(src, dest);
        acc.moved++;
        return acc;
      } catch { /* another drive or a locked file: entry by entry */ }
    }
    try { await mkdir(dest, { recursive: true }); } catch (e) { acc.errors.push(`${dest}: ${/** @type {any} */ (e).message}`); return acc; }
    for (const name of await readdir(src)) {
      const s = w.join(src, name);
      if (o.loose) {
        const ls = await lstat(s).catch(() => null);
        if (!ls?.isFile()) continue;
      }
      await moveTree(s, w.join(dest, name), { ...o, loose: false }, acc);
    }
    return acc;
  }
  if (!st.isFile()) return acc;
  try {
    if (dst) {
      if (!o.overwrite || !dst.isFile()) { acc.conflicts.push(dest); return acc; }
      const { drive, rel } = archiveRel(dest);
      const b = w.join(o.backupDir, drive, rel);
      await mkdir(w.dirname(b), { recursive: true });
      await copyFile(dest, b);
      acc.replaced++;
    }
    await mkdir(w.dirname(dest), { recursive: true });
    try { await rename(src, dest); } catch { await copyFile(src, dest); await unlink(src).catch(() => {}); }
    acc.moved++;
  } catch (e) {
    acc.errors.push(`${dest}: ${/** @type {any} */ (e).message}`);
  }
  return acc;
}

/**
 * Everything restore needs to know about the unpacked parts.
 * @param {{name: string, group: string, drive: string, dir: string, stageRel: string|null}[]} roots
 */
function unpackedView(roots) {
  return {
    roots,
    /** @param {string} drive */
    ofDrive: (drive) => roots.filter((r) => r.drive === drive),
    /** @param {string} group */
    stage: (group) => {
      const r = roots.find((x) => x.group === group && x.stageRel);
      return r ? w.join(r.dir, /** @type {string} */ (r.stageRel)) : null;
    },
  };
}

/**
 * Lays a repository's uncommitted files over its work tree and removes the files deleted on the old laptop.
 * @param {any} rec
 * @param {string} dest
 * @param {ReturnType<typeof unpackedView>} up
 * @param {string[]} problems
 */
async function overlayDirty(rec, dest, up, problems) {
  const { drive, rel } = archiveRel(rec.path);
  let missing = 0;
  for (const d of rec.dirty?.changed ?? []) {
    const src = up.ofDrive(drive).map((r) => w.join(r.dir, rel, d.rel)).find((f) => existsSync(f));
    if (!src) { missing++; continue; }
    const to = w.join(dest, d.rel);
    try { await mkdir(w.dirname(to), { recursive: true }); await copyFile(src, to); } catch (e) { problems.push(`${d.rel}: ${/** @type {any} */ (e).message}`); }
  }
  for (const r of rec.dirty?.deleted ?? []) await unlink(w.join(dest, r)).catch(() => {});
  if (missing) problems.push(`${missing} uncommitted files were not in the unpacked parts`);
}

/**
 * What restoring a repository needs: the path mapping, the unpacked parts, the events and the step limit.
 * @typedef {{mapping: any, up: ReturnType<typeof unpackedView>, emit: (e: any) => void, timeout: number}} RepoCtx
 */

/**
 * git clone into a missing or empty folder, within the step limit. A clone stopped at its limit is removed again (all
 * of it came from that clone): the folder is left as it was, missing or empty, so the next restore can clone it again.
 * @param {string} dest @param {string[]} args @param {RepoCtx} ctx
 */
async function cloneInto(dest, args, ctx) {
  const had = existsSync(dest);
  await mkdir(w.dirname(dest), { recursive: true });
  const r = await gitLive(w.dirname(dest), args, { timeout: ctx.timeout });
  if (r.timedOut) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    if (had) await mkdir(dest, { recursive: true }).catch(() => {});
  }
  return r;
}

/** The detail of a clone stopped at its limit. @param {string} origin @param {string} dest @param {number} limit */
function cloneLate(origin, dest, limit) {
  return lateText(limit, `a sign-in window may have been waiting: clone ${origin} into ${dest} yourself, or run restore again`);
}

/**
 * Clones one repository and brings its local work back.
 * @param {any} rec
 * @param {RepoCtx} ctx
 * @returns {Promise<Row & {dest: string}>}
 */
async function restoreRepo(rec, ctx) {
  const dest = mapPath(rec.path, ctx.mapping);
  const row = (/** @type {string} */ status, /** @type {string} */ detail) => ({ name: rec.path, dest, status, detail });
  if (!rec.origin) return row('by hand', 'no remote was recorded');
  const originName = rec.remotes?.find((/** @type {any} */ r) => r.url === rec.origin)?.name ?? 'origin';
  /** @type {string[]} */ const notes = [];
  /** @type {string[]} */ const problems = [];
  if (existsSync(w.join(dest, '.git'))) notes.push('a repository was there already: not cloned again');
  else {
    if (existsSync(dest) && (await readdir(dest)).length) return row('by hand', `${dest} is not empty and not a repository: clone ${rec.origin} yourself`);
    ctx.emit({ type: 'step', text: `git clone ${rec.origin} (Git Credential Manager may ask you to sign in)` });
    const c = await cloneInto(dest, ['clone', '--recurse-submodules', '-o', originName, rec.origin, dest], ctx);
    if (c.timedOut) return row(TIMED_OUT, cloneLate(rec.origin, dest, ctx.timeout));
    if (c.code !== 0) return row('failed', `git clone exit ${c.code}`);
    notes.push('cloned');
    for (const r of rec.remotes ?? []) {
      if (r.name === originName) continue;
      await gitHere(dest, ['remote', 'add', r.name, r.url]);
      const f = await gitLive(dest, ['fetch', r.name], { timeout: ctx.timeout });
      if (f.timedOut) problems.push(`remote ${r.name}: fetch stopped after ${fmtLimit(ctx.timeout)}`);
      else if (f.code !== 0) problems.push(`remote ${r.name}: fetch failed`);
    }
  }
  const stage = ctx.up.stage(rec.group);
  const bundle = rec.bundle && stage ? w.join(stage, rec.bundle) : null;
  if (rec.bundle && !bundle) problems.push('its bundle is in a part that was not unpacked');
  const st = await applyRepoState({ dest, bundle, rec, patchDir: stage });
  notes.push(...st.notes);
  problems.push(...st.problems);
  if (rec.mode === 'bundle') await overlayDirty(rec, dest, ctx.up, problems);
  return problems.length ? row('warning', [...notes, ...problems].join('; ')) : row('restored', notes.join('; '));
}

/**
 * Brings back a worktree: its main repository first (copied or cloned), then git worktree add.
 * @param {any} rec
 * @param {RepoCtx} ctx
 * @returns {Promise<Row & {dest: string}>}
 */
async function restoreWorktree(rec, ctx) {
  const dest = mapPath(rec.path, ctx.mapping);
  const row = (/** @type {string} */ status, /** @type {string} */ detail) => ({ name: rec.path, dest, status, detail });
  const main = rec.worktreeOf ? mapPath(rec.worktreeOf, ctx.mapping) : null;
  if (!main) return row('by hand', 'its main repository is not known');
  /** @type {string[]} */ const problems = [];
  if (!existsSync(w.join(main, '.git'))) {
    if (!rec.origin) return row('by hand', `its main repository ${main} is missing`);
    if (existsSync(main) && (await readdir(main)).length) return row('by hand', `${main} is not empty and not a repository`);
    const c = await cloneInto(main, ['clone', '--recurse-submodules', rec.origin, main], ctx);
    if (c.timedOut) return row(TIMED_OUT, `the main repository: ${cloneLate(rec.origin, main, ctx.timeout)}`);
    if (c.code !== 0) return row('failed', `git clone of the main repository exit ${c.code}`);
  }
  if (existsSync(dest) && (await readdir(dest)).length) return row('by hand', `${dest} is not empty: git worktree add needs an empty folder`);
  const stage = ctx.up.stage(rec.group);
  if (rec.bundle && stage) {
    const f = await fetchBundle(main, w.join(stage, rec.bundle), !!rec.detached);
    if (f.code !== 0) problems.push(`bundle not applied: ${f.stderr.trim().split(/\r?\n/).pop()}`);
  }
  await gitHere(main, ['worktree', 'prune']);
  /** @type {string[]} */ let args;
  if (rec.branch) {
    const has = (await gitHere(main, ['rev-parse', '--verify', '-q', `refs/heads/${rec.branch}`])).code === 0;
    if (!has) {
      const sha = rec.branches?.find((/** @type {any} */ b) => b.name === rec.branch)?.sha ?? rec.head;
      const b = await gitHere(main, ['branch', rec.branch, sha]);
      if (b.code !== 0) { await dropTempRefs(main); return row('failed', `branch ${rec.branch}: commit ${String(sha).slice(0, 9)} is missing`); }
    }
    args = ['worktree', 'add', dest, rec.branch];
  } else {
    args = ['worktree', 'add', '--detach', dest, rec.head];
  }
  await mkdir(w.dirname(dest), { recursive: true });
  const r = await gitHere(main, args);
  await dropTempRefs(main);
  if (r.code !== 0) return row('failed', `git worktree add: ${r.stderr.trim().split(/\r?\n/).pop()}`);
  if (rec.mode === 'bundle') await overlayDirty(rec, dest, ctx.up, problems);
  return problems.length ? row('warning', problems.join('; ')) : row('restored', `worktree of ${main}`);
}

/** Folders that hold a package-lock.json, for npm ci. @param {any} manifest @param {any} mapping @param {string|string[]} want */
function npmCiDirs(manifest, mapping, want) {
  const all = [...manifest.repos.map((/** @type {any} */ r) => r.path), ...manifest.units.flatMap((/** @type {any} */ u) => u.repoRoots ?? [])];
  const list = want === 'all' ? all : (Array.isArray(want) ? want : String(want).split(',')).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  return list.map((p) => mapPath(p, mapping)).filter((d) => {
    const k = d.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return existsSync(w.join(d, 'package-lock.json'));
  });
}

/** Free bytes on the drive of a path, or null. @param {string} p */
async function freeOn(p) {
  try { const s = await statfs(`${driveOf(p)}:\\`); return s.bavail * s.bsize; } catch { return null; }
}

/**
 * The common start of restore and its dry run.
 * @param {any} o
 */
async function open(o) {
  const kitDir = o.kitDir ? norm(o.kitDir) : undefined;
  const from = norm(o.from ?? (kitDir ? defaultFrom(kitDir) : process.cwd()));
  const { manifest } = await loadManifest(kitDir, from);
  const work = norm(o.work ?? defaultWork());
  const mapping = {
    oldProfile: manifest.oldProfile,
    newProfile: norm(process.env.USERPROFILE ?? os.homedir()),
    targetRoot: o.targetRoot ? norm(o.targetRoot) : undefined,
  };
  return { kitDir, from, manifest, work, mapping };
}

/**
 * What restore would do. Reads the parts' sizes only: nothing is unpacked, installed or changed.
 * @param {any} o {kitDir, from, work, targetRoot, skipApps, skipClient, npmCi, all}
 */
export async function restoreDryRun(o) {
  const { from, manifest, work, mapping } = await open(o);
  const cap = o.all ? Infinity : 40;
  /** @type {string[]} */ const L = [];
  /** @type {string[]} */ const problems = [];
  const section = (/** @type {string} */ title, /** @type {string[]} */ rows) => {
    L.push('', `${title} (${rows.length})`);
    if (!rows.length) { L.push('  none'); return; }
    for (const r of rows.slice(0, cap)) L.push(`  ${r}`);
    if (rows.length > cap) L.push(`  ... ${rows.length - cap} more (add --all to list them all)`);
  };
  L.push('Laptop move, dry run of restore: what it would do. Nothing is unpacked, installed or changed.');
  L.push(`Packed on ${manifest.host}, ${manifest.createdAt}${manifest.encrypted ? ', encrypted (7-Zip asks for the password)' : ', NOT encrypted'}`);
  L.push(`Parts folder: ${from}`);
  L.push(`Work folder: ${work}`);
  L.push(`User folder: ${manifest.oldProfile} -> ${mapping.newProfile}${mapping.targetRoot ? ` (trial: everything below ${mapping.targetRoot})` : ''}`);
  const step = o.stepTimeout ?? STEP_TIMEOUT;
  L.push(`Time limit of one step (an install, a clone, a download): ${fmtLimit(step)} (--step-timeout <minutes>); a step not done by then is stopped, logged and skipped`);
  L.push(`Log: ${w.join(work, 'restore-log.txt')}; dashboard: ${o.dashboard === false ? 'off (--no-dashboard)' : 'a console window of its own (--no-dashboard leaves it closed)'}`);
  const sz = await check7z();
  L.push('', `7-Zip, first of all: ${sz.ok ? `${sz.version}, ok` : `${sz.why}: restore installs it before anything else (winget, else the recorded installer)`}`);
  const parts = await checkParts(manifest, from, { skipClient: o.skipClient });
  section('Parts', parts.rows.map((r) => `${r.status.padEnd(8)} ${r.name}  ${r.detail}`));
  for (const a of parts.archives) {
    if (a.status === 'ok' || a.status === 'skipped') continue;
    if (a.group === 'client') L.push(`  The client part ${a.name} is ${a.status}: restore would go on without it.`);
    else problems.push(`data part ${a.name} is ${a.status}`);
  }
  const bytes = manifest.totals.data + (o.skipClient ? 0 : manifest.totals.client);
  const free = await freeOn(work);
  L.push(`Unpacked size about ${fmtBytes(bytes)}; free on ${driveOf(work)}: ${free == null ? '?' : fmtBytes(free)}; unpacking about ${fmtDuration(bytes / RATES.unpackBps)}`);
  if (free != null && free < bytes * 1.3) problems.push(`not enough free space on ${driveOf(work)}: (about ${fmtBytes(bytes * 1.3)} needed)`);
  const folders = targetFolders(manifest, mapping);
  const missing = folders.filter((f) => !existsSync(f));
  section('Target folders, made first (by prepare-folders.ps1; Windows asks for administrator rights once if one needs them)', folders.map((f) => `${existsSync(f) ? 'there   ' : 'make    '} ${f}`));
  if (missing.length) L.push(`  ${missing.length} of ${folders.length} are not there yet.${manifest.hasClientPart ? ' The client part\'s folders are added after unpacking.' : ''}`);
  if (!o.skipApps) {
    const apps = await installApps((manifest.apps ?? []).filter((/** @type {any} */ a) => !is7zip(a)), { work, dryRun: true });
    section('Apps, one by one', apps.map((a) => `${a.status.padEnd(14)} ${a.name}  ${a.how}${a.detail ? ` ${a.detail}` : ''}`));
  } else L.push('', 'Apps: skipped (--skip-apps)');
  const repos = manifest.repos;
  section('Repositories', repos.map((/** @type {any} */ r) => `${r.worktreeOf ? 'worktree' : r.mode === 'bundle' ? 'clone + local work' : 'clone'}  ${r.origin ?? '(no remote)'} -> ${mapPath(r.path, mapping)}`));
  section('Folders, files and settings', [...manifest.units].sort((a, b) => b.path.length - a.path.length).map((/** @type {any} */ u) =>
    `${(u.kind === 'setting' ? `setting (${u.app}), replaces` : u.kind).padEnd(9)} ${fmtBytes(u.bytes).padStart(9)}  ${u.path} -> ${mapPath(u.path, mapping)}`));
  if (manifest.hasClientPart) L.push(o.skipClient ? '  The client part is skipped (--skip-client).' : '  The client part\'s folders and repositories are listed after unpacking: their list is inside the encrypted part.');
  section('Links and junctions', planLinks(manifest.links, mapping).map((l) => l.cmd.text));
  const want = o.npmCi ?? (manifest.deps?.npmCi?.length ? manifest.deps.npmCi : null);
  L.push('', want ? `npm ci --install-links: in the restored repositories with a package-lock.json (${want === 'all' ? 'all' : want})` : 'npm ci: not asked (add --npm-ci all, or --npm-ci <folder>,<folder>)');
  const ext = ['code', 'cursor'].map((e) => [e, manifest.extensions?.[e]?.length ?? 0]).filter(([, n]) => n);
  L.push(`Editor extensions: ${ext.length ? ext.map(([e, n]) => `${e} ${n}`).join(', ') : 'none'}`);
  section('Move by hand (not in the parts)', manifest.byHand.map((/** @type {any} */ b) => `${b.path}  (${b.why})`));
  section('Your own steps', manifest.userSteps);
  section('Warnings from packing', manifest.warnings);
  L.push('', problems.length ? `Restore would stop here:\n${problems.map((p) => `  - ${p}`).join('\n')}` : 'Checks: restore can start.');
  return { text: L.join('\n'), problems, manifest };
}

/**
 * Restores everything on the new laptop. Every event also goes to the log and the status file, every command the kit
 * starts is logged with how it ended, and the dashboard window opens (o.dashboard === 'window').
 * @param {any} o {kitDir, from, work, targetRoot, overwrite, skipApps, skipClient, npmCi, open, stepTimeout, dashboard, getPassword}
 * @param {(e: any) => void} [emit]
 */
export async function restore(o, emit = () => {}) {
  const opened = await open(o);
  const { work, mapping, manifest } = opened;
  await mkdir(work, { recursive: true });
  const step = o.stepTimeout ?? STEP_TIMEOUT;
  const logFile = w.join(work, 'restore-log.txt');
  const statusFile = w.join(work, 'restore-status.json');
  const log = openLog(logFile, [
    `Laptop move restore, process ${process.pid}; packed on ${manifest.host}, ${manifest.createdAt}`,
    `parts: ${opened.from}; work: ${work}${mapping.targetRoot ? `; trial below ${mapping.targetRoot}` : ''}; step limit ${fmtLimit(step)}`,
  ]);
  const status = createStatus({
    file: statusFile,
    phases: RESTORE_PHASES,
    meta: { log: logFile, work, target: mapping.targetRoot ?? null, stepLimit: step },
    onSnapshot: (s) => emit({ type: 'status', status: s }),
  });
  /** @param {any} e */
  const tee = (e) => { log.event(e); status.apply(e); emit(e); };
  const stopListening = onCommand((e) => { log.event(e); status.apply(e); });

  // The dashboard window. On the console 7-Zip asks for the password in this window: a new window would take the
  // keyboard from it, so the dashboard then opens once the parts are unpacked.
  let dashOpen = o.dashboard !== 'window' || !o.kitDir;
  const openDash = () => {
    if (dashOpen) return;
    dashOpen = true;
    if (openDashboardWindow({ kitDir: o.kitDir, statusFile })) tee({ type: 'step', text: 'The dashboard is open in a window of its own (closing it never stops the restore; kit.mjs dashboard opens it again)' });
    else tee({ type: 'warn', text: `the dashboard window did not open: run "kit.mjs dashboard --work ${work}" in another window` });
  };
  const asks = !!manifest.encrypted && typeof o.getPassword !== 'function'
    && manifest.archives.some((/** @type {any} */ a) => !(o.skipClient && a.group === 'client') && !existsSync(w.join(work, 'unpacked', `${a.name}.done`)));
  if (asks && !dashOpen) tee({ type: 'step', text: 'The dashboard window opens once the parts are unpacked: 7-Zip asks for the password in this window first' });
  else openDash();

  try {
    const r = await runRestore(o, opened, tee, { step, status, logFile, onUnpacked: openDash });
    status.finish({ ok: true, report: r.report });
    return r;
  } catch (e) {
    const msg = String(/** @type {any} */ (e)?.message ?? e);
    log.line(`STOPPED: ${msg}`);
    status.finish({ ok: false, error: msg });
    throw e;
  } finally {
    stopListening();
  }
}

/**
 * The steps of a restore, in their order.
 * @param {any} o
 * @param {Awaited<ReturnType<typeof open>>} opened
 * @param {(e: any) => void} emit
 * @param {{step: number, status: ReturnType<typeof createStatus>, logFile: string, onUnpacked: () => void}} x
 */
async function runRestore(o, opened, emit, x) {
  const { from, manifest, work, mapping } = opened;
  const { step, status } = x;
  const backupDir = w.join(work, 'replaced');
  /** @type {Record<string, Row[]>} */
  const R = { parts: [], targets: [], apps: [], repos: [], units: [], links: [], npm: [], extensions: [], conflicts: [] };
  /** @type {string[]} */ const warnings = [...manifest.warnings];
  const byHand = [...manifest.byHand];
  /** One result: into its list for the report, and an item event for the log and the dashboards. @param {string} section @param {Row} row @param {Row[]} [list] */
  const put = (section, row, list = R[section]) => {
    list.push(row);
    emit({ type: 'item', section, name: row.name, status: row.status, detail: row.detail });
  };

  emit({ type: 'phase', name: '7zip', text: '7-Zip first (the parts need it)' });
  const seven = await ensure7z(manifest, work, emit, step);
  const sz = seven.sz;
  put('sevenzip', seven.row, R.apps);

  emit({ type: 'phase', name: 'check', text: 'Checking the parts' });
  status.setTotal('parts', manifest.archives.reduce((/** @type {number} */ s, /** @type {any} */ a) => s + a.parts.length, 0));
  const parts = await checkParts(manifest, from, { hash: true, skipClient: o.skipClient, emit });
  for (const r of parts.rows) put('parts', r);
  for (const a of parts.archives) {
    if (a.status === 'ok' || a.status === 'skipped' || a.group === 'client') continue;
    throw new Error(`data part ${a.name} is ${a.status}: put every part into ${from} (download it again), then run restore again`);
  }
  for (const a of parts.archives) if (a.group === 'client' && a.status !== 'ok' && a.status !== 'skipped') warnings.push(`client part ${a.name} is ${a.status}: restored without it`);
  const bytes = manifest.totals.data + (o.skipClient ? 0 : manifest.totals.client);
  const free = await freeOn(work);
  if (free != null && free < bytes * 1.3) throw new Error(`not enough free space on ${driveOf(work)}: (${fmtBytes(free)} free, about ${fmtBytes(bytes * 1.3)} needed)`);

  emit({ type: 'phase', name: 'unpack', text: 'Unpacking' });
  // With getPassword (the user interface), 7-Zip runs without a console and reads the password from a pipe.
  /** @type {string|null} */ let password = null;
  if (typeof o.getPassword === 'function') {
    password = manifest.encrypted ? String((await o.getPassword()) ?? '') : '';
    if (manifest.encrypted && !password) throw new Error('no password was given: type the password you chose when packing, then run restore again');
  }
  /** @type {{name: string, group: string, drive: string, dir: string, stageRel: string|null}[]} */
  const roots = [];
  const todo = parts.archives.filter((a) => a.status === 'ok').sort((a, b) => (a.group === b.group ? 0 : a.group === 'data' ? -1 : 1));
  status.setTotal('unpack', todo.length);
  for (const a of todo) {
    const limit = unpackLimit(a, step);
    emit({ type: 'step', text: `${a.name}: ${a.parts.length} part${a.parts.length === 1 ? '' : 's'} (at most ${fmtLimit(limit)})` });
    const u = await unpack(a, from, work, sz.exe, !!manifest.encrypted, emit, password, limit);
    if (!u.ok) {
      put('unpack', { name: a.name, status: u.timedOut ? TIMED_OUT : 'failed', detail: String(u.why ?? '') }, R.parts);
      if (a.group === 'client') { warnings.push(`client part ${a.name}: ${u.why}; restored without it`); continue; }
      throw new Error(`unpacking ${a.name} failed: ${u.why}. Run restore again; it continues where it stopped.`);
    }
    if (u.warning) warnings.push(`${a.name}: 7-Zip ${u.warning}`);
    put('unpack', { name: a.name, status: u.again ? 'unpacked before' : 'unpacked', detail: u.warning ? `7-Zip ${u.warning}` : '' }, R.parts);
    roots.push({ name: a.name, group: a.group, drive: a.drive, dir: u.dir, stageRel: a.stageRel ?? null });
  }
  const up = unpackedView(roots);
  x.onUnpacked();

  const clientStage = up.stage('client');
  if (clientStage && existsSync(w.join(clientStage, 'client-manifest.json'))) {
    const cm = JSON.parse((await readFile(w.join(clientStage, 'client-manifest.json'), 'utf8')).trim());
    manifest.units.push(...(cm.units ?? []));
    manifest.repos.push(...(cm.repos ?? []));
    manifest.links.push(...(cm.links ?? []));
    byHand.push(...(cm.byHand ?? []));
    warnings.push(...(cm.warnings ?? []));
  }

  // The final folders, before anything is cloned or moved into them (as administrator where the user may not make them).
  emit({ type: 'phase', name: 'targets', text: 'Making the target folders' });
  const folders = targetFolders(manifest, mapping);
  status.setTotal('targets', folders.length);
  const prep = await prepareFolders(folders, { work, timeout: step, emit });
  for (const r of prep.rows) put('targets', r);
  if (prep.failed.length) warnings.push(`${prep.failed.length} target folder${prep.failed.length === 1 ? '' : 's'} could not be made or written to (see Target folders): what goes into them fails until they are; run ${prep.script} as administrator, then restore again`);

  if (!o.skipApps) {
    emit({ type: 'phase', name: 'apps', text: 'Apps, one by one' });
    const list = (manifest.apps ?? []).filter((/** @type {any} */ a) => !is7zip(a));
    status.setTotal('apps', list.reduce((/** @type {number} */ s, /** @type {any} */ a) => s + (a.kind === 'playwright' ? Math.max(1, (a.versions ?? []).length) : 1), 0));
    R.apps.push(...(await installApps(list, { work, emit, timeout: step })).map((a) => ({ name: a.name, status: a.status, detail: [a.how, a.detail].filter(Boolean).join(': ') })));
    await refreshPath();
  }

  emit({ type: 'phase', name: 'repos', text: 'Repositories' });
  const gitOk = (await run('git', ['--version'], { timeout: 60000 })).code === 0;
  /** @type {RepoCtx} */ const ctx = { mapping, up, emit, timeout: step };
  const plain = manifest.repos.filter((/** @type {any} */ r) => !r.worktreeOf).sort((/** @type {any} */ a, /** @type {any} */ b) => a.path.length - b.path.length);
  status.setTotal('repos', plain.length);
  let n = 0;
  for (const rec of plain) {
    n++;
    emit({ type: 'progress', done: n, total: plain.length, text: rec.path });
    const row = gitOk ? await restoreRepo(rec, ctx).catch((e) => ({ name: rec.path, dest: '', status: 'failed', detail: String(e.message ?? e) })) : { name: rec.path, dest: '', status: 'by hand', detail: 'git is not installed' };
    put('repos', row);
    emit({ type: 'step', text: `${rec.path}: ${row.status}` });
  }

  emit({ type: 'phase', name: 'folders', text: 'Folders, files and settings' });
  // The uncommitted files of cloned repositories and the stage folders are in the same unpacked tree: units leave them
  // alone, except repositories a unit copies whole below such a repository.
  const repoRels = manifest.repos.map((/** @type {any} */ r) => archiveRel(r.path));
  const stageRels = roots.filter((r) => r.stageRel).map((r) => ({ drive: r.drive, rel: /** @type {string} */ (r.stageRel) }));
  const units = [...manifest.units].sort((a, b) => b.path.length - a.path.length);
  status.setTotal('units', units.length);
  n = 0;
  for (const u of units) {
    n++;
    emit({ type: 'progress', done: n, total: units.length, text: u.path });
    const { drive, rel } = archiveRel(u.path);
    const dest = mapPath(u.path, mapping);
    const acc = { moved: 0, replaced: 0, conflicts: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]) };
    const keepRels = (u.repoRoots ?? []).map((/** @type {string} */ p) => archiveRel(p)).filter((/** @type {any} */ x) => x.drive === drive);
    for (const r of up.ofDrive(drive)) {
      const skips = [...repoRels, ...stageRels].filter((x) => x.drive === drive).map((x) => w.join(r.dir, x.rel));
      // The unit's own folder counts as a keep: a folder or file picked copy whole below a cloned repository (for example a
      // git-ignored out folder) is put back after the clone.
      const keeps = [...keepRels.map((/** @type {any} */ x) => w.join(r.dir, x.rel)), w.join(r.dir, rel)];
      const skipped = unitSkipper(skips, keeps);
      await moveTree(w.join(r.dir, rel), dest, {
        overwrite: u.kind === 'setting' || !!o.overwrite,
        loose: u.kind === 'loose',
        backupDir,
        skip: skipped,
        skipInside: (p) => skips.some((s) => isInside(s, p)),
      }, acc);
    }
    for (const c of acc.conflicts) R.conflicts.push({ name: c, status: 'conflict', detail: `kept the file that was there; the old laptop's copy stays in ${w.join(work, 'unpacked')}` });
    const detail = [`${acc.moved} moved`, acc.replaced ? `${acc.replaced} replaced (kept in ${backupDir})` : '', acc.conflicts.length ? `${acc.conflicts.length} conflicts` : '', ...acc.errors.slice(0, 5)].filter(Boolean).join(', ');
    put('units', { name: `${u.path} -> ${dest}`, status: acc.errors.length ? 'warning' : acc.moved || acc.replaced ? 'restored' : acc.conflicts.length ? 'conflict' : 'not in the parts', detail });
  }

  const worktrees = manifest.repos.filter((/** @type {any} */ r) => r.worktreeOf);
  if (worktrees.length) {
    emit({ type: 'phase', name: 'worktrees', text: 'Worktrees' });
    status.setTotal('worktrees', worktrees.length);
    for (const rec of worktrees) {
      const row = gitOk ? await restoreWorktree(rec, ctx).catch((e) => ({ name: rec.path, dest: '', status: 'failed', detail: String(e.message ?? e) })) : { name: rec.path, dest: '', status: 'by hand', detail: 'git is not installed' };
      put('worktrees', row, R.repos);
      emit({ type: 'step', text: `${rec.path}: ${row.status}` });
    }
  }

  emit({ type: 'phase', name: 'links', text: 'Links and junctions' });
  const planned = planLinks(manifest.links, mapping);
  status.setTotal('links', planned.length);
  for (const l of planned) {
    const r = await createLink(l);
    const missing = r.ok && !r.skipped && !existsSync(w.resolve(w.dirname(l.link), l.target));
    const detail = missing ? 'the target is not there yet (it was not in the parts: build output, or a folder elsewhere); the link works once it exists' : r.why ?? '';
    put('links', { name: `${l.link} -> ${l.target}`, status: r.skipped ? 'skipped' : r.ok ? 'created' : 'failed', detail });
  }

  const want = o.npmCi ?? (manifest.deps?.npmCi?.length ? manifest.deps.npmCi : null);
  if (want) {
    emit({ type: 'phase', name: 'npm', text: 'npm ci' });
    await refreshPath();
    const dirs = npmCiDirs(manifest, mapping, want);
    status.setTotal('npm', dirs.length);
    for (const dir of dirs) {
      const c = cmdLine('npm ci --install-links');
      const r = await runLive(c.file, c.args, { cwd: dir, verbatim: true, timeout: step, label: `npm ci --install-links (in ${dir})` });
      if (r.timedOut) put('npm', { name: dir, status: TIMED_OUT, detail: lateText(step, `run npm ci --install-links in ${dir} yourself`) });
      else put('npm', { name: dir, status: r.code === 0 ? 'done' : 'failed', detail: r.code === 0 ? '' : `npm exit ${r.code}` });
    }
  }

  if (!o.skipApps) {
    const editors = /** @type {const} */ (['code', 'cursor']).filter((e) => (manifest.extensions?.[e] ?? []).length);
    status.setTotal('extensions', editors.reduce((s, e) => s + manifest.extensions[e].length, 0));
    for (const editor of editors) {
      const ids = manifest.extensions[editor];
      emit({ type: 'phase', name: 'extensions', text: `${editor} extensions` });
      const c = cmdLine(`${editor} --version`);
      if ((await run(c.file, c.args, { verbatim: true, timeout: 60000 })).code !== 0) {
        put('extensions', { name: editor, status: 'by hand', detail: `${editor} is not installed yet: install it, then run restore again` });
        continue;
      }
      R.extensions.push(...(await installExtensions(editor, ids, { timeout: step, emit })).map((x) => ({ name: x.name, status: x.status, detail: x.detail })));
    }
  }

  emit({ type: 'phase', name: 'report', text: 'The report' });
  const report = w.join(work, 'restore-report.html');
  const rows = (/** @type {Row[]} */ list) => list.map((r) => [r.name, r.status, r.detail]);
  const timed = status.snapshot().timedOut;
  await writeFile(report, htmlReport('Laptop move: restore report', `${new Date().toLocaleString()}; packed on ${manifest.host}, ${manifest.createdAt}; the log of every step: ${x.logFile}`, [
    { title: 'Your own steps', columns: ['Step'], rows: manifest.userSteps.map((/** @type {string} */ s) => [s]) },
    { title: 'Move by hand (these were never in the parts)', columns: ['Path', 'Why'], rows: byHand.map((b) => [b.path, `by hand: ${b.why}`]) },
    {
      title: 'Timed out (stopped and skipped)', columns: ['When', 'Command', 'Limit'], empty: 'none: every command ended within its limit',
      intro: 'Each of these was stopped at its time limit, with every process it had started, and the restore went on. Run them yourself, or run restore again (add --step-timeout <minutes> for a longer limit).',
      rows: timed.map((t) => [clock(t.at), t.text, t.limit ? fmtLimit(t.limit) : '']),
    },
    { title: 'Parts', columns: ['Part', 'Status', 'Detail'], rows: rows(R.parts) },
    { title: 'Target folders (made before anything was put into them)', columns: ['Folder', 'Status', 'Detail'], rows: rows(R.targets) },
    { title: 'Apps', columns: ['App', 'Status', 'How'], rows: rows(R.apps), empty: o.skipApps ? 'skipped (--skip-apps)' : 'none' },
    { title: 'Repositories', columns: ['Repository', 'Status', 'Detail'], rows: rows(R.repos) },
    { title: 'Folders, files and settings', columns: ['Path', 'Status', 'Detail'], rows: rows(R.units) },
    { title: 'Conflicts (the file on this laptop was kept)', intro: 'Run restore again with --overwrite to replace them (the replaced files are kept in the work folder), or copy the ones you need by hand.', columns: ['File', 'Status', 'Detail'], rows: rows(R.conflicts.slice(0, 500)) },
    { title: 'Links and junctions', columns: ['Link', 'Status', 'Detail'], rows: rows(R.links) },
    { title: 'npm ci', columns: ['Folder', 'Status', 'Detail'], rows: rows(R.npm), empty: 'not asked' },
    { title: 'Editor extensions', columns: ['Extension', 'Status', 'Detail'], rows: rows(R.extensions) },
    { title: 'Warnings', columns: ['Warning'], rows: warnings.map((s) => [s]) },
  ]), 'utf8');
  emit({ type: 'done', text: `Restore finished. Report: ${report}. When everything is in place, delete ${w.join(work, 'unpacked')} and the downloaded parts.`, report });
  if (o.open !== false) openFile(report);
  return { report, results: R, warnings, log: x.logFile };
}

/**
 * Installs only the apps of the manifest, one by one (7-Zip first), with a report and a log (<work>\apps-log.txt).
 * @param {any} o {kitDir, from, work, dryRun, open, stepTimeout}
 * @param {(e: any) => void} [emit]
 */
export async function appsOnly(o, emit = () => {}) {
  const { manifest, work } = await open(o);
  await mkdir(work, { recursive: true });
  const step = o.stepTimeout ?? STEP_TIMEOUT;
  const log = o.dryRun ? null : openLog(w.join(work, 'apps-log.txt'), [`Laptop move apps, process ${process.pid}; step limit ${fmtLimit(step)}`]);
  const stopListening = log ? onCommand((e) => log.event(e)) : () => {};
  /** @param {any} e */
  const tee = (e) => { log?.event(e); emit(e); };
  try {
    tee({ type: 'phase', name: 'apps', text: o.dryRun ? 'Apps, dry run' : 'Apps, one by one' });
    const res = await installApps(manifest.apps ?? [], { work, dryRun: !!o.dryRun, emit: tee, timeout: step });
    if (o.dryRun) return { report: null, results: res };
    const report = w.join(work, 'apps-report.html');
    await writeFile(report, htmlReport('Laptop move: apps', `${new Date().toLocaleString()}; the log of every step: ${log?.file}`, [
      { title: 'Apps', columns: ['App', 'Status', 'How', 'Detail'], rows: res.map((a) => [a.name, a.status, a.how, a.detail]) },
    ]), 'utf8');
    tee({ type: 'done', text: `Apps done. Report: ${report}`, report });
    if (o.open !== false) openFile(report);
    return { report, results: res };
  } finally {
    stopListening();
  }
}
