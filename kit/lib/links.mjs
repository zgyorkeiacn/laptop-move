// Recreating junctions and links on the new laptop: cmd /c mklink /J for folders, mklink for files.
// An existing path is never replaced and never removed.
import { lstat, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { mapPath } from './paths.mjs';
import { run } from './util.mjs';

const w = path.win32;

/** Characters cmd.exe would read as its own (the kit then creates the junction through node instead). @param {string} p */
export function safeForCmd(p) {
  return !/["%^&|<>!\r\n]/.test(p);
}

/**
 * The command that recreates one link.
 * @param {string} link
 * @param {string} target
 * @param {boolean} dir
 * @returns {{file: string, args: string[], text: string}}
 */
export function mklinkCommand(link, target, dir) {
  const inner = dir ? `mklink /J "${link}" "${target}"` : `mklink "${link}" "${target}"`;
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${inner}"`], text: `cmd /c ${inner}` };
}

/**
 * Plans the links of the manifest for this laptop: paths and absolute targets mapped like every other path.
 * A relative target stays relative to the link's folder; a folder junction needs an absolute target, so it is resolved.
 * @param {{path: string, target: string, dir: boolean}[]} links
 * @param {{oldProfile?: string, newProfile?: string, targetRoot?: string}} m
 */
export function planLinks(links, m) {
  return links.filter((l) => l.target).map((l) => {
    const link = mapPath(l.path, m);
    const abs = /^[a-z]:\\/i.test(l.target);
    let target = abs ? mapPath(l.target, m) : l.target;
    if (l.dir && !abs) target = w.resolve(w.dirname(link), l.target);
    return { link, target, dir: l.dir, cmd: mklinkCommand(link, target, l.dir) };
  });
}

/**
 * Creates one planned link. Skips it when the path exists already.
 * @param {{link: string, target: string, dir: boolean, cmd: {file: string, args: string[], text: string}}} l
 * @returns {Promise<{ok: boolean, skipped?: boolean, why?: string}>}
 */
export async function createLink(l) {
  try { await lstat(l.link); return { ok: true, skipped: true, why: 'exists already' }; } catch { /* free */ }
  await mkdir(w.dirname(l.link), { recursive: true });
  if (safeForCmd(l.link) && safeForCmd(l.target)) {
    const r = await run(l.cmd.file, l.cmd.args, { verbatim: true, timeout: 30000 });
    if (r.code === 0) return { ok: true };
    if (l.dir) return { ok: false, why: (r.stdout + r.stderr).trim() || `mklink exit ${r.code}` };
    return { ok: false, why: `${(r.stdout + r.stderr).trim()} (a file link needs Developer Mode or an elevated prompt: run ${l.cmd.text} yourself)` };
  }
  try {
    await symlink(l.target, l.link, l.dir ? 'junction' : 'file');
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(/** @type {any} */ (e).message) };
  }
}
