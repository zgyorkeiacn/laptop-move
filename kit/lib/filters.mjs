// What never goes into the bundle: regenerable folders (node_modules, build output, caches, .temp) and secret-bearing files.
// A secret-bearing file is never copied, even when the user ticked it: it is listed as "move by hand". Files are judged by
// name and place only; the kit never opens them.

/** Regenerable folders, skipped anywhere outside a .git folder. */
export const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', '.cache', 'dist', 'out', 'build', '.next', '.nuxt', '.svelte-kit', '.angular', '__pycache__',
  '.temp', '.tmp', 'coverage', '.turbo', '.parcel-cache', 'target', '.gradle', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv', 'test-results', 'playwright-report', 'blob-report', '.nyc_output',
]);

/** Caches of desktop apps (Electron and Chromium), skipped below an AppData folder. */
export const APP_CACHE_DIRS = new Set([
  'cache', 'code cache', 'gpucache', 'cacheddata', 'cachedextensionvsixs', 'cachedextensions', 'cachedprofilesdata', 'crashpad',
  'crashpad_handler', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'shadercache', 'grshadercache', 'graphitedawncache',
  'service worker', 'blob_storage', 'logs', 'temp', 'tmp', 'webstorage', 'component_crx_cache', 'extensions_crx_cache',
]);

/** Folders that hold keys or tokens: the whole folder is moved by hand. */
export const SECRET_DIRS = [/^\.ssh$/i, /^\.aws$/i, /^\.azure$/i, /^\.gnupg$/i, /^\.kube$/i, /^\.docker$/i, /^\.credentials$/i, /^credentials$/i, /^\.password-store$/i];

/** Secret-bearing file names. */
export const SECRET_FILES = [
  [/^\.env(\..+)?$/i, 'environment file'],
  [/^\.npmrc$/i, 'npm config (tokens)'],
  [/^\.yarnrc(\.yml)?$/i, 'yarn config (tokens)'],
  [/^\.pypirc$/i, 'Python package index config'],
  [/^\.git-credentials$/i, 'git credentials'],
  [/^_?\.?netrc$/i, 'netrc credentials'],
  [/^id_(rsa|dsa|ed25519|ecdsa)(_sk)?(\.pub)?$/i, 'SSH key'],
  [/\.(pem|pfx|p12|key|ppk|crt|cer|der|jks|keystore|kdbx|gpg|asc|ovpn|p8)$/i, 'key or certificate'],
  [/^client_secret.*\.json$/i, 'OAuth client secret'],
  [/^\.?credentials(\.json)?$/i, 'credentials file'],
  [/^accounts\.json$/i, 'account store'],
  [/^pat-status\.json$/i, 'token status'],
  [/^settings\.xml$/i, 'Maven settings (server passwords)'],
  [/^(token|tokens|token\.json|token\.txt|\.token)$/i, 'token file'],
  [/^secrets?(\..+)?$/i, 'secret store'],
  [/keystore|keychain|key-store/i, 'key store'],
  [/^keys?\.(json|bin|dat|enc)$/i, 'key store'],
  [/\.vault$/i, 'vault file'],
  [/^\.claude\.json(\.backup.*)?$/i, 'Claude Code state (may hold MCP server tokens)'],
  [/^Login Data( For Account)?(-journal)?$/i, 'browser passwords'],
  [/^Cookies(-journal)?$/i, 'browser cookies'],
  [/^Web Data(-journal)?$/i, 'browser form data'],
  [/^Local State$/i, 'browser key file'],
];

/** Windows' own files in the user folder: never copied, the new profile has its own. */
const SYSTEM_FILES = [/^ntuser\./i, /^usrclass\.dat/i, /\.regtrans-ms$/i, /\.blf$/i];

/** The user folder's built-in junctions (the new profile has them already). */
export const SYSTEM_LINK_NAMES = new Set(['application data', 'cookies', 'local settings', 'my documents', 'nethood', 'printhood', 'recent',
  'sendto', 'start menu', 'templates', 'my music', 'my pictures', 'my videos', 'history', 'temporary internet files']);

/**
 * Judges a file by its name.
 * @param {string} name
 * @param {string} [parentLower] the parent folder, lower case
 * @returns {{kind: 'secret'|'system', why: string}|null}
 */
export function classifyFile(name, parentLower = '') {
  if (parentLower.endsWith('\\.git') || parentLower.includes('\\.git\\')) {
    return null; // git's own files (config is checked apart for passwords in remote URLs)
  }
  for (const [re, why] of SECRET_FILES) if (/** @type {RegExp} */ (re).test(name)) return { kind: 'secret', why: /** @type {string} */ (why) };
  if (SYSTEM_FILES.some((re) => re.test(name))) return { kind: 'system', why: 'Windows profile file' };
  return null;
}

/**
 * Judges a folder by its name, place and (for browser profiles) its entries.
 * @param {string} name
 * @param {string} parentLower the parent folder, lower case
 * @param {string[]} [childNames] the folder's own entries, when known
 * @returns {{kind: 'skip'|'secret', why: string}|null}
 */
export function classifyDir(name, parentLower, childNames) {
  const lower = name.toLowerCase();
  if (parentLower.endsWith('\\.git') || parentLower.includes('\\.git\\')) return null;
  if (SECRET_DIRS.some((re) => re.test(name))) return { kind: 'secret', why: 'keys or tokens folder' };
  if (SKIP_DIRS.has(lower)) return { kind: 'skip', why: lower === 'node_modules' ? 'node_modules (installed again)' : 'build output or cache' };
  if (parentLower.includes('\\appdata\\') && APP_CACHE_DIRS.has(lower)) return { kind: 'skip', why: 'app cache' };
  if ((lower === 'workspacestorage' || lower === 'globalstorage') && parentLower.endsWith('\\user')) return { kind: 'skip', why: 'editor state (rebuilt by the editor)' };
  if (childNames && isBrowserProfile(childNames)) return { kind: 'secret', why: 'browser profile: sign in again and let it sync' };
  return null;
}

/** A Chromium user-data folder: a Local State file next to a Default or Profile N folder. @param {string[]} names */
export function isBrowserProfile(names) {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return set.has('local state') && (set.has('default') || names.some((n) => /^profile \d+$/i.test(n)));
}

/** A remote URL with a password in it (https://user:pass@host): the repository's .git\config is then moved by hand. @param {string} url */
export function urlHasPassword(url) {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@:]+:[^/@]+@/i.test(url);
}

/** The URL without its password. @param {string} url */
export function redactUrl(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:]+):[^/@]+@/i, '$1@');
}
