// Rules the user set for the page: printers and Wi-Fi are not moved (they are checks on the new laptop), no Wi-Fi key is
// ever exported, and the guide carries the Accenture-OneDrive-only rule. Sample data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryRun } from '../lib/pack.mjs';
import { PRINTER_STEP, WIFI_STEP } from '../lib/plan.mjs';

const w = path.win32;
const KIT = w.dirname(w.dirname(fileURLToPath(import.meta.url)));
/** @param {any} t @param {string} name */
async function scratch(t, name) {
  const d = await mkdtemp(w.join(os.tmpdir(), `lmk-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** Every source file of the kit, its tests left out. @param {string} dir @returns {Promise<string[]>} */
async function sources(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = w.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'test' && e.name !== 'node_modules') out.push(...await sources(p)); } else if (/\.(mjs|js|html|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no kit source exports a Wi-Fi key or a profile', async () => {
  const files = await sources(KIT);
  assert.ok(files.some((f) => f.endsWith('server.mjs')) && files.some((f) => f.endsWith('app.js')));
  const clear = ['key', 'clear'].join('=');
  for (const f of files) {
    const text = (await readFile(f, 'utf8')).toLowerCase();
    assert.ok(!text.includes(clear), `${f} holds ${clear}`);
    assert.ok(!/wlan\s+export/.test(text), `${f} exports a Wi-Fi profile`);
  }
});

test('the dry run tells the user to check printing and Wi-Fi on the new laptop', async (t) => {
  const root = await scratch(t, 'steps');
  await mkdir(w.join(root, 'docs'));
  await writeFile(w.join(root, 'docs', 'a.md'), 'sample');
  const r = await dryRun({
    selectionData: { savedAt: '2026-11-23T09:00:00Z', folders: [{ path: root, mode: 'copy whole' }], applications: [], settings: [] },
    rules: null, noClientRules: true, out: w.join(root, 'out'), volumeBytes: 1024 ** 3, appLookup: false, extensions: false,
  }, () => {});
  assert.ok(r.plan.userSteps.includes(PRINTER_STEP));
  assert.ok(r.plan.userSteps.includes(WIFI_STEP));
  assert.match(PRINTER_STEP, /not moved/);
  assert.match(WIFI_STEP, /no Wi-Fi profile or key is packed/);
  assert.match(r.text, /Printers: not moved/);
});

test('the guide pages carry the upload rule and use no dashes the house style forbids', async () => {
  const dir = w.join(KIT, 'ui', 'guide');
  const all = (await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.html')).map((f) => readFile(w.join(dir, f), 'utf8')))).join('\n');
  assert.match(all, /Accenture OneDrive only/);
  assert.match(all, /never a client's OneDrive/i);
  for (const f of await sources(w.join(KIT, 'ui'))) assert.ok(!/[\u2013\u2014]/.test(await readFile(f, 'utf8')), `${f} holds an en or em dash`);
});
