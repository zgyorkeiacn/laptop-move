// The mover's page in Edge, on sample data only: every screen, its help link, a scan, a dry run, the password checks
// (Pack is never pressed), a restore check against an empty folder, the printable guide and the End button.
// Playwright starts Edge itself and talks to it over a pipe; no debugging port is opened.
//
// Usage: node scripts/check-ui.mjs [--playwright <folder>] [--headed]
//   <folder>: a node_modules\playwright-core folder, or a project folder whose node_modules holds it.
//   The environment variable PLAYWRIGHT_CORE may name the same instead.
// Everything it makes stays in scratch\check-ui of this repository (gitignored) and is removed first on each run.
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../kit/ui/server.mjs';
import { saveSelection } from '../kit/lib/selection.mjs';

const w = path.win32;
const REPO = w.dirname(w.dirname(fileURLToPath(import.meta.url)));
const KIT = w.join(REPO, 'kit');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/** playwright-core from this repository, the --playwright folder or PLAYWRIGHT_CORE. */
function loadPlaywright() {
  const where = opt('--playwright') ?? process.env.PLAYWRIGHT_CORE;
  const tries = [];
  if (where) tries.push(() => (w.basename(where).toLowerCase() === 'playwright-core' ? createRequire(w.join(where, 'package.json'))(where) : createRequire(w.join(where, 'package.json'))('playwright-core')));
  tries.push(() => createRequire(w.join(REPO, 'package.json'))('playwright-core'));
  for (const t of tries) { try { return t(); } catch { /* the next one */ } }
  throw new Error('playwright-core was not found: pass --playwright <folder> or set PLAYWRIGHT_CORE');
}

const results = [];
/** @param {string} name @param {boolean} ok @param {string} [extra] */
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

// ---- sample data in scratch -----------------------------------------------------------------------------------------
const base = w.join(REPO, 'scratch', 'check-ui');
await rm(base, { recursive: true, force: true });
const src = w.join(base, 'src');
const parts = w.join(base, 'parts');
const shots = w.join(base, 'shots');
for (const d of ['docs', 'notes', '.ssh', w.join('tools', '.git')]) await mkdir(w.join(src, d), { recursive: true });
for (const d of [parts, shots, w.join(base, 'work')]) await mkdir(d, { recursive: true });
await writeFile(w.join(src, 'docs', 'a.md'), '# sample\n');
await writeFile(w.join(src, 'notes', 'n.txt'), 'sample note\n');
await writeFile(w.join(src, '.ssh', 'id_sample'), 'not a real key\n');
await writeFile(w.join(src, 'tools', '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://git.example.invalid/team/tools.git\n');
await writeFile(w.join(src, 'tools', 'README.md'), '# tools\n');
const selFile = w.join(base, 'laptop-move-selection.json');
await saveSelection(selFile, {
  savedAt: '2026-11-23T09:00:00Z',
  folders: [
    { path: w.join(src, 'docs'), mode: 'copy whole' },
    { path: w.join(src, 'notes'), mode: 'copy whole' },
    { path: w.join(src, '.ssh'), mode: 'by hand' },
  ],
  applications: [{ name: 'Git', wingetId: 'Git.Git', source: 'winget' }],
  settings: [],
});

// ---- the server and Edge --------------------------------------------------------------------------------------------
const { chromium } = loadPlaywright();
const s = await startServer({ kitDir: KIT, selection: selFile, noClientRules: true, scanRoots: [src], appLookup: false, open: false, idleMs: 60000 });
const browser = await chromium.launch({ channel: 'msedge', headless: !args.includes('--headed') });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
/** @type {string[]} */ const errors = [];
let allow400 = false;
page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
context.on('response', (r) => { if (r.status() >= 400 && !(allow400 && r.status() === 400)) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (allow400 && /status of 400/.test(m.text())) return; // the expected refusal of the empty bundle folder
  errors.push(`console ${m.text()}`);
});
const text = async (/** @type {string} */ sel) => (await page.locator(sel).textContent())?.trim() ?? '';
const waitText = (/** @type {string} */ sel, /** @type {RegExp} */ re, timeout = 60000) =>
  page.waitForFunction(([q, src0, flags]) => new RegExp(src0, flags).test(document.querySelector(q)?.textContent ?? ''), [sel, re.source, re.flags], { timeout });

try {
  await page.goto(s.url);
  check('the one-time link opens the page', /\/$|\/#/.test(page.url()) && !page.url().includes(s.token), page.url().replace(/\?.*/, ''));
  await waitText('#selinfo', /laptop-move-selection\.json/);
  check('the sample selection is loaded', /3 folder rows/.test(await text('#selinfo')), await text('#selinfo'));
  const other = await browser.newContext();
  const reused = await (await other.newPage()).goto(s.url);
  check('the link is spent after one use', reused?.status() === 403, String(reused?.status()));
  await other.close();

  // every screen, with its help link and its guide page
  const ids = await page.locator('[data-toc]').evaluateAll((bs) => bs.map((b) => String(b.getAttribute('data-toc'))));
  check('the side menu lists 17 screens', ids.length === 17, ids.join(' '));
  for (const id of ids) {
    await page.click(`[data-toc="${id}"]`);
    const art = page.locator(`article[data-screen="${id}"]`);
    const help = art.locator('a.help[data-helplink]');
    const topic = (await help.count()) ? await help.first().getAttribute('data-helplink') : null;
    const guide = topic ? await page.request.get(new URL(`/guide/${topic}`, s.url).href) : null;
    check(`screen ${id}: shown, with a help link to a guide page`, (await art.isVisible()) && (await help.first().isVisible()) && guide?.status() === 200, `guide/${topic}`);
    await page.screenshot({ path: w.join(shots, `${String(ids.indexOf(id) + 1).padStart(2, '0')}-${id}.png`), fullPage: true });
  }

  // the rules the user set, as the page shows them
  await page.click('[data-toc="settings"]');
  check('Wi-Fi is a check on the new laptop', /no Wi-Fi profile or key is packed/.test(await text('#wifinote')), await text('#wifinote'));
  check('printers are on the by-hand list', /not moved/.test(await text('#printernote')), await text('#printernote'));
  await page.click('[data-toc="upload"]');
  const up = await text('article[data-screen="upload"]');
  check('the upload screen says Accenture OneDrive only, never a client\'s', /Accenture OneDrive only/.test(up) && /client's OneDrive/.test(up) && !/Google/i.test(up));

  // scan the sample tree, read only
  await page.click('[data-toc="scan"]');
  await page.fill('#scanroots', src);
  await page.uncheck('#scanapps');
  await page.click('#scango');
  await waitText('#scanstat', /^done$|error|refused|cannot/i);
  check('the scan ends', (await text('#scanstat')) === 'done', await text('#scantext'));
  await page.click('[data-toc="folders"]');
  const folders = await text('#folderrows');
  check('the folders screen lists the sample folders', /docs/.test(folders) && /notes/.test(folders) && /\.ssh/.test(folders));
  await page.click('[data-toc="repos"]');
  const repos = await text('#reporows');
  check('the repositories screen lists the sample repository, without its address', /tools/.test(repos) && !/example\.invalid/.test(await page.content()));
  await page.click('[data-toc="byhand"]');
  const byhand = await text('#byhandrows');
  check('the by-hand list holds the secret folder and the printer check', /\.ssh/.test(byhand) && /print/i.test(byhand), byhand.slice(0, 120));

  // save the selection to scratch
  await page.fill('#savefile', w.join(base, 'saved', 'laptop-move-selection.json'));
  await page.click('#savego');
  await waitText('#savestat', /saved to|cannot|refused|error/i);
  check('the selection saves to the named file', /^saved to /.test(await text('#savestat')) && existsSync(w.join(base, 'saved', 'laptop-move-selection.json')), await text('#savestat'));

  // the dry run: nothing is written
  await page.click('[data-toc="dryrun"]');
  const out = w.join(base, 'out');
  await page.fill('#outdir', out);
  await page.click('#drygo');
  await waitText('#drystat', /^finished|error|refused|cannot/i, 120000);
  check('the dry run ends ready to pack', (await text('#drystat')) === 'finished: ready to pack', await text('#drystat'));
  const dry = await text('#dryout');
  check('the dry run shows the steps for the new laptop', /print/i.test(dry) && /Wi-Fi/.test(dry));
  check('the dry run wrote nothing', !existsSync(out));

  // the password: checked in the page; Pack is never pressed
  await page.click('[data-toc="password"]');
  await page.fill('#pw1', 'short');
  await page.fill('#pw2', 'short');
  const shortOff = await page.locator('#packgo').isDisabled();
  const good = randomBytes(12).toString('base64url');
  await page.fill('#pw1', good);
  await page.fill('#pw2', good);
  const goodOn = await page.locator('#packgo').isEnabled();
  await page.fill('#pw2', `${good}x`);
  const differOff = await page.locator('#packgo').isDisabled();
  await page.fill('#pw1', 'Pässwort-mit-Umlaut');
  await page.fill('#pw2', 'Pässwort-mit-Umlaut');
  const asciiOff = await page.locator('#packgo').isDisabled();
  await page.fill('#pw1', '');
  await page.fill('#pw2', '');
  check('Pack stays off for a short, a differing or an accented password, and turns on for a good one', shortOff && goodOn && differOff && asciiOff);
  check('the password is in no address', !page.url().includes(good));

  // the restore check against an empty folder: a handled refusal, nothing written
  await page.click('[data-toc="restore"]');
  await page.fill('#rsfrom', parts);
  await page.fill('#rswork', w.join(base, 'work'));
  allow400 = true;
  await page.click('#rsdry');
  await waitText('#rsdrystat', /^(?!checking$)./);
  allow400 = false;
  check('the restore check of an empty folder is answered on the page', (await text('#rsdrystat')).length > 0, await text('#rsdrystat'));
  check('the restore check wrote nothing', (await readdir(parts)).length === 0 && (await readdir(w.join(base, 'work'))).length === 0);

  // the printable guide
  const g = await context.newPage();
  g.on('pageerror', (e) => errors.push(`guide pageerror ${e.message}`));
  g.on('console', (m) => { if (m.type() === 'error') errors.push(`guide console ${m.text()}`); });
  await g.goto(new URL('/guide/print', s.url).href);
  const sections = await g.locator('section.gsec').count();
  check('the printable guide holds all 12 topics', sections === 12, String(sections));
  await g.screenshot({ path: w.join(shots, '18-guide-print.png'), fullPage: true });
  await g.close();

  // End
  await page.click('[data-toc="start"]');
  await page.click('#end');
  await page.locator('#ended').waitFor({ state: 'visible', timeout: 10000 });
  const stopped = await Promise.race([s.closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
  check('End stops the mover', stopped === true);
  await page.screenshot({ path: w.join(shots, '19-ended.png'), fullPage: true });
} catch (e) {
  check('the run went through', false, String(/** @type {Error} */ (e).stack ?? e));
} finally {
  await browser.close();
  await s.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed. Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
