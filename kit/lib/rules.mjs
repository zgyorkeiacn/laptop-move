// Client rules: which folders and remotes belong to a client. They live in a small local file next to the selection
// (laptop-move-client.json), never in the code, so the kit names no client and fits any user:
// { "clientRoots": ["C:\\client-repos"], "clientRemotePatterns": ["client-org", "dev\\.azure\\.com/client"], "forbiddenOut": ["%USERPROFILE%\\OneDrive - Client"] }
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { norm, isInside, expandEnv } from './paths.mjs';

/** @typedef {{file: string|null, clientRoots: string[], clientRemotes: RegExp[], forbiddenOut: string[]}} Rules */

/** @returns {Rules} */
export function emptyRules() {
  return { file: null, clientRoots: [], clientRemotes: [], forbiddenOut: [] };
}

/**
 * @param {any} json
 * @param {string|null} file
 * @returns {Rules}
 */
export function parseRules(json, file = null) {
  const list = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return {
    file,
    clientRoots: list(json?.clientRoots).map((p) => norm(expandEnv(p))),
    clientRemotes: list(json?.clientRemotePatterns).map((s) => new RegExp(s, 'i')),
    forbiddenOut: list(json?.forbiddenOut).map((p) => norm(expandEnv(p))),
  };
}

/** Reads the rules file; null when it does not exist. @param {string} file */
export async function readRules(file) {
  if (!existsSync(file)) return null;
  return parseRules(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')), file);
}

/** @param {string} p @param {Rules} r */
export function isClientPath(p, r) {
  return r.clientRoots.some((root) => isInside(p, root)) || r.forbiddenOut.some((f) => isInside(p, f));
}

/** @param {string|null|undefined} url @param {Rules} r */
export function isClientRemote(url, r) {
  return !!url && r.clientRemotes.some((re) => re.test(url));
}
