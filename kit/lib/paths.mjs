// Path rules: normalising, containment, the archive path of a file, and mapping an old path to the new laptop.
import path from 'node:path';

const w = path.win32;

/** Normalises a Windows path: absolute, backslashes, no trailing backslash except on a drive root. @param {string} p */
export function norm(p) {
  let r = w.normalize(String(p).trim().replace(/\//g, '\\'));
  if (/^[a-z]:/.test(r)) r = r[0].toUpperCase() + r.slice(1);
  if (r.length > 3 && r.endsWith('\\')) r = r.slice(0, -1);
  return r;
}

/** True when child is parent or inside it (case-insensitive, whole segments). @param {string} child @param {string} parent */
export function isInside(child, parent) {
  const c = norm(child).toLowerCase();
  const p = norm(parent).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith('\\') ? p : `${p}\\`);
}

/** The drive letter of an absolute path, upper case. @param {string} p */
export function driveOf(p) {
  const m = /^([a-z]):\\/i.exec(norm(p));
  if (!m) throw new Error(`not an absolute drive path: ${p}`);
  return m[1].toUpperCase();
}

/** Where a file sits inside its drive's archive: { drive: 'C', rel: 'git_accenture\\x\\y' }. @param {string} p */
export function archiveRel(p) {
  const n = norm(p);
  return { drive: driveOf(n), rel: n.slice(3) };
}

/**
 * Maps a path recorded on the old laptop to the new one: the old user folder becomes the new user folder;
 * with a targetRoot (tests and trial runs) every path is re-rooted below it as <root>\<drive>\<rest>.
 * @param {string} p
 * @param {{oldProfile?: string, newProfile?: string, targetRoot?: string}} m
 */
export function mapPath(p, m) {
  let r = norm(p);
  if (m.oldProfile && m.newProfile && isInside(r, m.oldProfile)) {
    r = norm(m.newProfile + r.slice(norm(m.oldProfile).length));
  }
  if (m.targetRoot) {
    const { drive, rel } = archiveRel(r);
    r = norm(w.join(m.targetRoot, drive, rel));
  }
  return r;
}

/** True for a OneDrive-synced folder: a segment named OneDrive or "OneDrive - <org>", or below a OneDrive root from the environment. @param {string} p */
export function isOneDrive(p) {
  const n = norm(p);
  if (/\\OneDrive( - [^\\]+)?(\\|$)/i.test(n)) return true;
  return ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'].some((k) => process.env[k] && isInside(n, process.env[k] ?? ''));
}

/**
 * Why a folder may not take the kit's output, or null.
 * Client folders from the rules file (for example the client's OneDrive) are refused always;
 * any other OneDrive folder only without allowOneDrive (the kit writes locally, the user uploads).
 * @param {string} p
 * @param {{forbiddenOut?: string[]}} rules
 * @param {boolean} [allowOneDrive]
 */
export function outProblem(p, rules, allowOneDrive = false) {
  const n = norm(p);
  if (!/^[a-z]:\\/i.test(n)) return 'name an absolute folder on a local drive, for example C:\\LaptopMove';
  for (const f of rules.forbiddenOut ?? []) if (isInside(n, f)) return `${f} is a client folder: the bundle is never written there`;
  if (isOneDrive(n) && !allowOneDrive) return 'this folder is synced by OneDrive: name a local folder (the kit uploads nothing), or add --allow-onedrive for your own Accenture OneDrive (never a client\'s)';
  return null;
}

/** Expands %VAR% from the environment. @param {string} s */
export function expandEnv(s) {
  return String(s).replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m);
}

/** Relative path from base to p (both absolute), with backslashes. @param {string} base @param {string} p */
export function relFrom(base, p) {
  return w.relative(norm(base), norm(p));
}
