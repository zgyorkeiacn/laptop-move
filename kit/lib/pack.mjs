// pack, on the old laptop: plans the move (scan), writes the repositories' bundles and stash patches into its own stage
// folder, packs the data into encrypted 7-Zip volumes, writes the checksums, the manifest and the small kit zip.
// It never changes a picked folder or repository and uploads nothing: the user uploads the output folder's files.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scan, defaultOut, formatPlan } from './plan.mjs';
import { isClientPath } from './rules.mjs';
import { makeBundle, stashPatch } from './git.mjs';
import { check7z, addArgs, exitMeaning } from './sevenzip.mjs';
import { norm, archiveRel, driveOf, outProblem } from './paths.mjs';
import { signedBy, download, fetchText } from './env.mjs';
import { htmlReport } from './report.mjs';
import { run, runInherit, fmtBytes, sha256File, slug, stamp } from './util.mjs';

const w = path.win32;

/** True when the plan holds anything that belongs to the client part. @param {any} plan */
export function hasClient(plan) {
  return plan.units.some((/** @type {any} */ u) => u.group !== 'data')
    || plan.repos.some((/** @type {any} */ r) => r.group === 'client')
    || plan.byHand.some((/** @type {any} */ b) => b.group === 'client')
    || plan.links.some((/** @type {any} */ l) => l.group === 'client')
    || plan.pushFirst.length > 0;
}

/**
 * Checks before packing. Empty when pack may start.
 * @param {any} plan
 * @param {string} out
 * @param {{noClientRules?: boolean, allowOneDrive?: boolean, encrypt?: boolean, fast?: boolean}} o
 */
export async function preflight(plan, out, o) {
  /** @type {string[]} */ const problems = [];
  if (o.fast) problems.push('--fast is for the dry run only: a real pack walks every folder');
  if (!plan.rulesFound && !o.noClientRules) problems.push(`no client rules file: write ${plan.rulesFile ?? 'laptop-move-client.json next to the selection'} first (see the README), or add --no-client-rules when nothing on this laptop is client data`);
  const op = outProblem(out, plan.rules, !!o.allowOneDrive);
  if (op) problems.push(`output folder ${out}: ${op}`);
  for (const u of plan.units) if (!op && u.kind !== 'setting' && out.toLowerCase().startsWith(`${u.path.toLowerCase()}\\`)) problems.push(`output folder ${out} is inside a picked folder (${u.path}): name a folder outside it`);
  const sz = await check7z();
  if (!sz.ok) problems.push(`${sz.why}: install 7-Zip 26.03 or newer (winget install --id 7zip.7zip -e, or Software Center)`);
  if (o.encrypt === false && hasClient(plan)) problems.push('client data is always encrypted: drop --no-encrypt');
  if (existsSync(out)) {
    const left = await readdir(out).catch(() => []);
    if (left.length) problems.push(`output folder ${out} is not empty: name a new folder`);
  }
  if (!op) {
    const need = Math.round((plan.totals.dataEstimate.archive + plan.totals.clientEstimate.archive) * 1.1) + 300 * 1024 * 1024;
    try {
      const s = await statfs(`${driveOf(out)}:\\`);
      const free = s.bavail * s.bsize;
      if (free < need) problems.push(`not enough free space on ${driveOf(out)}: (${fmtBytes(free)} free, about ${fmtBytes(need)} needed)`);
    } catch { problems.push(`drive ${driveOf(out)}: is not available`); }
  }
  return problems;
}

/**
 * The dry run of pack: the plan, its text and the checks. Writes nothing.
 * @param {any} o scan options plus out, noClientRules, allowOneDrive, encrypt, all
 * @param {(e: any) => void} [emit]
 */
export async function dryRun(o, emit = () => {}) {
  const out = norm(o.out ?? defaultOut());
  const plan = await scan({ ...o, out }, emit);
  const problems = await preflight(plan, out, { ...o, fast: false });
  const lines = [formatPlan(plan, { all: !!o.all }), '', `Output folder: ${out}`];
  lines.push(problems.length ? `Pack would stop here:\n${problems.map((p) => `  - ${p}`).join('\n')}` : 'Checks: pack can start.');
  if (o.fast) lines.push('(--fast: a real pack walks every folder; the numbers above are rough)');
  return { plan, out, problems, text: lines.join('\n') };
}

/** Whether a text names a client path (it then goes only into the encrypted client manifest). @param {string} text @param {string[]} needles */
function mentions(text, needles) {
  const t = text.toLowerCase();
  return needles.some((n) => n && t.includes(n));
}

/** A unit as the manifest keeps it: no file list. @param {any} u @param {boolean} withClientRoots */
function unitRecord(u, withClientRoots) {
  const clientRoots = new Set((u.clientRepoRoots ?? []).map((/** @type {string} */ r) => r.toLowerCase()));
  return {
    id: u.id, path: u.path, kind: u.kind, app: u.app ?? null, bytes: u.bytes, fileCount: u.fileCount, group: u.group,
    repoRoots: (u.repoRoots ?? []).filter((/** @type {string} */ r) => withClientRoots || !clientRoots.has(r.toLowerCase())),
  };
}

/**
 * Packs the move. Throws before writing anything when a check fails.
 * @param {any} o scan options plus out, kitDir, noClientRules, allowOneDrive, encrypt (default true)
 * @param {(e: any) => void} [emit]
 */
export async function pack(o, emit = () => {}) {
  const out = norm(o.out ?? defaultOut());
  const encrypt = o.encrypt !== false;
  if (o.fast) throw new Error('--fast is for the dry run only');
  const plan = await scan({ ...o, out }, emit);
  const problems = await preflight(plan, out, { ...o, encrypt });
  if (problems.length) throw new Error(`pack stopped before writing anything:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const sz = await check7z();
  const rules = plan.rules;
  const work = w.join(out, '.work');
  const stage = { data: w.join(out, '.stage-data'), client: w.join(out, '.stage-client') };
  await mkdir(work, { recursive: true });
  if (!encrypt) emit({ type: 'warn', text: 'NOT ENCRYPTED (--no-encrypt): for a trial with test data only' });

  emit({ type: 'phase', name: 'repos', text: 'Bundles of local commits and stashes' });
  const bundled = plan.repos.filter((/** @type {any} */ r) => r.mode === 'bundle');
  let n = 0;
  for (const r of bundled) {
    n++;
    emit({ type: 'progress', done: n, total: bundled.length, text: r.path });
    const root = r.group === 'client' ? stage.client : stage.data;
    const s = slug(r.path);
    r.bundle = null;
    if (r.worktreeOf) r.stashes = []; // stashes belong to the main repository
    if (!(r.worktreeOf && !r.origin)) {
      const b = await makeBundle(r.path, w.join(root, 'bundles', `${s}.bundle`), r.stashes.map((/** @type {any} */ x) => x.sha), !!r.detached);
      if (!b.ok) plan.warnings.push(`${r.path}: bundle failed (${b.why}); its unpushed commits are not carried`);
      if (b.file) r.bundle = `bundles\\${s}.bundle`;
    }
    for (const st of r.stashes) {
      const rel = `patches\\${s}\\stash-${st.index}.patch`;
      if (await stashPatch(r.path, st.ref, w.join(root, rel))) st.patch = rel;
    }
  }

  // Everything that names a client path goes only into the encrypted client manifest.
  const needles = [...rules.clientRoots, ...plan.repos.filter((/** @type {any} */ r) => r.group === 'client').map((/** @type {any} */ r) => r.path),
    ...plan.units.filter((/** @type {any} */ u) => u.group === 'client').map((/** @type {any} */ u) => u.path),
    ...plan.units.flatMap((/** @type {any} */ u) => u.clientRepoRoots ?? []), ...plan.pushFirst.map((/** @type {any} */ p) => p.path)].map((p) => String(p).toLowerCase());
  const clientUnit = (/** @type {any} */ u) => u.group === 'client' || isClientPath(u.path, rules);
  const clientMan = {
    kind: 'laptop-move-client',
    version: 1,
    units: plan.units.filter(clientUnit).map((/** @type {any} */ u) => unitRecord(u, true)),
    repos: plan.repos.filter((/** @type {any} */ r) => r.group === 'client'),
    links: plan.links.filter((/** @type {any} */ l) => l.group === 'client'),
    byHand: plan.byHand.filter((/** @type {any} */ b) => b.group === 'client' || mentions(b.path, needles)),
    pushFirst: plan.pushFirst,
    warnings: plan.warnings.filter((/** @type {string} */ t) => mentions(t, needles)),
    clientRepoRoots: plan.units.filter((/** @type {any} */ u) => !clientUnit(u)).flatMap((/** @type {any} */ u) => u.clientRepoRoots ?? []),
  };
  const withClient = hasClient(plan);
  if (withClient) {
    await mkdir(stage.client, { recursive: true });
    await writeFile(w.join(stage.client, 'client-manifest.json'), `${JSON.stringify(clientMan, null, 2)}\n`, 'utf8');
  }

  emit({ type: 'phase', name: 'lists', text: 'File lists' });
  /** @type {Map<string, {name: string, group: string, drive: string, lines: string[], bytes: number, stageRel: string|null}>} */
  const lists = new Map();
  const listFor = (/** @type {string} */ group, /** @type {string} */ drive) => {
    const name = `${group}-${drive}`;
    let l = lists.get(name);
    if (!l) { l = { name, group, drive, lines: [], bytes: 0, stageRel: null }; lists.set(name, l); }
    return l;
  };
  const add = (/** @type {string} */ group, /** @type {string} */ abs, /** @type {number} */ size) => {
    const { drive, rel } = archiveRel(abs);
    const l = listFor(group, drive);
    l.lines.push(rel);
    l.bytes += size;
  };
  for (const u of plan.units) for (const f of u.files) add(f.group === 'client' ? 'client' : 'data', f.path, f.size);
  for (const r of bundled) for (const d of r.dirty.changed) add(r.group === 'client' ? 'client' : 'data', w.join(r.path, d.rel), d.size);
  for (const group of /** @type {const} */ (['data', 'client'])) {
    const dir = stage[group];
    if (!existsSync(dir) || !(await readdir(dir)).length) continue;
    const l = listFor(group, driveOf(out));
    l.stageRel = archiveRel(dir).rel;
    l.lines.push(l.stageRel);
  }

  emit({ type: 'phase', name: 'pack', text: '7-Zip' });
  const order = [...lists.values()].sort((a, b) => (a.group === b.group ? a.drive.localeCompare(b.drive) : a.group === 'data' ? -1 : 1));
  for (const l of order) {
    const listFile = w.join(work, `${l.name}.txt`);
    await writeFile(listFile, `${l.lines.join('\r\n')}\r\n`, 'utf8');
    const archive = w.join(out, `${l.name}.7z`);
    emit({ type: 'step', text: `${l.name}: ${l.lines.length} entries, ${fmtBytes(l.bytes)}` });
    if (encrypt) emit({ type: 'step', text: `7-Zip now asks for the password of ${l.name} (and asks again to confirm it). Use one password for all parts and keep it safe: the kit never stores it.` });
    const code = await runInherit(sz.exe, addArgs({ archive, listFile, volumeBytes: plan.volumeBytes, encrypt }), { cwd: `${l.drive}:\\` });
    if (code === 1) plan.warnings.push(`${l.name}: 7-Zip ${exitMeaning(1)}`);
    else if (code !== 0) throw new Error(`7-Zip stopped on ${l.name}: ${exitMeaning(code)}. The output folder ${out} is incomplete: delete it and pack again.`);
  }

  emit({ type: 'phase', name: 'checksums', text: 'Checksums' });
  const names = await readdir(out);
  const archives = [];
  for (const l of order) {
    const parts = [];
    const mine = names.filter((f) => f.startsWith(`${l.name}.7z.`) && /\.\d{3}$/.test(f)).sort();
    for (const f of mine) {
      emit({ type: 'progress', done: parts.length + 1, total: mine.length, text: f });
      parts.push({ file: f, size: (await stat(w.join(out, f))).size, sha256: await sha256File(w.join(out, f)) });
    }
    if (!parts.length) throw new Error(`7-Zip wrote no parts for ${l.name}`);
    archives.push({ name: l.name, group: l.group, drive: l.drive, parts, stageRel: l.stageRel });
  }

  const clientNeedle = (/** @type {string} */ t) => mentions(t, needles);
  const manifest = {
    kind: 'laptop-move',
    version: 1,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    oldProfile: plan.oldProfile,
    rulesUsed: plan.rulesFound,
    encrypted: encrypt,
    clientData: plan.clientData,
    volumeBytes: plan.volumeBytes,
    hasClientPart: archives.some((a) => a.group === 'client'),
    archives,
    totals: { data: plan.totals.data.bytes, client: plan.totals.client.bytes },
    units: plan.units.filter((/** @type {any} */ u) => !clientUnit(u)).map((/** @type {any} */ u) => unitRecord(u, false)),
    repos: plan.repos.filter((/** @type {any} */ r) => r.group !== 'client'),
    links: plan.links.filter((/** @type {any} */ l) => l.group !== 'client'),
    settings: plan.settings,
    apps: plan.apps,
    extensions: plan.extensions,
    deps: plan.deps,
    byHand: plan.byHand.filter((/** @type {any} */ b) => b.group !== 'client' && !clientNeedle(b.path)),
    userSteps: plan.userSteps,
    warnings: plan.warnings.filter((/** @type {string} */ t) => !clientNeedle(t)),
  };
  await writeFile(w.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  emit({ type: 'phase', name: 'kit', text: 'The kit zip' });
  const kitZip = await makeKitZip({ kitDir: o.kitDir, work, out, manifest, exe: sz.exe, emit });

  const sums = archives.flatMap((a) => a.parts.map((p) => `${p.sha256} *${p.file}`));
  sums.push(`${await sha256File(kitZip)} *${w.basename(kitZip)}`);
  await writeFile(w.join(out, 'SHA256SUMS.txt'), `${sums.join('\r\n')}\r\n`, 'utf8');

  await rm(stage.data, { recursive: true, force: true });
  await rm(stage.client, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });

  const reportDir = w.join(process.env.LOCALAPPDATA ?? w.join(os.homedir(), 'AppData', 'Local'), 'LaptopMove');
  await mkdir(reportDir, { recursive: true });
  const report = w.join(reportDir, `pack-report-${stamp()}.html`);
  await writeFile(report, packReport(plan, manifest, out, kitZip), 'utf8');
  emit({ type: 'done', text: `Packed into ${out}`, out, report });
  return { out, report, kitZip, manifest, plan };
}

/**
 * Builds laptop-move-kit.zip: kit.mjs, lib, manifest.json, README.md and the official node.exe.
 * @param {{kitDir: string, work: string, out: string, manifest: any, exe: string, emit: (e: any) => void}} o
 */
async function makeKitZip(o) {
  if (!o.kitDir || !existsSync(w.join(o.kitDir, 'kit.mjs'))) throw new Error('the kit folder (with kit.mjs and lib) was not given');
  const kz = w.join(o.work, 'kit');
  await mkdir(w.join(kz, 'lib'), { recursive: true });
  await copyFile(w.join(o.kitDir, 'kit.mjs'), w.join(kz, 'kit.mjs'));
  for (const f of await readdir(w.join(o.kitDir, 'lib'))) if (f.endsWith('.mjs')) await copyFile(w.join(o.kitDir, 'lib', f), w.join(kz, 'lib', f));
  await writeFile(w.join(kz, 'manifest.json'), `${JSON.stringify(o.manifest, null, 2)}\n`, 'utf8');
  const readme = [w.join(o.kitDir, 'README.md'), w.join(o.kitDir, '..', 'README.md')].find((f) => existsSync(f));
  const entries = ['kit.mjs', 'lib', 'manifest.json'];
  if (readme) { await copyFile(readme, w.join(kz, 'README.md')); entries.push('README.md'); }
  const node = await officialNode(w.join(kz, 'node.exe'), o.work, o.emit);
  if (node.ok) entries.push('node.exe');
  else o.emit({ type: 'warn', text: `node.exe not in the kit (${node.why}): on the new laptop install Node.js first, then run node kit.mjs` });
  const listFile = w.join(o.work, 'kit-list.txt');
  await writeFile(listFile, `${entries.join('\r\n')}\r\n`, 'utf8');
  const zip = w.join(o.out, 'laptop-move-kit.zip');
  const r = await run(o.exe, ['a', '-tzip', zip, `@${listFile}`, '-scsUTF-8', '-spd', '-mx5', '-bb0', '-bd'], { cwd: kz, timeout: 600000 });
  if (r.code !== 0) throw new Error(`the kit zip failed: ${exitMeaning(r.code)} ${r.stderr.trim()}`);
  return zip;
}

/**
 * The official Windows node.exe: this one when its signature is valid and from the OpenJS Foundation, else the same
 * version downloaded from nodejs.org and checked against its SHASUMS256.txt and signature.
 * @param {string} dest
 * @param {string} work
 * @param {(e: any) => void} emit
 */
export async function officialNode(dest, work, emit) {
  const PUB = 'OpenJS Foundation';
  const here = await signedBy(process.execPath, PUB);
  if (here.ok) { await copyFile(process.execPath, dest); return { ok: true, why: 'this laptop\'s node.exe, signature valid' }; }
  const v = process.versions.node;
  emit({ type: 'step', text: `this node.exe is not the signed official one (${here.why}): downloading Node ${v} from nodejs.org` });
  const file = w.join(work, 'node-download', 'node.exe');
  const d = await download(`https://nodejs.org/dist/v${v}/win-x64/node.exe`, file, { quiet: true });
  if (!d.ok) return { ok: false, why: d.why };
  const sums = await fetchText(`https://nodejs.org/dist/v${v}/SHASUMS256.txt`);
  const want = sums ? nodeSum(sums) : null;
  if (!want || want !== (await sha256File(file))) return { ok: false, why: 'the download does not match nodejs.org\'s checksum' };
  const sig = await signedBy(file, PUB);
  if (!sig.ok) return { ok: false, why: sig.why };
  await copyFile(file, dest);
  return { ok: true, why: 'downloaded, checksum and signature valid' };
}

/** The checksum of win-x64/node.exe in nodejs.org's SHASUMS256.txt. @param {string} text */
export function nodeSum(text) {
  for (const l of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?win-x64\/node\.exe$/i.exec(l.trim());
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** The pack report: local only (it names client repositories to push), never inside the bundle. */
function packReport(/** @type {any} */ plan, /** @type {any} */ man, /** @type {string} */ out, /** @type {string} */ kitZip) {
  const parts = man.archives.flatMap((/** @type {any} */ a) => a.parts.map((/** @type {any} */ p) => [p.file, a.group === 'client' ? 'client part: company OneDrive only' : 'data part', fmtBytes(p.size), p.sha256]));
  parts.push([w.basename(kitZip), 'the kit: anywhere', '', '']);
  return htmlReport('Laptop move: pack report', `${out}, ${new Date().toLocaleString()}`, [
    { title: 'Files to upload', intro: `Upload every file of ${out}. Client parts go to the company OneDrive only; the kit, the data parts and SHA256SUMS.txt may go to any drive you choose. On the new laptop put them all in one folder.`, columns: ['File', 'Where', 'Size', 'SHA-256'], rows: parts },
    { title: 'Push first (client repositories with local work, not in the bundle)', columns: ['Repository', 'Branch', 'Unpushed', 'Stashes', 'Uncommitted'], rows: plan.pushFirst.map((/** @type {any} */ p) => [p.path, p.branch ?? 'detached', p.unpushed, p.stashes, p.dirty]) },
    { title: 'Move by hand (never copied)', columns: ['Path', 'Why'], rows: plan.byHand.map((/** @type {any} */ b) => [b.path, b.why]) },
    { title: 'Repositories', columns: ['Repository', 'How', 'Branch', 'Local work'], rows: plan.repos.map((/** @type {any} */ r) => [r.path, r.mode === 'clone' ? 'clone' : `clone + bundle${r.bundle ? '' : ' (nothing to bundle)'}`, r.branch ?? 'detached', `${r.unpushed} unpushed, ${r.stashes.length} stashes, ${r.dirtyCount} uncommitted`]) },
    { title: 'Folders and files', columns: ['Path', 'Kind', 'Size', 'Files'], rows: plan.units.map((/** @type {any} */ u) => [u.path, u.kind, fmtBytes(u.bytes), u.fileCount]) },
    { title: 'Links and junctions', columns: ['Link', 'Target'], rows: plan.links.map((/** @type {any} */ l) => [l.path, l.target]) },
    { title: 'Apps', columns: ['App', 'How'], rows: plan.apps.map((/** @type {any} */ a) => [a.name, a.kind === 'winget' ? `winget ${a.wingetId}` : a.kind === 'download' ? `download ${a.url}` : a.kind === 'npm' ? `npm -g ${a.pkg}` : a.kind === 'playwright' ? `Playwright ${(a.versions ?? []).join(', ')}` : `by hand: ${a.note ?? ''}`]) },
    { title: 'Your own steps on the new laptop', columns: ['Step'], rows: plan.userSteps.map((/** @type {string} */ s) => [s]) },
    { title: 'Warnings', columns: ['Warning'], rows: plan.warnings.map((/** @type {string} */ s) => [s]) },
  ]);
}
