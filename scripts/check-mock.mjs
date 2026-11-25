// The mock page in Edge: opens docs/mock/laptop-mover-mock.html, expects no page error and the first screen (Start) visible.
// Playwright starts Edge itself over a pipe; no debugging port is opened.
// Usage: node scripts/check-mock.mjs [--playwright <folder>]   (or PLAYWRIGHT_CORE; a playwright-core folder or its project folder)
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const w = path.win32;
const REPO = w.dirname(w.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const i = args.indexOf('--playwright');
const where = (i >= 0 ? args[i + 1] : undefined) ?? process.env.PLAYWRIGHT_CORE;
const tries = [];
if (where) tries.push(() => (w.basename(where).toLowerCase() === 'playwright-core' ? createRequire(w.join(where, 'package.json'))(where) : createRequire(w.join(where, 'package.json'))('playwright-core')));
tries.push(() => createRequire(w.join(REPO, 'package.json'))('playwright-core'));
let pw;
for (const t of tries) { try { pw = t(); break; } catch { /* the next one */ } }
if (!pw) throw new Error('playwright-core was not found: pass --playwright <folder> or set PLAYWRIGHT_CORE');

const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
let ok = true;
const check = (name, pass, extra = '') => { if (!pass) ok = false; console.log(pass ? 'PASS' : 'FAIL', name, extra); };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(w.join(REPO, 'docs', 'mock', 'laptop-mover-mock.html')).href);
  const start = page.locator('article[data-screen="start"]');
  await start.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  check('no page error', errors.length === 0, errors.join(' | '));
  check('the Start screen is visible', await start.isVisible());
  const toc = page.locator('[data-toc]');
  if (await toc.count()) {
    await toc.nth(1).click();
    check('navigation shows another screen and hides Start', !(await start.isVisible()));
  }
} finally { await browser.close(); }
process.exit(ok ? 0 : 1);
