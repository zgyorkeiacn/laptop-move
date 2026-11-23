// The page's server: 127.0.0.1 only, a one-time token, a session cookie and a per-page key, Host and Origin checks,
// the selection load and save, and the password (taken once, checked, never sent back or put in an event). The engine
// is a fake here: no folder is scanned, nothing is packed or restored. Sample data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as real from '../lib/engine.mjs';
import { startServer, sameSecret, cookies, GUIDE_TOPICS, guideFiles } from '../ui/server.mjs';

const w = path.win32;
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

const SAMPLE = { savedAt: '2026-11-01T08:00:00Z', folders: [{ path: 'C:\\Users\\sample\\docs', mode: 'copy whole' }], applications: [{ name: 'Git', wingetId: 'Git.Git', source: 'winget' }], settings: [] };
const PASSWORD = 'sample pass phrase 42';

/** A plan as the engine's dry run returns it, small. */
const PLAN = {
  selectionFile: null, savedAt: SAMPLE.savedAt, rulesFile: null, rulesFound: false, volumeBytes: 4 * 1024 ** 3,
  totals: { data: { bytes: 500, files: 2 }, client: { bytes: 0, files: 0 }, dataEstimate: { raw: 500, archive: 375, parts: 1, packSeconds: 1, uploadSeconds: 1, unpackSeconds: 1 }, clientEstimate: null },
  units: [{ path: 'C:\\Users\\sample\\docs', kind: 'copy', bytes: 500, fileCount: 2, group: 'data' }],
  repos: [], pushFirst: [], byHand: [{ path: 'C:\\Users\\sample\\.ssh', why: 'keys or tokens folder' }], links: [], apps: [{ name: 'Git', kind: 'winget', wingetId: 'Git.Git' }],
  userSteps: [real.PRINTER_STEP, real.WIFI_STEP], skipped: [], warnings: [],
};

/** The real engine's pure parts, with every part that touches the machine replaced. @param {string} d */
function fakeEngine(d) {
  /** @type {Record<string, any>} */ const seen = { calls: [] };
  const engine = {
    ...real,
    seen,
    selectionCandidates: () => [w.join(d, 'nowhere', 'laptop-move-selection.json')],
    check7z: async () => ({ ok: true, exe: 'C:\\Program Files\\7-Zip\\7z.exe', version: '26.03' }),
    defaultOut: () => w.join(d, 'bundle'),
    defaultWork: () => w.join(d, 'restore'),
    defaultFrom: () => w.join(d, 'parts'),
    async discover(/** @type {any} */ o) { seen.calls.push('discover'); seen.discover = o; o.emit?.({ type: 'phase', name: 'discover', text: 'Looking' }); return { roots: o.roots ?? [], found: [], settings: [], apps: [], notes: [] }; },
    async dryRun(/** @type {any} */ o, /** @type {any} */ emit) { seen.calls.push('dryRun'); seen.dryRun = o; emit({ type: 'phase', name: 'scan', text: 'Scanning' }); return { out: o.out, problems: [], text: 'plan text', plan: PLAN }; },
    async pack(/** @type {any} */ o, /** @type {any} */ emit) {
      seen.calls.push('pack');
      seen.packOpts = Object.keys(o);
      seen.first = await o.getPassword();
      seen.second = await o.getPassword();
      emit({ type: 'step', text: `7-Zip said: ${seen.first}` });
      emit({ type: 'progress', done: 1, total: 1, text: 'data.7z.001' });
      return { out: o.out, report: w.join(o.out, 'pack-report.html'), kitZip: w.join(o.out, 'laptop-move-kit.zip'), manifest: { archives: [{ group: 'data', parts: [{ file: 'data.7z.001', size: 375 }] }], userSteps: PLAN.userSteps } };
    },
    async loadManifest() { seen.calls.push('loadManifest'); return { manifest: { encrypted: true, archives: [], userSteps: [] } }; },
    async restoreDryRun() { seen.calls.push('restoreDryRun'); return { text: 'restore plan', problems: [], manifest: { encrypted: true, archives: [] } }; },
    async restore(/** @type {any} */ o) { seen.calls.push('restore'); seen.restorePw = await o.getPassword(); return { report: w.join(d, 'restore', 'report.html'), results: { units: [{ name: 'docs', status: 'restored', detail: '' }] }, warnings: [] }; },
  };
  return engine;
}

/**
 * One HTTP request with full control over the headers (Host included).
 * @param {number} port @param {string} method @param {string} p
 * @param {{headers?: Record<string, string>, body?: any}} [o]
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, text: string, json: any}>}
 */
function call(port, method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(o.headers ?? {}) };
    let data;
    if (o.body !== undefined) {
      data = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      /** @type {Buffer[]} */ const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Starts a server on sample data and opens a session: the cookie and the page key. @param {any} t @param {Record<string, any>} [extra] */
async function session(t, extra = {}) {
  const d = await scratch(t, 'srv');
  const selFile = w.join(d, 'sel', 'laptop-move-selection.json');
  await real.saveSelection(selFile, SAMPLE, { savedAt: SAMPLE.savedAt });
  const engine = fakeEngine(d);
  const s = await startServer({ kitDir: w.join(d, 'kit'), selection: selFile, engine, open: false, idleMs: 60000, ...extra });
  t.after(() => s.close());
  const first = await call(s.port, 'GET', `/?t=${s.token}`);
  assert.equal(first.status, 303);
  const set = String(first.headers['set-cookie'] ?? '');
  assert.match(set, new RegExp(`^lm${s.port}=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=/`));
  const cookie = set.split(';')[0];
  const pageRes = await call(s.port, 'GET', '/', { headers: { Cookie: cookie } });
  assert.equal(pageRes.status, 200);
  const key = /name="lm-key" content="([^"]+)"/.exec(pageRes.text)?.[1] ?? '';
  assert.ok(key && key !== '__LM_KEY__');
  const api = (/** @type {string} */ name, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => call(s.port, body === undefined ? 'GET' : 'POST', `/api/${name}`, { headers: { Cookie: cookie, 'X-LM-Key': key, ...headers }, body });
  /** Waits until the running task has ended. */
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const j = (await api('job')).json.job;
      if (!j || j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('the task did not end');
  };
  return { d, s, engine, cookie, key, api, settle, selFile, page: pageRes };
}

test('sameSecret and cookies', () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abd', 'abc'), false);
  assert.equal(sameSecret('ab', 'abc'), false);
  assert.equal(sameSecret(undefined, 'abc'), false);
  assert.equal(sameSecret('', ''), false);
  assert.deepEqual(cookies('a=1; lm123=xyz ; b'), { a: '1', lm123: 'xyz' });
  assert.deepEqual(cookies(undefined), {});
});

test('every guide topic has its page', async () => {
  const files = await guideFiles();
  for (const t of GUIDE_TOPICS) assert.ok(files.includes(`${t}.html`), `kit\\ui\\guide\\${t}.html`);
});

test('the server listens on 127.0.0.1 only, and the token works once', async (t) => {
  const { s, cookie, page } = await session(t);
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{32}$/);
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'; script-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');

  const again = await call(s.port, 'GET', `/?t=${s.token}`);
  assert.equal(again.status, 403, 'a spent token is refused');
  assert.equal(again.headers['set-cookie'], undefined);
  assert.equal((await call(s.port, 'GET', `/?t=${s.token}`, { headers: { Cookie: cookie } })).status, 303, 'with the session cookie it just goes to the page');
  assert.equal((await call(s.port, 'GET', '/')).status, 403, 'no cookie, no page');
  assert.equal((await call(s.port, 'GET', '/app.js')).status, 403);
  assert.equal((await call(s.port, 'GET', '/', { headers: { Cookie: `lm${s.port}=guessed` } })).status, 403);

  const other = await new Promise((resolve) => {
    const req = http.request({ host: '::1', port: s.port, method: 'GET', path: '/', family: 6 }, (res) => resolve(res.statusCode));
    req.on('error', () => resolve('refused'));
    req.end();
  });
  assert.equal(other, 'refused', 'nothing answers on another address');
});

test('a wrong token gets no cookie', async (t) => {
  const d = await scratch(t, 'tok');
  const s = await startServer({ kitDir: d, engine: fakeEngine(d), open: false });
  t.after(() => s.close());
  const r = await call(s.port, 'GET', `/?t=${'x'.repeat(32)}`);
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal((await call(s.port, 'GET', `/?t=${s.token}`)).status, 303, 'the right token still works after a wrong one');
});

test('Host, Origin, the page key and JSON are checked', async (t) => {
  const { s, cookie, key, api } = await session(t);
  assert.equal((await call(s.port, 'GET', '/api/state', { headers: { Cookie: cookie, 'X-LM-Key': key, Host: `localhost:${s.port}` } })).status, 421);
  assert.equal((await call(s.port, 'GET', '/api/state', { headers: { Cookie: cookie, 'X-LM-Key': key, Host: `attacker.example:${s.port}` } })).status, 421);
  assert.equal((await api('state', undefined, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await api('state', undefined, { Origin: `http://127.0.0.1:${s.port}` })).status, 200);
  const noKey = await call(s.port, 'GET', '/api/state', { headers: { Cookie: cookie } });
  assert.equal(noKey.status, 403);
  assert.equal((await call(s.port, 'GET', '/api/state', { headers: { Cookie: cookie, 'X-LM-Key': `${key}x` } })).status, 403);
  assert.equal((await api('discover', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await api('discover', '[1]')).status, 400);
  assert.equal((await api('discover', 'not json')).status, 400);
  assert.equal((await api('nothing-here', {})).status, 404);
  assert.equal((await call(s.port, 'GET', '/guide/start', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call(s.port, 'GET', '/guide/print', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call(s.port, 'GET', '/guide/..%5Cserver.mjs', { headers: { Cookie: cookie } })).status, 404);
  const icon = await call(s.port, 'GET', '/icon.svg', { headers: { Cookie: cookie } });
  assert.equal(icon.status, 200);
  assert.match(String(icon.headers['content-type']), /^image\/svg\+xml/);
});

test('state tells the page who, which selection and the printer and Wi-Fi steps', async (t) => {
  const { api, selFile } = await session(t);
  const st = (await api('state')).json;
  assert.equal(st.mode, 'old');
  assert.equal(st.minPassword, 12);
  assert.equal(st.sevenZip.ok, true);
  assert.equal(st.selection.file, selFile);
  assert.deepEqual(st.selection.counts, { folders: 1, applications: 1, settings: 0 });
  assert.equal(st.printerStep, real.PRINTER_STEP);
  assert.equal(st.wifiStep, real.WIFI_STEP);
  assert.deepEqual(st.guide, GUIDE_TOPICS);
  assert.equal(st.env.user, process.env.USERNAME ?? os.userInfo().username);
  const sel = (await api('selection')).json;
  assert.deepEqual(sel.json.folders, SAMPLE.folders);
});

test('a selection loads, imports, and saves only to a local folder that is not a client one or OneDrive', async (t) => {
  const d0 = await scratch(t, 'rules');
  const clientDrop = w.join(d0, 'client-drop');
  const rulesFile = w.join(d0, 'laptop-move-client.json');
  await writeFile(rulesFile, JSON.stringify({ forbiddenOut: [clientDrop] }), 'utf8');
  const { d, api, selFile } = await session(t, { rulesFile });

  const loaded = await api('selection/load', { file: selFile });
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.json.json.folders, SAMPLE.folders);
  assert.equal((await api('selection/load', { file: w.join(d, 'missing.json') })).status, 400);

  const imported = await api('selection/import', { name: 'old.json', json: { ...SAMPLE, savedAt: undefined, extra: 1 } });
  assert.equal(imported.status, 200);
  assert.equal(imported.json.file, null);
  assert.deepEqual(Object.keys(imported.json.json).slice(0, 7), ['savedAt', 'folders', 'applications', 'settings', 'questions', 'comments', 'commentLabels']);
  const notSel = await api('selection/import', { json: { nope: true } });
  assert.equal(notSel.status, 400);
  assert.match(notSel.json.error, /no folders list/);
  assert.equal((await api('selection/load', { file: 'relative.json' })).status, 400);

  for (const [file, why] of [
    ['relative\\sel.json', /full path/],
    [w.join(d, 'sel.txt'), /\.json/],
    [w.join(d, 'OneDrive - Sample', 'sel.json'), /OneDrive/],
    [w.join(clientDrop, 'sel.json'), /client/],
  ]) {
    const r = await api('selection/save', { file, json: SAMPLE });
    assert.equal(r.status, 400, String(file));
    assert.match(r.json.error, /** @type {RegExp} */ (why));
  }
  assert.equal(existsSync(w.join(d, 'OneDrive - Sample')), false, 'nothing written into the OneDrive-like folder');
  assert.equal(existsSync(clientDrop), false, 'nothing written into the client folder');

  const target = w.join(d, 'saved', 'laptop-move-selection.json');
  const saved = await api('selection/save', { file: target, json: { ...SAMPLE, folders: [...SAMPLE.folders, { path: 'C:\\git\\sample', mode: 'clone again' }] } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.backup, null);
  const onDisk = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(onDisk.folders.length, 2);
  const again = await api('selection/save', {});
  assert.equal(again.status, 200);
  assert.ok(again.json.backup && existsSync(again.json.backup), 'the second save backs up the first');
});

test('pack takes the password once, checks it, and it never comes back in an answer or an event', async (t) => {
  const { d, s, api, settle, engine, cookie, key } = await session(t);
  /** @type {string[]} */ const stream = [];
  const es = http.request({ host: '127.0.0.1', port: s.port, path: `/api/events?k=${key}`, headers: { Cookie: cookie } }, (res) => res.on('data', (c) => stream.push(c.toString('utf8'))));
  es.end();
  t.after(() => es.destroy());
  await new Promise((r) => setTimeout(r, 50));

  const out = w.join(d, 'bundle');
  for (const [body, why] of /** @type {[Record<string, string>, RegExp][]} */ ([
    [{ out, password: 'short', confirm: 'short' }, /at least 12/],
    [{ out, password: PASSWORD, confirm: `${PASSWORD}!` }, /differ/],
    [{ out, password: `${PASSWORD}\n`, confirm: `${PASSWORD}\n` }, /line break/],
    [{ out, password: 'caf\u00e9 caf\u00e9 caf\u00e9', confirm: 'caf\u00e9 caf\u00e9 caf\u00e9' }, /accented/],
    [{ out }, /type a password/],
    [{ password: PASSWORD, confirm: PASSWORD }, /output folder/],
  ])) {
    const r = await api('pack', body);
    assert.equal(r.status, 400, JSON.stringify(body.out));
    assert.match(r.json.error, why);
    assert.ok(!r.text.includes(PASSWORD) && !r.text.includes('short') && !r.text.includes('caf'), 'the answer does not repeat the password');
  }
  assert.ok(!engine.seen.calls.includes('pack'), 'the engine was not called for a refused password');

  const dry = await api('dryrun', { out });
  assert.equal(dry.status, 200);
  const dj = await settle();
  assert.equal(dj.state, 'done');
  assert.deepEqual(dj.result.plan.userSteps, [real.PRINTER_STEP, real.WIFI_STEP]);
  assert.equal(engine.seen.dryRun.encrypt, true);
  assert.equal(engine.seen.dryRun.allowOneDrive, undefined, 'the page never allows a OneDrive output folder');

  const r = await api('pack', { out, password: PASSWORD, confirm: PASSWORD, volume: '4g' });
  assert.equal(r.status, 200, r.text);
  const j = await settle();
  assert.equal(j.state, 'done', j.error);
  assert.equal(engine.seen.first, PASSWORD, 'the engine got the password');
  assert.equal(engine.seen.second, null, 'and only once');
  assert.ok(!engine.seen.packOpts.includes('password'), 'the password is not an option, only the getter');
  assert.deepEqual(j.result.parts, [{ file: 'data.7z.001', size: 375, group: 'data' }]);
  assert.ok(j.events.some((/** @type {any} */ e) => e.text === '7-Zip said: ***'), 'an echoed password is scrubbed');
  await new Promise((res) => setTimeout(res, 50));
  const all = stream.join('') + JSON.stringify((await api('job')).json) + JSON.stringify((await api('state')).json);
  assert.ok(stream.join('').includes('data: '), 'the page got events');
  assert.ok(!all.includes(PASSWORD), 'the password is in no event, job or state');
});

test('restore asks for the password of an encrypted bundle, without a confirmation', async (t) => {
  const { api, settle, engine } = await session(t);
  assert.equal((await api('restore', {})).status, 400);
  const r = await api('restore', { password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  const j = await settle();
  assert.equal(j.state, 'done', j.error);
  assert.equal(engine.seen.restorePw, PASSWORD);
  assert.deepEqual(j.result.sections.units, [{ name: 'docs', status: 'restored', detail: '' }]);
  assert.ok(!JSON.stringify(j).includes(PASSWORD));
});

test('open only opens what the mover wrote; folders are full local paths', async (t) => {
  const { api } = await session(t);
  const r = await api('open', { path: 'C:\\Windows\\System32\\notepad.exe' });
  assert.equal(r.status, 403);
  assert.equal((await api('dryrun', { out: 'bundle' })).status, 400);
  assert.equal((await api('restore-dryrun', { from: 'parts' })).status, 400);
  assert.equal((await api('restore', { work: '\\\\server\\share', password: PASSWORD })).status, 400);
});

test('End stops the server', async (t) => {
  const { s, api } = await session(t);
  const r = await api('end', {});
  assert.equal(r.status, 200);
  await Promise.race([s.closed, new Promise((_, rej) => setTimeout(() => rej(new Error('the server did not end')), 3000))]);
  await assert.rejects(call(s.port, 'GET', '/'));
});

test('the server ends by itself when the page is closed', async (t) => {
  const { s, cookie, key } = await session(t, { idleMs: 150 });
  const es = http.request({ host: '127.0.0.1', port: s.port, path: `/api/events?k=${key}`, headers: { Cookie: cookie } }, () => {});
  es.on('error', () => {});
  es.end();
  await new Promise((r) => setTimeout(r, 100));
  es.destroy();
  await Promise.race([s.closed, new Promise((_, rej) => setTimeout(() => rej(new Error('the server did not end')), 3000))]);
});

test('the new laptop: the kit folder with a manifest opens in restore mode', async (t) => {
  const d = await scratch(t, 'new');
  const kitDir = w.join(d, 'kit');
  await mkdir(kitDir);
  await writeFile(w.join(kitDir, 'manifest.json'), '{}', 'utf8');
  const engine = fakeEngine(d);
  const s = await startServer({ kitDir, engine, open: false });
  t.after(() => s.close());
  const first = await call(s.port, 'GET', `/?t=${s.token}`);
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  const key = /name="lm-key" content="([^"]+)"/.exec((await call(s.port, 'GET', '/', { headers: { Cookie: cookie } })).text)?.[1] ?? '';
  const st = (await call(s.port, 'GET', '/api/state', { headers: { Cookie: cookie, 'X-LM-Key': key } })).json;
  assert.equal(st.mode, 'new');
  assert.equal(st.selection, null, 'no selection is looked for on the new laptop');
  assert.equal(st.manifest.encrypted, true);
});
