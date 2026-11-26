// Apps: what to install, looked up read only on the old laptop, installed one by one on the new laptop.
// winget where it has the package; otherwise the vendor's official https link, checked before it runs:
// an installer only with a valid Authenticode signature from the recorded publisher, a zip only against the vendor's checksum.
import { existsSync } from 'node:fs';
import { readdir, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { run, runLive, sha256File, sha512File, slug, fmtLimit, STEP_TIMEOUT } from './util.mjs';
import { wingetAvailable, wingetShow, wingetInstalled, wingetInstall, wingetCommand, installMeaning, silentArgs } from './winget.mjs';
import { download, fetchText, signedBy, refreshPath, addUserPath } from './env.mjs';
import { sevenZipPath } from './sevenzip.mjs';

const w = path.win32;

/** npm packages behind the form's npm entries. */
export const NPM_PACKAGES = [
  [/claude code/i, '@anthropic-ai/claude-code'],
  [/cli for microsoft 365|m365/i, '@pnp/cli-microsoft365'],
];

/** Overrides for winget packages whose default install lacks what development needs. */
export const WINGET_OVERRIDES = {
  'Microsoft.VisualStudio.2022.BuildTools': '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended',
};

/** Company-managed apps: listed only, installed from Software Center or Company Portal. @param {{source: string, name: string}} a */
export function isCompanyApp(a) {
  return /software ?center|company ?portal|intune|sccm|company/i.test(a.source) || /\(software center\)|\(company portal\)/i.test(a.name);
}

/** Major version of a Node package id or name (OpenJS.NodeJS.22 -> 22; OpenJS.NodeJS.LTS -> null). @param {string} s */
export function nodeMajor(s) {
  const m = /nodejs\.?(\d+)\b|node\.?js (\d+)/i.exec(s);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** Finds a portable Blender (blender-X.Y.Z-windows-x64 with blender.exe) below the user's local app folders. */
export async function findBlender() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const tops = [local, w.join(local, 'Programs')];
  for (const top of tops) {
    let kids = [];
    try { kids = await readdir(top, { withFileTypes: true }); } catch { continue; }
    for (const k of kids.filter((d) => d.isDirectory())) {
      for (const sub of [w.join(top, k.name), w.join(top, k.name, 'blender')]) {
        let inner = [];
        try { inner = await readdir(sub); } catch { continue; }
        for (const n of inner) {
          const m = /^blender-(\d+\.\d+\.\d+)-windows-x64$/i.exec(n);
          if (m && existsSync(w.join(sub, n, 'blender.exe'))) return { version: m[1], parent: sub, folder: n };
        }
      }
    }
  }
  return null;
}

/** Finds Maven from PATH (an apache-maven-X.Y.Z\bin folder). */
export function findMaven() {
  for (const p of (process.env.Path ?? process.env.PATH ?? '').split(';')) {
    const m = /^(.*)\\(apache-maven-(\d+\.\d+\.\d+))\\bin\\?$/i.exec(p.trim());
    if (m) return { version: m[3], parent: m[1], folder: m[2] };
  }
  return null;
}

/**
 * Download entries for apps winget does not have. Each has an https link, a checksum link and where it goes.
 * @param {string} version
 */
export const DOWNLOADS = {
  maven: (/** @type {string} */ v) => {
    const major = v.split('.')[0];
    return { url: `https://archive.apache.org/dist/maven/maven-${major}/${v}/binaries/apache-maven-${v}-bin.zip`, checksumUrl: `https://archive.apache.org/dist/maven/maven-${major}/${v}/binaries/apache-maven-${v}-bin.zip.sha512`, checksumAlgo: 'sha512', publisher: 'The Apache Software Foundation', folder: `apache-maven-${v}`, pathAdd: 'bin' };
  },
  blender: (/** @type {string} */ v) => {
    const mm = v.split('.').slice(0, 2).join('.');
    return { url: `https://download.blender.org/release/Blender${mm}/blender-${v}-windows-x64.zip`, checksumUrl: `https://download.blender.org/release/Blender${mm}/blender-${v}.sha256`, checksumAlgo: 'sha256', publisher: 'Blender Foundation', folder: `blender-${v}-windows-x64`, pathAdd: '' };
  },
  node: (/** @type {string} */ v) => ({ url: `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`, checksumUrl: `https://nodejs.org/dist/v${v}/SHASUMS256.txt`, checksumAlgo: 'sha256', publisher: 'OpenJS Foundation', folder: `node-v${v}-win-x64`, pathAdd: '' }),
};

/**
 * Plans the apps on the old laptop. Read only: winget show for every ticked package, local folders for versions.
 * @param {{key: string, name: string, wingetId: string, source: string}[]} picks
 * @param {{nodePins?: string[], playwright?: string[]}} deps
 * @param {{lookup?: boolean, emit?: (e: any) => void}} [o]
 */
export async function planApps(picks, deps, o = {}) {
  const emit = o.emit ?? (() => {});
  const lookup = o.lookup !== false && (await wingetAvailable());
  if (o.lookup !== false && !lookup) emit({ type: 'warn', text: 'winget does not answer here: apps are recorded without the installer links' });
  /** @type {any[]} */
  const out = [];
  const nodeApps = picks.filter((a) => nodeMajor(a.wingetId || a.name));
  const topNode = Math.max(0, ...nodeApps.map((a) => nodeMajor(a.wingetId || a.name) ?? 0));
  let i = 0;
  for (const a of picks) {
    i++;
    emit({ type: 'progress', done: i, total: picks.length, text: `apps: ${a.name}` });
    const base = { name: a.name, source: a.source, wingetId: a.wingetId || null };
    if (isCompanyApp(a)) { out.push({ ...base, kind: 'company', note: 'install it from Software Center or Company Portal' }); continue; }
    if (a.source === 'own') { out.push({ ...base, kind: 'own', note: 'your own app: build it from its repository after the move' }); continue; }
    if (a.source === 'npx' || /playwright/i.test(a.name)) { out.push({ ...base, kind: 'playwright', versions: deps.playwright ?? [] }); continue; }
    if (a.source === 'npm') {
      const pkg = NPM_PACKAGES.find(([re]) => /** @type {RegExp} */ (re).test(a.name))?.[1] ?? /\(([@a-z0-9/._-]+)\)/i.exec(a.name)?.[1];
      out.push(pkg ? { ...base, kind: 'npm', pkg } : { ...base, kind: 'byhand', note: 'npm package name unknown' });
      continue;
    }
    const major = nodeMajor(a.wingetId || a.name);
    if (major && major < topNode) {
      const pin = (deps.nodePins ?? []).find((v) => v.split('.')[0] === String(major));
      let version = pin;
      if (!version && lookup && a.wingetId) version = (await wingetShow(a.wingetId)).version;
      if (version) { out.push({ ...base, kind: 'download', what: 'node', version, ...DOWNLOADS.node(version), dest: '%LOCALAPPDATA%\\Programs', note: `Node ${major} beside Node ${topNode}: a portable copy, not on PATH (use it with Volta, fnm or nvm, or call it by path)` }); continue; }
    }
    if (/maven/i.test(a.name) && !a.wingetId) {
      const mv = findMaven();
      if (mv) { out.push({ ...base, kind: 'download', what: 'maven', version: mv.version, ...DOWNLOADS.maven(mv.version), dest: mv.parent }); continue; }
      out.push({ ...base, kind: 'byhand', note: 'Maven was not found on PATH here: download it from https://maven.apache.org/download.cgi' });
      continue;
    }
    if (/blender/i.test(a.name) && !a.wingetId) {
      const b = await findBlender();
      if (b) { out.push({ ...base, kind: 'download', what: 'blender', version: b.version, ...DOWNLOADS.blender(b.version), dest: b.parent }); continue; }
      out.push({ ...base, kind: 'byhand', note: 'no portable Blender found here: https://www.blender.org/download/' });
      continue;
    }
    if (a.wingetId) {
      /** @type {any} */
      const rec = { ...base, kind: 'winget', override: /** @type {Record<string,string>} */ (WINGET_OVERRIDES)[a.wingetId] ?? null };
      if (lookup) {
        const s = await wingetShow(a.wingetId);
        if (s.found) Object.assign(rec, { version: s.version, publisher: s.publisher, installerType: s.installerType, url: s.installerUrl, sha256: s.sha256 });
        else { rec.kind = 'byhand'; rec.note = `winget has no package ${a.wingetId}: install it from the vendor's site`; }
      }
      out.push(rec);
      continue;
    }
    out.push({ ...base, kind: 'byhand', note: 'no winget package and no known download: install it by hand' });
  }
  return out;
}

/** The expected checksum of a file name in a checksum list ("<hash>  name" or a bare hash). @param {string} text @param {string} name */
export function checksumFor(text, name) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = /^([a-f0-9]{64,128})\s+\*?(.+)$/i.exec(l);
    if (m && w.basename(m[2].trim()) === name) return m[1].toLowerCase();
  }
  if (lines.length === 1 && /^[a-f0-9]{64,128}(\s|$)/i.test(lines[0])) return lines[0].split(/\s+/)[0].toLowerCase();
  return null;
}

/** Packages whose installer takes long (Build Tools with the C++ workload): their limit is three steps. */
export const SLOW_INSTALLS = /^Microsoft\.VisualStudio\./i;

/** The time limit of one app's install. @param {any} a @param {number} step */
export function installLimit(a, step) {
  return SLOW_INSTALLS.test(a.wingetId ?? '') ? step * 3 : step;
}

/** The status of a step stopped at its time limit. */
export const TIMED_OUT = 'timed out';

/** The detail of a step stopped at its time limit. @param {number} ms @param {string} what to do instead */
export function lateText(ms, what) {
  return `no answer after ${fmtLimit(ms)}: stopped and skipped; ${what}`;
}

/** True for the 7-Zip package (restore installs it before anything else). @param {any} a */
export function is7zip(a) {
  return /^7zip\.7zip$/i.test(a?.wingetId ?? '');
}

/** Runs an installer on the user's console and waits, within a time limit. @param {string} file @param {string[]} args @param {string} cwd @param {number} timeout */
function runAndWait(file, args, cwd, timeout) {
  return runLive(file, args, { cwd, timeout });
}

/** Runs a .cmd tool (npm, npx, code, cursor) through cmd.exe. @param {string} line the command line, its parts quoted already */
export function cmdLine(line) {
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}

/**
 * Installs the planned apps one by one on the new laptop. Each install has a time limit (timeout, Build Tools three
 * times as long): one that is not done by then is stopped, reported as timed out, and the next app follows. When winget
 * fails, the installer link recorded on the old laptop is tried (its checksum and signature are checked first).
 * @param {any[]} apps
 * @param {{work: string, dryRun?: boolean, emit?: (e: any) => void, timeout?: number}} o
 * @returns {Promise<{name: string, status: string, how: string, detail: string}[]>}
 */
export async function installApps(apps, o) {
  const emit = o.emit ?? (() => {});
  const step = o.timeout ?? STEP_TIMEOUT;
  /** @type {{name: string, status: string, how: string, detail: string}[]} */
  const results = [];
  const hasWinget = o.dryRun ? true : await wingetAvailable();
  if (!hasWinget) emit({ type: 'warn', text: 'winget is missing here: the kit downloads the recorded installers itself' });
  const order = [...apps].sort((a, b) => rank(a) - rank(b));
  /** @param {{name: string, status: string, how: string, detail: string}} r */
  const report = (r) => {
    results.push(r);
    emit({ type: 'step', text: `${r.name}: ${r.status}${r.detail ? ` (${r.detail})` : ''}` });
    emit({ type: 'item', section: 'apps', name: r.name, status: r.status, detail: [r.how, r.detail].filter(Boolean).join(': ') });
  };
  let i = 0;
  for (const a of order) {
    i++;
    emit({ type: 'progress', done: i, total: order.length, text: `apps: ${a.name}` });
    /** @param {string} status @param {string} how @param {string} detail */
    const done = (status, how, detail) => report({ name: a.name, status, how, detail });
    if (a.kind === 'company') { done('by hand', 'Software Center or Company Portal', a.note ?? ''); continue; }
    if (a.kind === 'own' || a.kind === 'byhand') { done('by hand', a.kind === 'own' ? 'own app' : 'by hand', a.note ?? ''); continue; }
    if (o.dryRun) { done('would install', describe(a, hasWinget), a.version ?? ''); continue; }
    const limit = installLimit(a, step);
    try {
      if (a.kind === 'winget' && hasWinget) {
        if (await wingetInstalled(a.wingetId)) { done('installed already', 'winget', ''); continue; }
        const r = await wingetInstall(a.wingetId, { override: a.override ?? undefined, timeout: limit });
        await refreshPath();
        if (r.timedOut) { done(TIMED_OUT, 'winget', lateText(limit, `run ${wingetCommand(a.wingetId)} yourself (its installer may still be finishing)`)); continue; }
        const m = installMeaning(r.code);
        if (m.ok) { done(m.text, 'winget', ''); continue; }
        if (!a.url) { done('failed', 'winget', `${m.text}; run ${wingetCommand(a.wingetId)} yourself`); continue; }
        emit({ type: 'step', text: `${a.name}: ${m.text}; trying the installer link recorded on the old laptop` });
        const l = await installFromLink(a, o.work, { timeout: limit });
        await refreshPath();
        done(l.status, 'download', /^installed/.test(l.status) ? `winget failed (${m.text}): installed from the recorded link${l.detail ? `; ${l.detail}` : ''}` : `winget: ${m.text}; the recorded link: ${l.detail}`);
        continue;
      }
      if (a.kind === 'winget') { const r = await installFromLink(a, o.work, { timeout: limit }); done(r.status, 'download', r.detail); await refreshPath(); continue; }
      if (a.kind === 'download') { const r = await installZip(a, o.work, { timeout: limit }); done(r.status, 'download', r.detail); continue; }
      if (a.kind === 'npm') {
        await refreshPath();
        const c = cmdLine(`npm install -g ${a.pkg}`);
        const r = await runLive(c.file, c.args, { verbatim: true, timeout: limit, label: `npm install -g ${a.pkg}` });
        if (r.timedOut) done(TIMED_OUT, 'npm -g', lateText(limit, `run npm install -g ${a.pkg} yourself`));
        else done(r.code === 0 ? 'installed' : 'failed', 'npm -g', r.code === 0 ? a.pkg : `npm exit ${r.code}`);
        continue;
      }
      if (a.kind === 'playwright') { for (const r of await installPlaywright(a.versions ?? [], o.work, emit, limit)) report(r); continue; }
      done('by hand', 'unknown', `unknown kind ${a.kind}`);
    } catch (e) {
      done('failed', a.kind, String(/** @type {any} */ (e).message ?? e));
    }
  }
  return results;
}

/** Install order: 7-Zip and git first, then the rest, npm packages and browsers last (they need Node). @param {any} a */
function rank(a) {
  if (/^7zip\./i.test(a.wingetId ?? '')) return 0;
  if (/^git\.git$/i.test(a.wingetId ?? '')) return 1;
  if (/nodejs/i.test(a.wingetId ?? '')) return 2;
  if (a.kind === 'winget') return 3;
  if (a.kind === 'download') return 4;
  if (a.kind === 'npm') return 5;
  if (a.kind === 'playwright') return 6;
  return 7;
}

/** @param {any} a @param {boolean} hasWinget */
function describe(a, hasWinget) {
  if (a.kind === 'winget') return hasWinget ? `winget install --id ${a.wingetId}` : `download ${a.url ?? '(no link)'}`;
  if (a.kind === 'download') return `download ${a.url}`;
  if (a.kind === 'npm') return `npm install -g ${a.pkg}`;
  if (a.kind === 'playwright') return `npx playwright install (${(a.versions ?? []).join(', ') || 'latest'})`;
  return a.kind;
}

/**
 * Downloads a winget package's recorded installer and runs it, only when its checksum and signature hold.
 * @param {any} a
 * @param {string} work
 * @param {{timeout?: number}} [o] the limit of the download and of the installer, each
 */
export async function installFromLink(a, work, o = {}) {
  if (!a.url) return { status: 'by hand', detail: 'no installer link was recorded' };
  const limit = o.timeout ?? STEP_TIMEOUT;
  const dir = w.join(work, 'downloads', slug(a.wingetId ?? a.name));
  const name = decodeURIComponent(new URL(a.url).pathname.split('/').pop() || 'installer');
  const file = w.join(dir, name);
  const d = await download(a.url, file, { timeout: limit });
  if (!d.ok) return { status: d.timedOut ? TIMED_OUT : 'failed', detail: d.why };
  if (a.sha256 && (await sha256File(file)) !== a.sha256) return { status: 'by hand', detail: 'checksum differs from the one winget recorded: not run' };
  const run1 = silentArgs(a.installerType, file);
  if (!run1) return { status: 'by hand', detail: `installer type ${a.installerType ?? '?'}: run ${file} yourself` };
  const sig = await signedBy(file, a.publisher);
  if (!sig.ok) return { status: 'by hand', detail: `${sig.why}: not run (${file})` };
  const r = await runAndWait(run1.file, run1.args, dir, limit);
  if (r.timedOut) return { status: TIMED_OUT, detail: lateText(limit, `run ${file} yourself (it may still be waiting for an answer)`) };
  const ok = r.code === 0 || r.code === 3010 || r.code === 1641;
  return { status: ok ? (r.code === 0 ? 'installed' : 'installed, restart needed') : 'failed', detail: ok ? '' : `installer exit ${r.code}` };
}

/**
 * Downloads a vendor zip, checks it against the vendor's checksum file, unpacks it with 7-Zip into its folder.
 * @param {any} a
 * @param {string} work
 * @param {{timeout?: number}} [o]
 */
export async function installZip(a, work, o = {}) {
  const limit = o.timeout ?? STEP_TIMEOUT;
  const dest = w.normalize(String(a.dest ?? '%LOCALAPPDATA%\\Programs').replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m));
  const target = w.join(dest, a.folder);
  if (existsSync(target)) return { status: 'installed already', detail: target };
  const dir = w.join(work, 'downloads', slug(a.url));
  const name = a.url.split('/').pop();
  const file = w.join(dir, name);
  const d = await download(a.url, file, { timeout: limit });
  if (!d.ok) return { status: d.timedOut ? TIMED_OUT : 'failed', detail: d.why };
  const list = await fetchText(a.checksumUrl);
  const want = list ? checksumFor(list, name) : null;
  if (!want) return { status: 'by hand', detail: `no checksum at ${a.checksumUrl}: not unpacked (${file})` };
  const have = a.checksumAlgo === 'sha512' ? await sha512File(file) : await sha256File(file);
  if (have !== want) return { status: 'by hand', detail: `checksum differs from the vendor's: not unpacked (${file})` };
  await mkdir(dest, { recursive: true });
  const r = await run(sevenZipPath(), ['x', file, `-o${dest}`, '-aos', '-bb0', '-bd'], { timeout: limit });
  if (r.timedOut) return { status: TIMED_OUT, detail: lateText(limit, `unpack ${file} into ${dest} yourself`) };
  if (r.code !== 0) return { status: 'failed', detail: `unpack failed: ${r.stderr.trim() || r.stdout.trim().split(/\r?\n/).pop()}` };
  const exe = a.what === 'node' ? w.join(target, 'node.exe') : a.what === 'blender' ? w.join(target, 'blender.exe') : null;
  if (exe && existsSync(exe)) {
    const sig = await signedBy(exe, a.publisher);
    if (!sig.ok) return { status: 'by hand', detail: `${w.basename(exe)}: ${sig.why}; check ${target} before use` };
  }
  let note = target;
  if (a.pathAdd) {
    const p = await addUserPath(w.join(target, a.pathAdd));
    if (p.changed) note += `; ${w.join(target, a.pathAdd)} added to your PATH (new windows see it after you sign out and in)`;
  }
  return { status: 'installed', detail: note };
}

/**
 * Playwright's browsers for each version the repositories use.
 * @param {string[]} versions
 * @param {string} work
 * @param {(e: any) => void} emit
 * @param {number} [timeout] the limit of each version's download
 */
export async function installPlaywright(versions, work, emit, timeout = STEP_TIMEOUT) {
  await refreshPath();
  const list = versions.length ? versions : ['latest'];
  const results = [];
  for (const v of list) {
    emit({ type: 'step', text: `Playwright ${v}: browsers` });
    await mkdir(work, { recursive: true });
    const line = `npx -y playwright@${v} install`;
    const c = cmdLine(line);
    const r = await runLive(c.file, c.args, { cwd: work, verbatim: true, timeout, label: line });
    const status = r.timedOut ? TIMED_OUT : r.code === 0 ? 'installed' : 'failed';
    results.push({ name: `Playwright ${v} browsers`, status, how: 'npx playwright install', detail: r.timedOut ? lateText(timeout, `run ${line} yourself`) : r.code === 0 ? '' : `exit ${r.code}` });
  }
  return results;
}

/** Editor extensions on the old laptop (read only). @param {'code'|'cursor'} editor */
export async function listExtensions(editor) {
  const c = cmdLine(`${editor} --list-extensions`);
  const r = await run(c.file, c.args, { verbatim: true, timeout: 120000 });
  if (r.code !== 0) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z0-9-]+\.[a-z0-9-.]+$/i.test(l));
}

/**
 * Installs editor extensions on the new laptop, each within a time limit.
 * @param {'code'|'cursor'} editor @param {string[]} ids @param {{timeout?: number, emit?: (e: any) => void}} [o]
 */
export async function installExtensions(editor, ids, o = {}) {
  const limit = Math.min(o.timeout ?? STEP_TIMEOUT, 10 * 60 * 1000);
  await refreshPath();
  const results = [];
  for (const id of ids) {
    if (!/^[a-z0-9-]+\.[a-z0-9-.]+$/i.test(id)) continue;
    const line = `${editor} --install-extension ${id}`;
    const c = cmdLine(line);
    const r = await run(c.file, c.args, { verbatim: true, timeout: limit, label: line });
    const status = r.timedOut ? TIMED_OUT : r.code === 0 ? 'installed' : 'failed';
    const detail = r.timedOut ? lateText(limit, `run ${line} yourself`) : r.code === 0 ? '' : (r.stderr || r.stdout).trim().split(/\r?\n/).pop() ?? '';
    const row = { name: `${editor} extension ${id}`, status, how: `${editor} --install-extension`, detail };
    results.push(row);
    o.emit?.({ type: 'item', section: 'extensions', name: row.name, status, detail });
  }
  return results;
}

/**
 * Code dependencies found in the picked repositories: Node pins (.nvmrc, Volta) and Playwright versions.
 * @param {string[]} repoRoots
 */
export async function scanDeps(repoRoots) {
  const pins = new Set();
  const pw = new Set();
  for (const r of repoRoots) {
    try {
      const nv = (await readFile(w.join(r, '.nvmrc'), 'utf8')).trim().replace(/^v/, '');
      if (/^\d+\.\d+\.\d+$/.test(nv)) pins.add(nv);
    } catch { /* none */ }
    let pkg;
    try { pkg = JSON.parse((await readFile(w.join(r, 'package.json'), 'utf8')).replace(/^﻿/, '')); } catch { continue; }
    const volta = pkg?.volta?.node;
    if (typeof volta === 'string' && /^\d+\.\d+\.\d+$/.test(volta)) pins.add(volta);
    for (const sec of ['dependencies', 'devDependencies']) {
      for (const name of ['@playwright/test', 'playwright']) {
        const v = pkg?.[sec]?.[name];
        if (typeof v === 'string') { const m = /(\d+\.\d+\.\d+)/.exec(v); if (m) pw.add(m[1]); }
      }
    }
  }
  const byVer = (/** @type {string} */ a, /** @type {string} */ b) => b.localeCompare(a, undefined, { numeric: true });
  return { nodePins: [...pins].sort(byVer), playwright: [...pw].sort(byVer) };
}
