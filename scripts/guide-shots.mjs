// Takes the guide's screenshots from the running page, on made-up sample data only, and runs a real pack and a real restore
// of that sample (two small folders and one sample repository) so the progress and report screens have real content.
// Playwright starts Edge itself and talks to it over a pipe; no debugging port is opened.
//
// Usage: node scripts/guide-shots.mjs [--playwright <folder>]
//   <folder>: a node_modules\playwright-core folder, or a project folder whose node_modules holds it (or PLAYWRIGHT_CORE).
// The sample lives in C:\sample-laptop (a neutral folder, so no real user name or path shows in a picture); it is removed first
// and again at the end. The pictures go to kit\ui\guide\img.
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../kit/ui/server.mjs';
import { saveSelection } from '../kit/lib/selection.mjs';

const w = path.win32;
const run = promisify(execFile);
const REPO = w.dirname(w.dirname(fileURLToPath(import.meta.url)));
const KIT = w.join(REPO, 'kit');
const IMG = w.join(KIT, 'ui', 'guide', 'img');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function loadPlaywright() {
  const where = opt('--playwright') ?? process.env.PLAYWRIGHT_CORE;
  const tries = [];
  if (where) tries.push(() => (w.basename(where).toLowerCase() === 'playwright-core' ? createRequire(w.join(where, 'package.json'))(where) : createRequire(w.join(where, 'package.json'))('playwright-core')));
  tries.push(() => createRequire(w.join(REPO, 'package.json'))('playwright-core'));
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  throw new Error('playwright-core was not found: pass --playwright <folder> or set PLAYWRIGHT_CORE');
}

const base = 'C:\\sample-laptop';
const home = w.join(base, 'home');
const proj = w.join(home, 'projects', 'tools');
const remote = w.join(base, 'remote.git');
const out = w.join(base, 'bundle');
const work = w.join(base, 'work');
const git = (/** @type {string[]} */ a, /** @type {string} */ cwd) => run('git', a, { cwd });

await rm(base, { recursive: true, force: true });
await mkdir(IMG, { recursive: true });
for (const d of [w.join(home, 'docs'), w.join(home, 'notes'), w.join(home, '.ssh'), proj, remote, work]) await mkdir(d, { recursive: true });
await writeFile(w.join(home, 'docs', 'plan.md'), '# Sample plan\n');
await writeFile(w.join(home, 'docs', 'ideas.md'), '# Sample ideas\n');
await writeFile(w.join(home, 'notes', 'todo.txt'), 'sample note\n');
await writeFile(w.join(home, '.ssh', 'id_ed25519'), 'sample, not a key\n');
await git(['init', '--bare', '-b', 'main', remote], base);
await git(['init', '-b', 'main'], proj);
await git(['config', 'user.email', 'sample@example.invalid'], proj);
await git(['config', 'user.name', 'Sample'], proj);
await writeFile(w.join(proj, 'README.md'), '# tools\n');
await git(['add', '.'], proj);
await git(['commit', '-m', 'first'], proj);
await git(['remote', 'add', 'origin', remote], proj);
await git(['push', '-u', 'origin', 'main'], proj);
await writeFile(w.join(proj, 'local.md'), 'not pushed yet\n');
await git(['add', '.'], proj);
await git(['commit', '-m', 'local work'], proj);

const selFile = w.join(base, 'laptop-move-selection.json');
await saveSelection(selFile, {
  savedAt: '2026-11-23T09:00:00Z',
  folders: [
    { path: w.join(home, 'docs'), mode: 'copy whole' },
    { path: w.join(home, 'notes'), mode: 'copy whole' },
    { path: w.join(home, '.ssh'), mode: 'by hand' },
    { path: proj, mode: 'clone again + bundle/dirty' },
  ],
  applications: [],
  settings: [],
});

const { chromium } = loadPlaywright();
const s = await startServer({ kitDir: KIT, selection: selFile, noClientRules: true, scanRoots: [home], appLookup: false, open: false, idleMs: 600000 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await context.newPage();
/** @type {string[]} */ const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
const waitText = (/** @type {string} */ sel, /** @type {RegExp} */ re, timeout = 120000) =>
  page.waitForFunction(([q, src0, flags]) => new RegExp(src0, flags).test(document.querySelector(q)?.textContent ?? ''), [sel, re.source, re.flags], { timeout });
page.on('dialog', (d) => { void d.accept(); });
// No real user name or computer name can reach a picture: a MutationObserver, installed before any page script runs, rewrites
// every text node and the title, value and placeholder attributes on every change; before each shot the who-line must read
// the sample names, and after each shot the page text is read and the run fails if a real name is still in it.
// The real names exist only in memory here, never in a file.
const realNames = [os.userInfo().username, os.hostname()].filter(Boolean);
await context.addInitScript((names) => {
  const repl = ['sample-user', 'SAMPLE-PC'];
  const esc = (/** @type {string} */ x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = names.map((x, i) => [new RegExp(esc(x), 'gi'), repl[i] ?? 'sample']);
  const fix = (/** @type {string} */ t) => rules.reduce((a, [re, r]) => a.replace(re, r), t);
  const attrs = ['title', 'value', 'placeholder', 'aria-label', 'alt'];
  const fixNode = (/** @type {Node} */ n) => {
    if (n.nodeType === 3) { const t = n.nodeValue ?? ''; const f = fix(t); if (f !== t) n.nodeValue = f; return; }
    if (n.nodeType !== 1) return;
    const el = /** @type {Element} */ (n);
    for (const a of attrs) { const v = el.getAttribute(a); if (v !== null) { const f = fix(v); if (f !== v) el.setAttribute(a, f); } }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { const f = fix(el.value); if (f !== el.value) el.value = f; }
    for (const c of Array.from(el.childNodes)) fixNode(c);
  };
  const sweep = () => { if (document.documentElement) fixNode(document.documentElement); if (document.title) { const f = fix(document.title); if (f !== document.title) document.title = f; } };
  new MutationObserver(sweep).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attrs });
  document.addEventListener('input', sweep, true);
  document.addEventListener('DOMContentLoaded', sweep);
}, realNames);
const leak = (/** @type {string} */ text) => realNames.some((x) => text.toLowerCase().includes(x.toLowerCase()));
const shot = async (/** @type {string} */ name) => {
  await page.waitForFunction(() => {
    const who = document.getElementById('who')?.textContent ?? '';
    const shown = Array.from(document.querySelectorAll('article[data-screen]')).some((a) => !a.classList.contains('hide') && (a.textContent ?? '').trim().length > 40);
    return /sample-user on SAMPLE-PC/.test(who) && shown;
  }, null, { timeout: 30000 });
  // the list of selection files found in the user's own folders is a real path: it is hidden in every picture
  await page.evaluate(() => { document.getElementById('selcands')?.classList.add('hide'); window.scrollTo(0, 0); });
  await page.screenshot({ path: w.join(IMG, `${name}.png`), fullPage: true });
  const text = await page.evaluate(() => document.body.innerText + '\n' + document.title);
  if (leak(text)) { await rm(w.join(IMG, `${name}.png`), { force: true }); throw new Error(`a real user or computer name is on the page for ${name}; the picture was deleted`); }
  console.log('shot', name);
};
let failed = false;
try {
  await page.goto(s.url);
  // the list of selection files found in the user's own folders is a real path: it is hidden for every picture
  await waitText('#selinfo', /laptop-move-selection\.json/);
  await shot('01-start');
    await page.click('[data-toc="scan"]');
  await page.fill('#scanroots', home);
  await page.uncheck('#scanapps');
  await page.click('#scango');
  await waitText('#scanstat', /^done$/);
  await shot('03-scan');
  await page.click('[data-toc="folders"]'); await shot('04-folders');
  await page.click('[data-toc="repos"]'); await shot('05-repos');
  await page.click('[data-toc="settings"]'); await shot('06-settings');
  await page.click('[data-toc="byhand"]');
  await page.fill('#savefile', w.join(base, 'saved', 'laptop-move-selection.json'));
  await shot('07-byhand');
  await page.click('[data-toc="dryrun"]');
  await page.fill('#outdir', out);
  await page.fill('#volume', '500m');
  await page.click('#drygo');
  await waitText('#drystat', /^finished/);
  await shot('08-dryrun');
  await page.click('[data-toc="password"]');
  const pw = randomBytes(15).toString('base64url');
  await page.fill('#pw1', pw);
  await page.fill('#pw2', pw);
  await shot('09-password');
  await page.click('#packgo');
  await page.click('[data-toc="packing"]');
  await page.locator('#packdone').getByText(/./).first().waitFor({ timeout: 300000 });
  await shot('10-packing');
  await page.click('[data-toc="upload"]'); await shot('11-upload');

  // the new laptop: the sample folders are removed so the restore has something to do
  for (const d of [w.join(home, 'docs'), w.join(home, 'notes'), proj]) await rm(d, { recursive: true, force: true });
  await page.click('[data-toc="restore"]');
  await page.fill('#rsfrom', out);
  await page.fill('#rswork', work);
  await page.click('#rsdry');
  await waitText('#rsdrystat', /^(?!checking$)./);
  await shot('12-restore-check');
  await page.fill('#rspw', pw);
  await page.click('#rsgo');
  await page.click('[data-toc="restoring"]');
  await page.waitForFunction(() => /finished|done|restored/i.test(document.querySelector('#rsidle')?.textContent ?? '') || document.querySelectorAll('#rsphases tr').length > 0, null, { timeout: 60000 });
  await page.click('[data-toc="report"]');
  await page.waitForFunction(() => !document.querySelector('#repopen')?.hasAttribute('disabled'), null, { timeout: 300000 });
  await shot('13-report');
  await page.click('[data-toc="restoring"]'); await shot('14-restoring');
} catch (e) {
  failed = true;
  console.log('FAIL', String(/** @type {Error} */ (e).stack ?? e));
  await page.screenshot({ path: w.join(base, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  await s.close();
}
console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
console.log((await readdir(IMG)).join(' '));
if (!failed) await rm(base, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
