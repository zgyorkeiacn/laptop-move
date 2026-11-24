// restore, on the new laptop: checks the parts, unpacks them (7-Zip asks for the password on the console, or reads the
// one typed in the page through a pipe), installs the apps one by
// one, clones the repositories and brings their local work back, puts folders and settings at their places, recreates
// the junctions and writes a report. It never deletes a file it did not bring and never replaces one, except settings
// (and every file with --overwrite): a replaced file is first copied to <work>\replaced.
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveRel, driveOf, isInside, mapPath, norm } from './paths.mjs';
import { check7z, extractArgs, exitMeaning, run7z, lastLines } from './sevenzip.mjs';
import { wingetAvailable, wingetInstall } from './winget.mjs';
import { installApps, installFromLink, installExtensions, cmdLine } from './apps.mjs';
import { refreshPath, openFile } from './env.mjs';
import { gitLive, gitHere, applyRepoState, fetchBundle, dropTempRefs } from './git.mjs';
import { planLinks, createLink } from './links.mjs';
import { htmlReport } from './report.mjs';
import { RATES } from './plan.mjs';
import { run, runInherit, fmtBytes, fmtDuration, sha256File } from './util.mjs';

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
 * 7-Zip 26.03 or newer: installed through winget, or from the recorded installer when its signature holds.
 * @param {any} manifest
 * @param {string} work
 * @param {(e: any) => void} emit
 */
async function ensure7z(manifest, work, emit) {
  let sz = await check7z();
  if (sz.ok) return sz;
  emit({ type: 'step', text: `${sz.why}: installing 7-Zip first` });
  if (await wingetAvailable()) await wingetInstall('7zip.7zip');
  else {
    const rec = (manifest.apps ?? []).find((/** @type {any} */ a) => /^7zip\.7zip$/i.test(a.wingetId ?? ''));
    if (rec) {
      const r = await installFromLink(rec, work);
      emit({ type: 'step', text: `7-Zip: ${r.status}${r.detail ? ` (${r.detail})` : ''}` });
    }
  }
  sz = await check7z();
  if (!sz.ok) throw new Error(`${sz.why}: install 7-Zip 26.03 or newer (Software Center, or winget install --id 7zip.7zip -e), then run restore again`);
  return sz;
}

/**
 * Unpacks one split archive into <work>\unpacked\<name>. On the console a wrong password may be typed again (three
 * tries). With a password (from the user interface) 7-Zip reads it from a pipe, once: a wrong one stops the restore.
 * @param {any} a
 * @param {string} from
 * @param {string} work
 * @param {string} exe
 * @param {boolean} encrypted
 * @param {(e: any) => void} emit
 * @param {string|null} [password]
 */
export async function unpack(a, from, work, exe, encrypted, emit, password = null) {
  const dir = w.join(work, 'unpacked', a.name);
  const marker = w.join(work, 'unpacked', `${a.name}.done`);
  if (existsSync(marker)) return { ok: true, dir, again: true };
  if (password !== null) {
    emit({ type: 'progress', done: 0, total: 100, text: `unpacking ${a.name}`, part: a.name });
    const r = await run7z(exe, extractArgs(w.join(from, a.parts[0].file), dir), { password: encrypted ? password : '',
      onPercent: (pct) => emit({ type: 'progress', done: pct, total: 100, text: `unpacking ${a.name}`, part: a.name }) });
    if (r.code === 0 || r.code === 1) {
      await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
      return { ok: true, dir, warning: r.code === 1 ? exitMeaning(1) : null };
    }
    if (r.code === 2 && encrypted) return { ok: false, dir, why: 'wrong password or a damaged part: type the password again and run restore again (it continues where it stopped)' };
    return { ok: false, dir, why: `${exitMeaning(r.code)}${lastLines(r.out) ? ` (${lastLines(r.out)})` : ''}` };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (encrypted) emit({ type: 'step', text: `7-Zip asks for the password of ${a.name} now (the one you typed when packing)` });
    const code = await runInherit(exe, extractArgs(w.join(from, a.parts[0].file), dir));
    if (code === 0 || code === 1) {
      await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
      return { ok: true, dir, warning: code === 1 ? exitMeaning(1) : null };
    }
    if (code === 2 && encrypted && attempt < 3) { emit({ type: 'warn', text: `${a.name}: wrong password or a damaged part; try again` }); continue; }
    return { ok: false, dir, why: exitMeaning(code) };
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
 * Clones one repository and brings its local work back.
 * @param {any} rec
 * @param {{mapping: any, up: ReturnType<typeof unpackedView>, emit: (e: any) => void}} ctx
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
    await mkdir(w.dirname(dest), { recursive: true });
    ctx.emit({ type: 'step', text: `git clone ${rec.origin} (Git Credential Manager may ask you to sign in)` });
    const code = await gitLive(w.dirname(dest), ['clone', '--recurse-submodules', '-o', originName, rec.origin, dest]);
    if (code !== 0) return row('failed', `git clone exit ${code}`);
    notes.push('cloned');
    for (const r of rec.remotes ?? []) {
      if (r.name === originName) continue;
      await gitHere(dest, ['remote', 'add', r.name, r.url]);
      if ((await gitLive(dest, ['fetch', r.name])) !== 0) problems.push(`remote ${r.name}: fetch failed`);
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
 * @param {{mapping: any, up: ReturnType<typeof unpackedView>, emit: (e: any) => void}} ctx
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
    await mkdir(w.dirname(main), { recursive: true });
    const code = await gitLive(w.dirname(main), ['clone', '--recurse-submodules', rec.origin, main]);
    if (code !== 0) return row('failed', `git clone of the main repository exit ${code}`);
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
  const parts = await checkParts(manifest, from, { skipClient: o.skipClient });
  section('Parts', parts.rows.map((r) => `${r.status.padEnd(8)} ${r.name}  ${r.detail}`));
  for (const a of parts.archives) {
    if (a.status === 'ok' || a.status === 'skipped') continue;
    if (a.group === 'client') L.push(`  The client part ${a.name} is ${a.status}: restore would go on without it.`);
    else problems.push(`data part ${a.name} is ${a.status}`);
  }
  const sz = await check7z();
  L.push('', `7-Zip: ${sz.ok ? `${sz.version}, ok` : `${sz.why}: restore installs it first`}`);
  const bytes = manifest.totals.data + (o.skipClient ? 0 : manifest.totals.client);
  const free = await freeOn(work);
  L.push(`Unpacked size about ${fmtBytes(bytes)}; free on ${driveOf(work)}: ${free == null ? '?' : fmtBytes(free)}; unpacking about ${fmtDuration(bytes / RATES.unpackBps)}`);
  if (free != null && free < bytes * 1.3) problems.push(`not enough free space on ${driveOf(work)}: (about ${fmtBytes(bytes * 1.3)} needed)`);
  if (!o.skipApps) {
    const apps = await installApps(manifest.apps ?? [], { work, dryRun: true });
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
 * Restores everything on the new laptop.
 * @param {any} o {kitDir, from, work, targetRoot, overwrite, skipApps, skipClient, npmCi, open}
 * @param {(e: any) => void} [emit]
 */
export async function restore(o, emit = () => {}) {
  const { from, manifest, work, mapping } = await open(o);
  const backupDir = w.join(work, 'replaced');
  /** @type {Record<string, Row[]>} */
  const R = { parts: [], apps: [], repos: [], units: [], links: [], npm: [], extensions: [], conflicts: [] };
  /** @type {string[]} */ const warnings = [...manifest.warnings];
  const byHand = [...manifest.byHand];
  await mkdir(work, { recursive: true });

  emit({ type: 'phase', name: 'check', text: 'Checking the parts' });
  const parts = await checkParts(manifest, from, { hash: true, skipClient: o.skipClient, emit });
  R.parts = parts.rows;
  for (const a of parts.archives) {
    if (a.status === 'ok' || a.status === 'skipped' || a.group === 'client') continue;
    throw new Error(`data part ${a.name} is ${a.status}: put every part into ${from} (download it again), then run restore again`);
  }
  for (const a of parts.archives) if (a.group === 'client' && a.status !== 'ok' && a.status !== 'skipped') warnings.push(`client part ${a.name} is ${a.status}: restored without it`);
  const bytes = manifest.totals.data + (o.skipClient ? 0 : manifest.totals.client);
  const free = await freeOn(work);
  if (free != null && free < bytes * 1.3) throw new Error(`not enough free space on ${driveOf(work)}: (${fmtBytes(free)} free, about ${fmtBytes(bytes * 1.3)} needed)`);

  emit({ type: 'phase', name: '7zip', text: '7-Zip' });
  const sz = await ensure7z(manifest, work, emit);

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
  for (const a of todo) {
    emit({ type: 'step', text: `${a.name}: ${a.parts.length} part${a.parts.length === 1 ? '' : 's'}` });
    const u = await unpack(a, from, work, sz.exe, !!manifest.encrypted, emit, password);
    if (!u.ok) {
      if (a.group === 'client') { warnings.push(`client part ${a.name}: ${u.why}; restored without it`); continue; }
      throw new Error(`unpacking ${a.name} failed: ${u.why}. Run restore again; it continues where it stopped.`);
    }
    if (u.warning) warnings.push(`${a.name}: 7-Zip ${u.warning}`);
    roots.push({ name: a.name, group: a.group, drive: a.drive, dir: u.dir, stageRel: a.stageRel ?? null });
  }
  const up = unpackedView(roots);

  const clientStage = up.stage('client');
  if (clientStage && existsSync(w.join(clientStage, 'client-manifest.json'))) {
    const cm = JSON.parse((await readFile(w.join(clientStage, 'client-manifest.json'), 'utf8')).trim());
    manifest.units.push(...(cm.units ?? []));
    manifest.repos.push(...(cm.repos ?? []));
    manifest.links.push(...(cm.links ?? []));
    byHand.push(...(cm.byHand ?? []));
    warnings.push(...(cm.warnings ?? []));
  }

  if (!o.skipApps) {
    emit({ type: 'phase', name: 'apps', text: 'Apps, one by one' });
    R.apps = (await installApps(manifest.apps ?? [], { work, emit })).map((a) => ({ name: a.name, status: a.status, detail: [a.how, a.detail].filter(Boolean).join(': ') }));
    await refreshPath();
  }

  emit({ type: 'phase', name: 'repos', text: 'Repositories' });
  const gitOk = (await run('git', ['--version'], { timeout: 60000 })).code === 0;
  const ctx = { mapping, up, emit };
  const plain = manifest.repos.filter((/** @type {any} */ r) => !r.worktreeOf).sort((/** @type {any} */ a, /** @type {any} */ b) => a.path.length - b.path.length);
  let n = 0;
  for (const rec of plain) {
    n++;
    emit({ type: 'progress', done: n, total: plain.length, text: rec.path });
    const row = gitOk ? await restoreRepo(rec, ctx).catch((e) => ({ name: rec.path, dest: '', status: 'failed', detail: String(e.message ?? e) })) : { name: rec.path, dest: '', status: 'by hand', detail: 'git is not installed' };
    R.repos.push(row);
    emit({ type: 'step', text: `${rec.path}: ${row.status}` });
  }

  emit({ type: 'phase', name: 'folders', text: 'Folders, files and settings' });
  // The uncommitted files of cloned repositories and the stage folders are in the same unpacked tree: units leave them
  // alone, except repositories a unit copies whole below such a repository.
  const repoRels = manifest.repos.map((/** @type {any} */ r) => archiveRel(r.path));
  const stageRels = roots.filter((r) => r.stageRel).map((r) => ({ drive: r.drive, rel: /** @type {string} */ (r.stageRel) }));
  const units = [...manifest.units].sort((a, b) => b.path.length - a.path.length);
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
    R.units.push({ name: `${u.path} -> ${dest}`, status: acc.errors.length ? 'warning' : acc.moved || acc.replaced ? 'restored' : acc.conflicts.length ? 'conflict' : 'not in the parts', detail });
  }

  const worktrees = manifest.repos.filter((/** @type {any} */ r) => r.worktreeOf);
  if (worktrees.length) {
    emit({ type: 'phase', name: 'worktrees', text: 'Worktrees' });
    for (const rec of worktrees) {
      const row = gitOk ? await restoreWorktree(rec, ctx).catch((e) => ({ name: rec.path, dest: '', status: 'failed', detail: String(e.message ?? e) })) : { name: rec.path, dest: '', status: 'by hand', detail: 'git is not installed' };
      R.repos.push(row);
      emit({ type: 'step', text: `${rec.path}: ${row.status}` });
    }
  }

  emit({ type: 'phase', name: 'links', text: 'Links and junctions' });
  for (const l of planLinks(manifest.links, mapping)) {
    const r = await createLink(l);
    const missing = r.ok && !r.skipped && !existsSync(w.resolve(w.dirname(l.link), l.target));
    const detail = missing ? 'the target is not there yet (it was not in the parts: build output, or a folder elsewhere); the link works once it exists' : r.why ?? '';
    R.links.push({ name: `${l.link} -> ${l.target}`, status: r.skipped ? 'skipped' : r.ok ? 'created' : 'failed', detail });
  }

  const want = o.npmCi ?? (manifest.deps?.npmCi?.length ? manifest.deps.npmCi : null);
  if (want) {
    emit({ type: 'phase', name: 'npm', text: 'npm ci' });
    await refreshPath();
    for (const dir of npmCiDirs(manifest, mapping, want)) {
      const c = cmdLine('npm ci --install-links');
      const code = await runInherit(c.file, c.args, { cwd: dir, verbatim: true });
      R.npm.push({ name: dir, status: code === 0 ? 'done' : 'failed', detail: code === 0 ? '' : `npm exit ${code}` });
    }
  }

  if (!o.skipApps) {
    for (const editor of /** @type {const} */ (['code', 'cursor'])) {
      const ids = manifest.extensions?.[editor] ?? [];
      if (!ids.length) continue;
      emit({ type: 'phase', name: 'extensions', text: `${editor} extensions` });
      const c = cmdLine(`${editor} --version`);
      if ((await run(c.file, c.args, { verbatim: true, timeout: 60000 })).code !== 0) {
        R.extensions.push({ name: editor, status: 'by hand', detail: `${editor} is not installed yet: install it, then run restore again` });
        continue;
      }
      R.extensions.push(...(await installExtensions(editor, ids)).map((x) => ({ name: x.name, status: x.status, detail: x.detail })));
    }
  }

  const report = w.join(work, 'restore-report.html');
  const rows = (/** @type {Row[]} */ list) => list.map((r) => [r.name, r.status, r.detail]);
  await writeFile(report, htmlReport('Laptop move: restore report', `${new Date().toLocaleString()}; packed on ${manifest.host}, ${manifest.createdAt}`, [
    { title: 'Your own steps', columns: ['Step'], rows: manifest.userSteps.map((/** @type {string} */ s) => [s]) },
    { title: 'Move by hand (these were never in the parts)', columns: ['Path', 'Why'], rows: byHand.map((b) => [b.path, `by hand: ${b.why}`]) },
    { title: 'Parts', columns: ['Part', 'Status', 'Detail'], rows: rows(R.parts) },
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
  return { report, results: R, warnings };
}

/**
 * Installs only the apps of the manifest, one by one, with a report.
 * @param {any} o {kitDir, from, work, dryRun, open}
 * @param {(e: any) => void} [emit]
 */
export async function appsOnly(o, emit = () => {}) {
  const { manifest, work } = await open(o);
  await mkdir(work, { recursive: true });
  emit({ type: 'phase', name: 'apps', text: o.dryRun ? 'Apps, dry run' : 'Apps, one by one' });
  const res = await installApps(manifest.apps ?? [], { work, dryRun: !!o.dryRun, emit });
  if (o.dryRun) return { report: null, results: res };
  const report = w.join(work, 'apps-report.html');
  await writeFile(report, htmlReport('Laptop move: apps', new Date().toLocaleString(), [
    { title: 'Apps', columns: ['App', 'Status', 'How', 'Detail'], rows: res.map((a) => [a.name, a.status, a.how, a.detail]) },
  ]), 'utf8');
  emit({ type: 'done', text: `Apps done. Report: ${report}`, report });
  if (o.open !== false) openFile(report);
  return { report, results: res };
}
