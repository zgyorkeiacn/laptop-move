// Reads the selection file the form saves (laptop-move-selection.json). The format is the form's own and is kept as is:
// { savedAt, folders: [{ path, mode }], applications: [{ name, wingetId, source }], settings: [{ app, how }], questions, comments }.
import { readFile } from 'node:fs/promises';
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
  const text = await readFile(file, 'utf8');
  return parseSelection(JSON.parse(text.replace(/^﻿/, '')));
}
