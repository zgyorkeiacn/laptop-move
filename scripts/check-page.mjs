// Opens a research page in Edge through Playwright's own launch (pipe, no debugging port) and checks the form.
// Usage: node scripts/check-page.mjs <page.html>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('C:/git_accenture/agent/package.json');
const { chromium } = require('playwright-core');
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
await p.goto(pathToFileURL(process.argv[2]).href);
await p.fill('#c0', 'comment zero');
await p.check('input[name="q1"][value="1"]');
await p.fill('#extra', 'extra words');
await p.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__clip = t; }; });
await p.click('#copy');
const clip = await p.evaluate(() => window.__clip ?? window.__copied);
console.log('errors', JSON.stringify(errs));
console.log('has comment', clip.includes('comment zero'), 'has changed answer', clip.includes('The cloud team directly'), 'has extra', clip.includes('extra words'), 'questions', (clip.match(/^\d+\. /gm) || []).length);
await b.close();
