// Reads the selection file the form saves (laptop-move-selection.json). The format is the form's own and is kept as is:
// { savedAt, folders: [{ path, mode }], applications: [{ name, wingetId, source }], settings: [{ app, how }], questions, comments }.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { norm, isInside } from './paths.mjs';

/** @typedef {'copy'|'bundle'|'clone'|'byhand'|'skip'|'unknown'} Mode */
/** @typedef {{path: string, mode: Mode, raw: string, loose: boolean, covered?: boolean, exclude: string[], parent?: string}} Entry */
/** @typedef {{key: string, name: string, wingetId: string, source: string}} AppPick */

/** The form's mode labels, and what the kit does with each. */
export const MODE_LABELS = {
  'copy whole': 'copy',
  'clone again + bundle/dirty': 'bundle',
  'clone again': 'clone',
  'by hand': 'byhand',
};

/** @param {unknown} m @returns {Mode} */
export function normMode(m) {
  const k = String(m ?? '').trim().toLowerCase();
  if (k in MODE_LABELS) return /** @type {Mode} */ (MODE_LABELS[/** @type {keyof typeof MODE_LABELS} */ (k)]);
  if (/^(leave|skip|no\b|not\b|don't|do not)/.test(k)) return 'skip';
  if (/bundle|dirty/.test(k)) return 'bundle';
  if (/^clone/.test(k)) return 'clone';
  if (/^copy/.test(k)) return 'copy';
  if (/hand/.test(k)) return 'byhand';
  return 'unknown';
}

/** The form writes the user folder's loose files as "<profile>\ (loose files and .gitconfig)". */
const LOOSE = /^(.*?)\\?\s*\(loose files[^)]*\)\s*$/i;

/**
 * Parses the selection object. Unknown fields are ignored, unknown modes become by-hand entries with a warning.
 * @param {any} json
 */
export function parseSelection(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.folders)) throw new Error('not a laptop-move selection file: no folders list');
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, Entry>} */
  const byPath = new Map();
  for (const f of json.folders) {
    if (!f || typeof f.path !== 'string' || !f.path.trim()) continue;
    const m = LOOSE.exec(f.path.trim());
    const p = norm(m ? m[1] : f.path);
    const mode = normMode(f.mode);
    if (mode === 'unknown') warnings.push(`unknown mode "${f.mode}" for ${p}: treated as by hand`);
    const key = `${p.toLowerCase()}|${m ? 'loose' : ''}`;
    if (byPath.has(key)) { warnings.push(`listed twice: ${p} (first one kept)`); continue; }
    byPath.set(key, { path: p, mode: mode === 'unknown' ? 'byhand' : mode, raw: String(f.mode ?? ''), loose: !!m, exclude: [] });
  }
  const entries = resolveNesting([...byPath.values()]);
  /** @type {Map<string, AppPick>} */
  const apps = new Map();
  for (const a of json.applications ?? []) {
    if (!a || typeof a.name !== 'string') continue;
    const wingetId = String(a.wingetId ?? '').trim();
    const key = (wingetId || a.name).toLowerCase();
    if (apps.has(key)) continue;
    apps.set(key, { key, name: a.name.trim(), wingetId, source: String(a.source ?? (wingetId ? 'winget' : 'download')).toLowerCase() });
  }
  const settings = (json.settings ?? []).filter((s) => s && typeof s.app === 'string').map((s) => ({ app: s.app, how: String(s.how ?? '') }));
  return {
    savedAt: json.savedAt ?? null,
    entries,
    apps: [...apps.values()],
    settings,
    questions: Array.isArray(json.questions) ? json.questions : [],
    comments: json.comments ?? {},
    npmCi: Array.isArray(json.npmCi) ? json.npmCi.map(String) : [],
    warnings,
  };
}

/**
 * Nested picks: a copy entry inside a copy entry is covered by its parent (dropped);
 * every other entry inside a copy or loose entry is left out of the parent's copy and handled on its own.
 * @param {Entry[]} list
 * @returns {Entry[]}
 */
export function resolveNesting(list) {
  const sorted = [...list].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  for (const e of sorted) {
    const parents = sorted.filter((p) => p !== e && !p.loose && p.path.length < e.path.length && isInside(e.path, p.path));
    const parent = parents[parents.length - 1];
    if (!parent) continue;
    e.parent = parent.path;
    if (parent.mode === 'copy' && e.mode === 'copy' && !e.loose) e.covered = true;
  }
  for (const e of sorted) {
    if (e.covered || e.loose) continue;
    e.exclude = sorted.filter((c) => c !== e && !c.covered && !c.loose && c.path.length > e.path.length && isInside(c.path, e.path)).map((c) => c.path);
  }
  return sorted;
}

/** @param {string} file */
export async function readSelection(file) {
  return parseSelection(await readSelectionRaw(file));
}

/** The selection file as the form wrote it (checked, not parsed into entries). @param {string} file */
export async function readSelectionRaw(file) {
  const text = await readFile(file, 'utf8');
  const json = JSON.parse(text.replace(/^\uFEFF/, ''));
  parseSelection(json);
  return json;
}

/**
 * The selection in the form's own format and key order (savedAt, folders, applications, settings, questions, comments,
 * commentLabels), so the form and the kit both read it. Fields the kit does not know are kept after these.
 * @param {any} json
 * @param {{savedAt?: string}} [o]
 */
export function normalizeSelection(json, o = {}) {
  parseSelection(json);
  const str = (/** @type {unknown} */ v) => (v == null ? '' : String(v));
  /** @type {Record<string, any>} */
  const out = {
    savedAt: o.savedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    folders: json.folders.filter((/** @type {any} */ f) => f && typeof f.path === 'string' && f.path.trim())
      .map((/** @type {any} */ f) => ({ path: f.path, mode: str(f.mode) })),
    applications: (Array.isArray(json.applications) ? json.applications : []).filter((/** @type {any} */ a) => a && typeof a.name === 'string')
      .map((/** @type {any} */ a) => ({ name: a.name, wingetId: str(a.wingetId), source: str(a.source) })),
    settings: (Array.isArray(json.settings) ? json.settings : []).filter((/** @type {any} */ s) => s && typeof s.app === 'string')
      .map((/** @type {any} */ s) => ({ app: s.app, how: str(s.how) })),
    questions: Array.isArray(json.questions) ? json.questions : [],
    comments: json.comments && typeof json.comments === 'object' ? json.comments : {},
    commentLabels: json.commentLabels && typeof json.commentLabels === 'object' ? json.commentLabels : {},
  };
  for (const [k, v] of Object.entries(json)) if (!(k in out)) out[k] = v;
  return out;
}

/** The selection file's text: the form saves it with one space of indent. @param {any} json */
export function selectionText(json) {
  return `${JSON.stringify(json, null, 1)}\n`;
}

/**
 * Saves a selection in the form's format. An existing file is first copied to <name>.<date>T<hhmm>.bak.json next to
 * it; the new text is written to a temporary file and then renamed over the old one.
 * @param {string} file
 * @param {any} json
 * @param {{savedAt?: string}} [o]
 * @returns {Promise<{file: string, backup: string|null, json: any}>}
 */
export async function saveSelection(file, json, o = {}) {
  const data = normalizeSelection(json, o);
  const dir = path.win32.dirname(file);
  await mkdir(dir, { recursive: true });
  let backup = null;
  if (existsSync(file)) {
    const d = new Date();
    const p2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const tag = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    backup = path.win32.join(dir, `${path.win32.basename(file).replace(/\.json$/i, '')}.${tag}.bak.json`);
    await copyFile(file, backup);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, selectionText(data), 'utf8');
  await rename(tmp, file);
  return { file, backup, json: data };
}
