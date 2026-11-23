// Walks a picked folder read only: the files to pack, the junctions and links to recreate, the secret-bearing files to
// move by hand, and the git repositories met on the way. Never follows a junction or link, never opens a file.
import { readdir, lstat, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { classifyDir, classifyFile, isBrowserProfile, SYSTEM_LINK_NAMES } from './filters.mjs';
import { isInside, norm } from './paths.mjs';

const w = path.win32;

/** @typedef {{path: string, size: number, repo?: string}} FileItem */
/** @typedef {{path: string, target: string, dir: boolean}} LinkItem */
/** @typedef {{path: string, why: string}} ByHand */

/**
 * @param {string} root a folder, or a single file
 * @param {{exclude?: string[], loose?: boolean, onProgress?: (n: number) => void}} [o]
 *   exclude: folders handled apart (other picks, the kit's own output); loose: only the files directly in root
 */
export async function walk(root, o = {}) {
  const exclude = (o.exclude ?? []).map(norm);
  /** @type {FileItem[]} */ const files = [];
  /** @type {LinkItem[]} */ const links = [];
  /** @type {ByHand[]} */ const byHand = [];
  /** @type {{path: string, why: string}[]} */ const skipped = [];
  /** @type {{path: string, why: string}[]} */ const errors = [];
  /** @type {string[]} */ const repos = [];
  let bytes = 0;

  /** @param {string} p */
  async function addLink(p) {
    let target = '';
    try { target = await readlink(p); } catch { /* unreadable target: recorded empty */ }
    const name = w.basename(p).toLowerCase();
    if (SYSTEM_LINK_NAMES.has(name)) return;
    let dir = true;
    try { dir = (await stat(p)).isDirectory(); } catch { dir = !/\.[a-z0-9]{1,5}$/i.test(target); }
    links.push({ path: p, target: target.replace(/^\\\\\?\\/, ''), dir });
  }

  /** @param {string} dir @param {string|undefined} repo */
  async function visit(dir, repo) {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch (e) { errors.push({ path: dir, why: /** @type {any} */ (e).code ?? 'cannot read' }); return; }
    const names = ents.map((e) => e.name);
    if (!o.loose && isBrowserProfile(names)) { byHand.push({ path: dir, why: 'browser profile: sign in again and let it sync' }); return; }
    const here = names.includes('.git') ? dir : repo;
    if (here === dir && !o.loose) repos.push(dir);
    const parentLower = dir.toLowerCase();
    for (const e of ents) {
      const p = w.join(dir, e.name);
      if (exclude.some((x) => isInside(p, x))) continue;
      let st;
      try { st = await lstat(p); } catch (err) { errors.push({ path: p, why: /** @type {any} */ (err).code ?? 'cannot stat' }); continue; }
      if (st.isSymbolicLink()) { if (!o.loose) await addLink(p); continue; }
      if (st.isDirectory()) {
        if (o.loose) continue;
        const c = classifyDir(e.name, parentLower);
        if (c?.kind === 'secret') { byHand.push({ path: p, why: c.why }); continue; }
        if (c?.kind === 'skip') { skipped.push({ path: p, why: c.why }); continue; }
        await visit(p, here);
        continue;
      }
      if (!st.isFile()) continue;
      const c = classifyFile(e.name, parentLower);
      if (c?.kind === 'secret') { byHand.push({ path: p, why: c.why }); continue; }
      if (c?.kind === 'system') continue;
      files.push(here ? { path: p, size: st.size, repo: here } : { path: p, size: st.size });
      bytes += st.size;
      if (o.onProgress && files.length % 5000 === 0) o.onProgress(files.length);
    }
  }

  const r = norm(root);
  let st;
  try { st = await lstat(r); } catch { return { root: r, missing: true, files, links, byHand, skipped, errors, repos, bytes }; }
  if (st.isSymbolicLink()) { await addLink(r); return { root: r, missing: false, files, links, byHand, skipped, errors, repos, bytes }; }
  if (st.isFile()) {
    const c = classifyFile(w.basename(r), w.dirname(r).toLowerCase());
    if (c?.kind === 'secret') byHand.push({ path: r, why: c.why });
    else if (!c) { files.push({ path: r, size: st.size }); bytes += st.size; }
    return { root: r, missing: false, files, links, byHand, skipped, errors, repos, bytes };
  }
  const top = classifyDir(w.basename(r), w.dirname(r).toLowerCase(), await readdir(r).catch(() => undefined));
  if (top?.kind === 'secret') { byHand.push({ path: r, why: top.why }); return { root: r, missing: false, files, links, byHand, skipped, errors, repos, bytes }; }
  await visit(r, undefined);
  return { root: r, missing: false, files, links, byHand, skipped, errors, repos, bytes };
}
