// winget: a read-only lookup on the old laptop (winget show), install on the new one (winget install).
// The lookup also records the installer's official link, checksum and publisher, so the new laptop can download it
// itself when winget is missing there.
import { run, runInherit } from './util.mjs';

const COMMON = ['--accept-source-agreements', '--disable-interactivity'];

/** winget's console output without its spinner: the last carriage-return segment of every line. @param {string} text */
export function cleanLines(text) {
  return String(text).split('\n').map((l) => l.split('\r').filter((s) => s.trim() !== '').pop() ?? '').map((l) => l.trimEnd());
}

/**
 * Parses `winget show --id X -e`.
 * @param {string} text
 * @returns {{found: boolean, name?: string, id?: string, version?: string, publisher?: string, installerType?: string, installerUrl?: string, sha256?: string}}
 */
export function parseShow(text) {
  const lines = cleanLines(text);
  const found = lines.map((l) => /^Found (.+) \[([^\]]+)\]\s*$/.exec(l.trim())).find(Boolean);
  if (!found) return { found: false };
  /** @param {string} key */
  const field = (key) => {
    const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'i');
    for (const l of lines) { const m = re.exec(l); if (m) return m[1].trim(); }
    return undefined;
  };
  return {
    found: true,
    name: found[1].trim(),
    id: found[2].trim(),
    version: field('Version'),
    publisher: field('Publisher'),
    installerType: field('Installer Type')?.toLowerCase(),
    installerUrl: field('Installer Url'),
    sha256: field('Installer SHA256')?.toLowerCase(),
  };
}

/**
 * How a downloaded installer runs: its silent switches by installer type. Null when the kit cannot run it (by hand).
 * A plain exe runs with its own window: the user answers only what the installer asks.
 * @param {string|undefined} type
 * @param {string} file
 * @returns {{file: string, args: string[], interactive: boolean}|null}
 */
export function silentArgs(type, file) {
  switch ((type ?? '').toLowerCase()) {
    case 'msi': case 'wix': return { file: 'msiexec.exe', args: ['/i', file, '/passive', '/norestart'], interactive: false };
    case 'inno': return { file, args: ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], interactive: false };
    case 'nullsoft': return { file, args: ['/S'], interactive: false };
    case 'burn': return { file, args: ['/passive', '/norestart'], interactive: false };
    case 'exe': return { file, args: [], interactive: true };
    default: return null; // msix, appx, portable, zip and unknown types: by hand or handled apart
  }
}

const SUFFIX = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'bv', 'b', 'v', 'sa', 'srl', 'plc', 'pty', 'oy', 'ab', 'as', 'the', 'foundation', 'stichting', 'software', 'technologies', 'technology']);

/** @param {string} s */
function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !SUFFIX.has(t));
}

/** The CN and O of a certificate subject ("CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, ..."). @param {string} subject */
export function subjectNames(subject) {
  const out = [];
  for (const m of String(subject).matchAll(/(?:^|,\s*)(CN|O)=("([^"]*)"|[^,]*)/g)) out.push((m[3] ?? m[2]).trim());
  return out;
}

/**
 * True when the signer of a file is the recorded publisher: every word of the publisher (company suffixes left out)
 * is in the signer's CN or O, or the other way round.
 * @param {string|undefined} publisher
 * @param {string} subject
 */
export function publisherMatches(publisher, subject) {
  const want = tokens(publisher ?? '');
  if (!want.length) return false;
  return subjectNames(subject).some((n) => {
    const have = tokens(n);
    if (!have.length) return false;
    const a = new Set(have);
    const b = new Set(want);
    return want.every((t) => a.has(t)) || have.every((t) => b.has(t));
  });
}

/** True when winget answers on this laptop. */
export async function wingetAvailable() {
  const r = await run('winget', ['--version'], { timeout: 60000 });
  return r.code === 0 && /v?\d+\.\d+/.test(r.stdout);
}

/** Read-only lookup of one package. @param {string} id */
export async function wingetShow(id) {
  const r = await run('winget', ['show', '--id', id, '-e', ...COMMON], { timeout: 120000 });
  return parseShow(r.stdout);
}

/** True when the package is installed already. @param {string} id */
export async function wingetInstalled(id) {
  const r = await run('winget', ['list', '--id', id, '-e', ...COMMON], { timeout: 120000 });
  return r.code === 0 && cleanLines(r.stdout).some((l) => l.toLowerCase().includes(id.toLowerCase()));
}

/**
 * Arguments for winget install.
 * @param {string} id
 * @param {{version?: string, override?: string}} [o]
 */
export function installArgs(id, o = {}) {
  return ['install', '--id', id, '-e', '--accept-package-agreements', ...COMMON, ...(o.version ? ['--version', o.version] : []), ...(o.override ? ['--override', o.override] : [])];
}

/** Installs one package, its progress on the user's console. @param {string} id @param {{version?: string, override?: string}} [o] */
export function wingetInstall(id, o = {}) {
  return runInherit('winget', installArgs(id, o));
}

/** Meaning of winget's exit code. @param {number} code */
export function installMeaning(code) {
  const hex = (code >>> 0).toString(16).toUpperCase();
  if (code === 0) return { ok: true, text: 'installed' };
  if (hex === '8A150061' || hex === '8A15002B') return { ok: true, text: 'installed already' };
  if (hex === '8A150109' || code === 3010) return { ok: true, text: 'installed, restart needed' };
  if (hex === '8A150014') return { ok: false, text: 'no package found with this id' };
  return { ok: false, text: `winget exit 0x${hex}` };
}
