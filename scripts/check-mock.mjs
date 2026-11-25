// The mock page (docs/mock/laptop-mover-mock.html) in Edge: no page error, the start screen visible at load with
// the others hidden, and every data-go target showing its own screen when clicked.
// Playwright starts Edge itself and talks to it over a pipe; no debugging port is opened.
//
// Usage: node scripts/check-mock.mjs [--playwright <folder>] [--file <html>] [--headed]
//   <folder>: a node_modules\playwright-core folder, or a project folder whose node_modules holds it.
//   The environment variable PLAYWRIGHT_CORE may name the same instead.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const w = path.win32;
const REPO = w.dirname(w.dirname(fileURLToPath(import.meta.url)));
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

const file = opt('--file') ?? w.join(REPO, 'docs', 'mock', 'laptop-mover-mock.html');
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ channel: 'msedge', headless: !args.includes('--headed') });
/** @type {string[]} */ const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(file).href);

  const screens = await page.locator('article[data-screen]').evaluateAll((a) => a.map((e) => String(e.getAttribute('data-screen'))));
  check('the page has screens', screens.length > 1, `${screens.length} screens`);
  const visible = async () => page.locator('article[data-screen]').evaluateAll((a) => a.filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').map((e) => String(e.getAttribute('data-screen'))));
  check('no page error at load', errors.length === 0, errors.join(' | '));
  const first = await visible();
  check('the start screen is visible at load and the others are hidden', first.length === 1 && first[0] === 'start' && await page.locator('article[data-screen=start]').isVisible(), first.join(','));

  const targets = await page.locator('[data-go]').evaluateAll((b) => [...new Set(b.map((e) => String(e.getAttribute('data-go'))))]);
  check('the page has navigation targets', targets.length > 0, `${targets.length} targets`);
  for (const t of targets) {
    const before = errors.length;
    const known = screens.includes(t);
    // a DOM click: the button may sit on a screen that is not the one showing
    await page.evaluate((id) => { document.querySelector(`[data-go="${id}"]`)?.click(); }, t);
    const now = await visible();
    check(`data-go ${t}: shows its own screen alone, no page error`, known && now.length === 1 && now[0] === t && errors.length === before, `${now.join(',')}${errors.length > before ? ' ' + errors.slice(before).join(' | ') : ''}`);
  }
  check('no page error in the whole run', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run went through', false, String(/** @type {Error} */ (e).stack ?? e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
