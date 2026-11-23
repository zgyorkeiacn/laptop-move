// The user interface's server. The mover's own node serves the page on 127.0.0.1 only, on a free port, and drives the
// engine (lib\engine.mjs) through its functions and events: it holds no move logic of its own.
// Who may talk to it: the one-time token in the first URL buys a session cookie (the token is spent then); every API
// call also carries a key the page got with its HTML, so another page in the browser can neither read nor send
// anything. Host and Origin must be this server's own, so a DNS trick cannot reach it either.
// The password: it comes in the body of one POST, goes to the engine's getPassword (7-Zip reads it from a pipe) and is
// dropped; it is never logged, stored, sent back or put in an event.
// It ends when the page is closed (the event stream is its heartbeat), when the user presses End, or on Ctrl+C.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultEngine from '../lib/engine.mjs';
import { openFile } from '../lib/env.mjs';
import { parseSize } from '../lib/util.mjs';

const w = path.win32;
const UI_DIR = w.dirname(fileURLToPath(import.meta.url));
const KIT_DIR = w.dirname(UI_DIR);
const STATIC = { '/app.css': ['app.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/guide.js': ['guide.js', 'text/javascript'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 5 * 1024 * 1024;
/** The guide's topics, in reading order: kit\ui\guide\<topic>.html each. */
export const GUIDE_TOPICS = ['start', 'scan', 'choose', 'byhand', 'dryrun', 'password', 'pack', 'upload', 'restore', 'report', 'faq', 'security'];

/** Compares two secrets in constant time. @param {unknown} a @param {string} b */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The cookies of a request. @param {string|undefined} header */
export function cookies(header) {
  /** @type {Record<string, string>} */ const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** @param {string} s */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** An error with an HTTP status. @param {number} status @param {string} message */
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * The dry run's plan as the page shows it: counts, sizes and paths, never the file lists or a remote's URL.
 * @param {any} plan
 */
export function planSummary(plan) {
  const t = plan.totals;
  return {
    selectionFile: plan.selectionFile,
    savedAt: plan.savedAt,
    rulesFile: plan.rulesFile,
    rulesFound: plan.rulesFound,
    volumeBytes: plan.volumeBytes,
    totals: { data: t.data, client: t.client, dataEstimate: t.dataEstimate, clientEstimate: t.clientEstimate },
    units: plan.units.map((/** @type {any} */ u) => ({ path: u.path, kind: u.kind, app: u.app ?? null, bytes: u.bytes, fileCount: u.fileCount, group: u.group, skippedCount: u.skippedCount ?? 0 })),
    repos: plan.repos.map((/** @type {any} */ r) => ({ path: r.path, mode: r.mode, client: !!r.client, branch: r.branch ?? null, unpushed: r.unpushed, stashes: r.stashes.length, dirty: r.dirtyCount, worktree: !!r.worktreeOf, note: r.note ?? '' })),
    pushFirst: plan.pushFirst.map((/** @type {any} */ p) => ({ path: p.path, unpushed: p.unpushed, stashes: p.stashes, dirty: p.dirty })),
    byHand: plan.byHand.map((/** @type {any} */ b) => ({ path: b.path, why: b.why, group: b.group ?? 'data' })),
    links: plan.links.length,
    apps: plan.apps.map((/** @type {any} */ a) => ({ name: a.name ?? a.pkg ?? a.kind, kind: a.kind, wingetId: a.wingetId ?? null, note: a.note ?? '' })),
    userSteps: plan.userSteps,
    skipped: plan.skipped,
    warnings: plan.warnings,
  };
}

/** What a manifest tells the restore screen. @param {any} m */
export function manifestSummary(m) {
  return {
    host: m.host, createdAt: m.createdAt, encrypted: !!m.encrypted, hasClientPart: !!m.hasClientPart,
    archives: (m.archives ?? []).map((/** @type {any} */ a) => ({ name: a.name, group: a.group, parts: a.parts.length, bytes: a.parts.reduce((/** @type {number} */ s, /** @type {any} */ p) => s + p.size, 0) })),
    totals: m.totals, apps: (m.apps ?? []).length, repos: (m.repos ?? []).length, units: (m.units ?? []).length,
    userSteps: m.userSteps ?? [], byHand: (m.byHand ?? []).map((/** @type {any} */ b) => ({ path: b.path, why: b.why })),
  };
}

/** The restore result as the report screen shows it. @param {{report: string, results: Record<string, any[]>, warnings: string[]}} r */
export function restoreSummary(r) {
  /** @type {Record<string, {name: string, status: string, detail: string}[]>} */ const sections = {};
  for (const [k, rows] of Object.entries(r.results)) sections[k] = rows.slice(0, 300).map((x) => ({ name: String(x.name ?? ''), status: String(x.status ?? ''), detail: String(x.detail ?? '') }));
  return { report: r.report, sections, warnings: r.warnings };
}

/**
 * Starts the server.
 * @param {{kitDir?: string, selection?: string, rulesFile?: string, noClientRules?: boolean, scanRoots?: string[],
 *   appLookup?: boolean, open?: boolean, idleMs?: number, graceMs?: number, engine?: any, from?: string, work?: string,
 *   log?: (s: string) => void}} [o]
 * @returns {Promise<{url: string, port: number, token: string, close: () => Promise<void>, closed: Promise<void>}>}
 */
export async function startServer(o = {}) {
  const engine = o.engine ?? defaultEngine;
  const kitDir = o.kitDir ?? KIT_DIR;
  const idleMs = o.idleMs ?? 15000;
  const graceMs = o.graceMs ?? 10 * 60 * 1000;
  const log = o.log ?? (() => {});
  const token = randomBytes(24).toString('base64url');
  const session = randomBytes(24).toString('base64url');
  const apiKey = randomBytes(24).toString('base64url');
  let tokenSpent = false;
  let port = 0;
  /** Files and folders this server produced: the only ones /api/open opens. */
  const produced = new Set();
  const newLaptop = existsSync(w.join(kitDir, 'manifest.json'));

  /** @type {{file: string|null, name: string|null, json: any}|null} */
  let sel = null;
  const first = o.selection ?? (newLaptop ? null : engine.selectionCandidates().find((/** @type {string} */ f) => existsSync(f)) ?? null);
  /** @type {string|null} */ let selError = null;
  if (first) {
    try { sel = { file: first, name: w.basename(first), json: await engine.readSelectionRaw(first) }; } catch (e) { selError = `${first}: ${/** @type {Error} */ (e).message}`; }
  }

  // jobs: one at a time; its events go to every open page and the last ones are kept for a page that reconnects.
  /** @type {{id: number, kind: string, state: string, events: any[], progress: any, result: any, error: string|null, startedAt: string, endedAt: string|null}|null} */
  let job = null;
  let jobSeq = 0;
  /** @type {Set<http.ServerResponse>} */ const streams = new Set();
  /** @param {any} msg */
  const broadcast = (msg) => { const data = `data: ${JSON.stringify(msg)}\n\n`; for (const s of streams) s.write(data); };
  const publicJob = (/** @type {typeof job} */ j) => (j ? { id: j.id, kind: j.kind, state: j.state, events: j.events, progress: j.progress, result: j.result, error: j.error, startedAt: j.startedAt, endedAt: j.endedAt } : null);
  const running = () => job?.state === 'running';

  /**
   * @param {string} kind
   * @param {(emit: (e: any) => void) => Promise<any>} fn
   * @param {(s: string) => string} [scrub] removes a secret from a text (the password, while the job runs)
   */
  const startJob = (kind, fn, scrub = (s) => s) => {
    if (running()) throw fail(409, `another task is running (${job?.kind}): wait until it ends`);
    const j = { id: ++jobSeq, kind, state: 'running', events: /** @type {any[]} */ ([]), progress: null, result: null, error: /** @type {string|null} */ (null), startedAt: new Date().toISOString(), endedAt: /** @type {string|null} */ (null) };
    job = j;
    let lastProgress = 0;
    const emit = (/** @type {any} */ e) => {
      if (!e || typeof e !== 'object') return;
      /** @type {Record<string, any>} */ const ev = {};
      for (const k of ['type', 'name', 'text', 'done', 'total', 'part', 'out', 'report']) if (e[k] !== undefined) ev[k] = typeof e[k] === 'string' ? scrub(e[k]) : e[k];
      if (ev.type === 'progress') {
        j.progress = ev;
        const now = Date.now();
        if (now - lastProgress < 120 && ev.done !== ev.total) return;
        lastProgress = now;
      } else {
        j.events.push(ev);
        if (j.events.length > 300) j.events.splice(0, j.events.length - 300);
      }
      broadcast({ type: 'event', job: j.id, kind, event: ev });
    };
    broadcast({ type: 'job', job: publicJob(j) });
    Promise.resolve().then(() => fn(emit)).then((r) => { j.state = 'done'; j.result = r ?? null; }, (e) => {
      j.state = 'failed';
      j.error = scrub(String(e?.message ?? e));
    }).finally(() => {
      j.endedAt = new Date().toISOString();
      broadcast({ type: 'job', job: publicJob(j) });
      idleCheck();
    });
    return publicJob(j);
  };

  // lifetime
  /** @type {NodeJS.Timeout|null} */ let idleTimer = null;
  let everConnected = false;
  const idleCheck = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (streams.size || running()) return;
    idleTimer = setTimeout(() => { if (!streams.size && !running()) { log('The page was closed: the mover ends.'); void close(); } }, everConnected ? idleMs : graceMs);
    idleTimer.unref?.();
  };

  const rulesOpts = () => (o.noClientRules ? { rules: null, noClientRules: true } : { rulesFile: o.rulesFile, noClientRules: false });
  /** A selection object the engine reads, or a 400. @param {any} json */
  const checkSelection = (json) => {
    try { engine.parseSelection(json); } catch (e) { throw fail(400, /** @type {Error} */ (e).message); }
  };
  const planOpts = (/** @type {any} */ b) => {
    if (!sel) throw fail(400, 'load or build a selection first');
    if (b.out && !/^[a-z]:\\/i.test(String(b.out))) throw fail(400, 'name the output folder as a full path on a local drive, for example C:\\LaptopMove\\bundle');
    const volumeBytes = b.volume ? parseSize(String(b.volume)) : undefined;
    return {
      kitDir, selection: sel.file ?? undefined, selectionData: sel.json, ...rulesOpts(),
      out: b.out ? w.resolve(String(b.out)) : undefined, volumeBytes, clientData: !!b.clientData,
      appLookup: o.appLookup !== false, encrypt: true,
    };
  };
  /** A folder the page named: a full local path, or a 400. @param {unknown} v @param {string} what */
  const fullPath = (v, what) => {
    if (!/^[a-z]:\\/i.test(String(v))) throw fail(400, `name ${what} as a full path on a local drive`);
    return w.resolve(String(v));
  };
  const restoreOpts = (/** @type {any} */ b) => ({
    kitDir,
    from: b.from ? fullPath(b.from, 'the folder with the parts') : o.from,
    work: b.work ? fullPath(b.work, 'the work folder') : o.work,
    targetRoot: b.targetRoot ? fullPath(b.targetRoot, 'the trial folder') : undefined,
    skipApps: !!b.skipApps, skipClient: !!b.skipClient, overwrite: !!b.overwrite, open: false,
  });
  /** A password from the body, checked; the body's copy is dropped. @param {any} b @param {boolean} confirm */
  const takePassword = (b, confirm) => {
    const pw = b.password;
    const again = b.confirm;
    delete b.password;
    delete b.confirm;
    const why = engine.passwordProblem(pw);
    if (why) throw fail(400, `password: ${why}`);
    if (confirm && pw !== again) throw fail(400, 'password: the two fields differ: type it again in both');
    return /** @type {string} */ (pw);
  };
  /** A one-shot getter: the engine asks once, then the server forgets it. @param {string} pw */
  const oneShot = (pw) => {
    /** @type {string|null} */ let held = pw;
    return { get: async () => { const p = held; held = null; return p; }, scrub: (/** @type {string} */ s) => (pw && s.includes(pw) ? s.split(pw).join('***') : s), drop: () => { held = null; } };
  };

  /** The client rules as they stand now (the file may be written while the page is open). */
  const rulesNow = async () => {
    if (o.noClientRules) return engine.emptyRules();
    const f = o.rulesFile ?? (sel?.file ? engine.defaultRulesFile(sel.file) : null);
    return (f ? await engine.readRules(f) : null) ?? engine.emptyRules();
  };
  /** Why the selection may not be saved there, or null: never into a client folder, never into a synced OneDrive. @param {string} file */
  const savePathProblem = async (file) => {
    if (!/^[a-z]:\\/i.test(file)) return 'name a full path on a local drive';
    if (!/\.json$/i.test(file)) return 'the selection file ends in .json';
    const dir = w.dirname(file);
    const rules = await rulesNow();
    if (rules.forbiddenOut.some((/** @type {string} */ f) => dir.toLowerCase() === f.toLowerCase() || dir.toLowerCase().startsWith(`${f.toLowerCase()}\\`))) return 'that is a client folder: the mover never writes into a client\'s folders or OneDrive';
    if (engine.isOneDrive(dir)) return 'that folder is synced by OneDrive: save the selection in a local folder, for example Downloads (the mover never writes into a client\'s OneDrive)';
    return null;
  };

  /** @type {Record<string, (b: any) => Promise<any>>} */
  const POST = {
    async discover(b) {
      const roots = Array.isArray(b.roots) && b.roots.length ? b.roots.map((/** @type {any} */ r) => w.resolve(String(r))) : o.scanRoots;
      const rules = await rulesNow();
      return startJob('discover', (emit) => engine.discover({ roots, rules, appLookup: o.appLookup !== false && b.apps !== false, emit }));
    },
    async 'selection/load'(b) {
      const raw = String(b.file ?? '');
      if (!/^[a-z]:\\/i.test(raw)) throw fail(400, 'name the full path of the selection file');
      const file = w.resolve(raw);
      if (!/\.json$/i.test(file) || !existsSync(file)) throw fail(400, `no selection file at ${file}`);
      /** @type {any} */ let json;
      try { json = await engine.readSelectionRaw(file); } catch (e) { throw fail(400, `${w.basename(file)}: ${/** @type {Error} */ (e).message}`); }
      sel = { file, name: w.basename(file), json };
      selError = null;
      return { file: sel.file, json: sel.json };
    },
    async 'selection/import'(b) {
      checkSelection(b.json);
      sel = { file: null, name: String(b.name ?? 'imported selection'), json: engine.normalizeSelection(b.json, { savedAt: b.json.savedAt ?? undefined }) };
      return { file: null, name: sel.name, json: sel.json };
    },
    async 'selection/set'(b) {
      checkSelection(b.json);
      sel = { file: sel?.file ?? null, name: sel?.name ?? null, json: b.json };
      return { ok: true };
    },
    async 'selection/save'(b) {
      const json = b.json ?? sel?.json;
      if (!json) throw fail(400, 'nothing to save yet');
      checkSelection(json);
      const raw = String(b.file ?? sel?.file ?? w.join(process.env.USERPROFILE ?? os.homedir(), 'Downloads', 'laptop-move-selection.json'));
      if (!/^[a-z]:\\/i.test(raw)) throw fail(400, 'cannot save there: name a full path on a local drive');
      const file = w.resolve(raw);
      const why = await savePathProblem(file);
      if (why) throw fail(400, `cannot save there: ${why}`);
      const r = await engine.saveSelection(file, json);
      sel = { file: r.file, name: w.basename(r.file), json: r.json };
      return { file: r.file, backup: r.backup, json: r.json };
    },
    async dryrun(b) {
      const opts = planOpts(b);
      return startJob('dryrun', async (emit) => {
        const r = await engine.dryRun(opts, emit);
        return { out: r.out, problems: r.problems, text: r.text, plan: planSummary(r.plan) };
      });
    },
    async pack(b) {
      const pw = oneShot(takePassword(b, true));
      if (!b.out) throw fail(400, 'name the output folder');
      const opts = { ...planOpts(b), getPassword: pw.get };
      return startJob('pack', async (emit) => {
        try {
          const r = await engine.pack(opts, emit);
          produced.add(r.out.toLowerCase());
          produced.add(r.report.toLowerCase());
          return {
            out: r.out, report: r.report, kitZip: r.kitZip,
            parts: r.manifest.archives.flatMap((/** @type {any} */ a) => a.parts.map((/** @type {any} */ p) => ({ file: p.file, size: p.size, group: a.group }))),
            userSteps: r.manifest.userSteps,
          };
        } finally { pw.drop(); }
      }, pw.scrub);
    },
    async 'restore-dryrun'(b) {
      const opts = restoreOpts(b);
      return startJob('restore-dryrun', async () => {
        const r = await engine.restoreDryRun(opts);
        return { text: r.text, problems: r.problems, manifest: manifestSummary(r.manifest) };
      });
    },
    async restore(b) {
      const opts = restoreOpts(b);
      /** @type {any} */ let manifest;
      try { ({ manifest } = await engine.loadManifest(kitDir, opts.from ?? engine.defaultFrom(kitDir))); } catch (e) { delete b.password; throw fail(400, /** @type {Error} */ (e).message); }
      const pw = manifest.encrypted ? oneShot(takePassword(b, false)) : oneShot('');
      if (!manifest.encrypted) { delete b.password; delete b.confirm; }
      return startJob('restore', async (emit) => {
        try {
          const r = await engine.restore({ ...opts, getPassword: pw.get }, emit);
          produced.add(String(r.report).toLowerCase());
          produced.add(w.dirname(String(r.report)).toLowerCase());
          return restoreSummary(r);
        } finally { pw.drop(); }
      }, pw.scrub);
    },
    async open(b) {
      const p = w.resolve(String(b.path ?? ''));
      if (!produced.has(p.toLowerCase())) throw fail(403, 'the mover opens only the reports and folders it wrote itself');
      await openFile(p);
      return { ok: true };
    },
    async end() {
      if (running()) throw fail(409, `a task is running (${job?.kind}): wait until it ends`);
      setTimeout(() => { void close(); }, 50);
      return { ok: true };
    },
  };

  const state = async () => {
    const sz = await engine.check7z();
    let manifest = null;
    if (newLaptop) { try { manifest = manifestSummary((await engine.loadManifest(kitDir, o.from)).manifest); } catch { manifest = null; } }
    const counts = sel ? { folders: sel.json.folders.length, applications: (sel.json.applications ?? []).length, settings: (sel.json.settings ?? []).length } : null;
    return {
      mode: newLaptop ? 'new' : 'old',
      env: { user: process.env.USERNAME ?? os.userInfo().username, computer: process.env.COMPUTERNAME ?? os.hostname(), profile: process.env.USERPROFILE ?? os.homedir() },
      sevenZip: { ok: sz.ok, version: sz.version, why: sz.why ?? null },
      minPassword: engine.MIN_PASSWORD,
      selection: sel ? { file: sel.file, name: sel.name, savedAt: sel.json.savedAt ?? null, counts } : null,
      selectionError: selError,
      candidates: engine.selectionCandidates().map((/** @type {string} */ f) => ({ file: f, exists: existsSync(f) })),
      rules: o.noClientRules ? { none: true, file: null, found: false } : (() => { const f = o.rulesFile ?? (sel?.file ? engine.defaultRulesFile(sel.file) : null); return { none: false, file: f, found: !!f && existsSync(f) }; })(),
      defaults: { out: engine.defaultOut(), work: o.work ?? engine.defaultWork(), from: o.from ?? engine.defaultFrom(kitDir) },
      scanRoots: o.scanRoots ?? null,
      knownSettings: engine.KNOWN_SETTINGS ?? [],
      printerStep: engine.PRINTER_STEP,
      wifiStep: engine.WIFI_STEP,
      manifest,
      job: publicJob(job),
      guide: GUIDE_TOPICS,
    };
  };

  /** @param {http.ServerResponse} res @param {number} status @param {string} type @param {string|Buffer} body @param {Record<string, string>} [extra] */
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP, 'Cross-Origin-Resource-Policy': 'same-origin', ...extra,
    });
    res.end(body);
  };
  const json = (/** @type {http.ServerResponse} */ res, /** @type {number} */ status, /** @type {any} */ body) => send(res, status, 'application/json', JSON.stringify(body));
  const deny = (/** @type {http.ServerResponse} */ res, /** @type {number} */ status, /** @type {string} */ text) => send(res, status, 'text/html', page('Laptop mover', `<h1>Laptop mover</h1><p>${esc(text)}</p>`));
  const page = (/** @type {string} */ title, /** @type {string} */ body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"></head><body class="plain">${body}</body></html>`;

  /** @param {http.IncomingMessage} req @returns {Promise<any>} */
  const body = (req) => new Promise((resolve, reject) => {
    /** @type {Buffer[]} */ const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(fail(413, 'too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(fail(400, 'not JSON')); } });
    req.on('error', reject);
  });

  const guidePage = async (/** @type {string} */ topic) => {
    const read = async (/** @type {string} */ t) => { try { return await readFile(w.join(UI_DIR, 'guide', `${t}.html`), 'utf8'); } catch { return `<h2>${esc(t)}</h2><p>This page of the guide comes later.</p>`; } };
    const nav = `<nav class="gnav"><a href="/guide/print">The whole guide, to print</a></nav>`;
    if (topic === 'print') {
      const parts = await Promise.all(GUIDE_TOPICS.map(async (t) => `<section class="gsec" id="g-${t}">${await read(t)}</section>`));
      return page('Laptop mover guide', `<header class="ghead"><strong>Laptop mover</strong> guide</header><main class="guide"><p class="noprint"><button class="btn" type="button" id="print">Print the guide</button></p>${parts.join('\n')}</main><script src="/guide.js"></script>`);
    }
    return page(`Laptop mover guide: ${topic}`, `<header class="ghead"><strong>Laptop mover</strong> guide</header><main class="guide">${nav}${await read(topic)}</main>`);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${port}`) return deny(res, 421, 'This server answers only at its own address on this computer.');
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}`) return deny(res, 403, 'Refused: the request came from another site.');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const cookieName = `lm${port}`;
      const hasSession = sameSecret(cookies(req.headers.cookie)[cookieName], session);

      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
        if (!tokenSpent && sameSecret(url.searchParams.get('t'), token)) {
          tokenSpent = true;
          res.writeHead(303, { Location: '/', 'Set-Cookie': `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          return res.end();
        }
        if (hasSession) { res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
        return deny(res, 403, 'This link was used already, or it is not the right one. Start the mover again (node kit.mjs ui) and use the link it opens.');
      }
      if (!hasSession) return deny(res, 403, 'Open the mover through the link it opened or printed when it started.');

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = (await readFile(w.join(UI_DIR, 'index.html'), 'utf8')).replace('__LM_KEY__', apiKey);
        return send(res, 200, 'text/html', html);
      }
      if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
        const [file, type] = STATIC[/** @type {keyof typeof STATIC} */ (url.pathname)];
        return send(res, 200, type, await readFile(w.join(UI_DIR, file)));
      }
      const g = /^\/guide\/([a-z0-9-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && g && (g[1] === 'print' || GUIDE_TOPICS.includes(g[1]))) return send(res, 200, 'text/html', await guidePage(g[1]));

      if (!url.pathname.startsWith('/api/')) return deny(res, 404, 'Not here.');
      const key = url.pathname === '/api/events' ? url.searchParams.get('k') : req.headers['x-lm-key'];
      if (!sameSecret(key, apiKey)) return json(res, 403, { error: 'refused: no key' });
      const name = url.pathname.slice(5);

      if (req.method === 'GET' && name === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
        res.write(`retry: 1000\ndata: ${JSON.stringify({ type: 'hello', job: publicJob(job) })}\n\n`);
        streams.add(res);
        everConnected = true;
        idleCheck();
        const ping = setInterval(() => res.write(': ping\n\n'), 10000);
        req.on('close', () => { clearInterval(ping); streams.delete(res); idleCheck(); });
        return undefined;
      }
      if (req.method === 'GET' && name === 'state') return json(res, 200, await state());
      if (req.method === 'GET' && name === 'job') return json(res, 200, { job: publicJob(job) });
      if (req.method === 'GET' && name === 'selection') return json(res, 200, sel ? { file: sel.file, name: sel.name, json: sel.json } : { file: null, json: null });
      if (req.method === 'POST' && Object.hasOwn(POST, name)) {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'send JSON' });
        const b = await body(req);
        if (!b || typeof b !== 'object' || Array.isArray(b)) return json(res, 400, { error: 'send a JSON object' });
        return json(res, 200, await POST[name](b));
      }
      return json(res, 404, { error: 'no such call' });
    } catch (e) {
      const err = /** @type {any} */ (e);
      const status = Number(err?.status) || 500;
      if (!res.headersSent) json(res, status, { error: String(err?.message ?? err) });
      else res.end();
      return undefined;
    }
  });

  /** @type {() => void} */ let resolveClosed = () => {};
  const closed = new Promise((/** @type {(v?: any) => void} */ r) => { resolveClosed = r; });
  let closing = false;
  const close = async () => {
    if (closing) return closed;
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const s of streams) { try { s.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`); s.end(); } catch { /* gone */ } }
    streams.clear();
    await new Promise((r) => { server.close(() => r(undefined)); server.closeAllConnections?.(); });
    resolveClosed();
    return closed;
  };

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  idleCheck();
  if (o.open !== false) openFile(url).catch(() => {});
  return { url, port, token, close, closed };
}

/** The guide pages that exist in kit\ui\guide. */
export async function guideFiles() {
  try { return (await readdir(w.join(UI_DIR, 'guide'))).filter((f) => f.endsWith('.html')); } catch { return []; }
}
