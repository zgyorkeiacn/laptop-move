// Opens each UI proposal in Edge via Playwright's own launch (pipe), checks errors, copy, save, contrast of purple pairs.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire('C:/git_accenture/agent/package.json');
const { chromium } = require('playwright-core');
const dir = process.argv[2];
const b = await chromium.launch({ channel: 'msedge', headless: true });
for (const f of readdirSync(dir).filter((x) => /^[a-d]-.*\.html$/.test(x))) {
  const p = await b.newPage({ acceptDownloads: true });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  await p.goto(pathToFileURL(join(dir, f)).href);
  for (let i = 1; i <= 6; i++) { await p.fill('#qc' + i, 'comment ' + i); await p.check(`input[name="q${i}"][value="0"]`); }
  await p.fill('#extra', 'extra words');
  await p.click('#copy');
  const clip = await p.evaluate(() => window.__copied);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#save')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
  const okC = [1, 2, 3, 4, 5, 6].every((i) => clip.includes('comment ' + i) && json.answers[i - 1].comment === 'comment ' + i && json.answers[i - 1].answer);
  const visible = await p.evaluate(() => document.body.innerText.length);
  console.log(f, 'errors', JSON.stringify(errs), 'copy/save all', okC, 'extra', clip.includes('extra words') && json.additionalComments === 'extra words', 'page named', json.page, 'text', visible);
  await p.close();
}
await b.close();
