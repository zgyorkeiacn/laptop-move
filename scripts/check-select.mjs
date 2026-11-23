// FORM-GAPS check of data/select.html in Edge through Playwright's own launch (pipe; no debugging port, no CDP).
// Usage: node scripts/check-select.mjs   (reads data/select.html, data/saved-selection.json, data/inventory.json)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire('C:/git_accenture/agent/package.json');
const { chromium } = require('playwright-core');
const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, '..', 'data');
const page = resolve(data, 'select.html');
const saved = JSON.parse(readFileSync(join(data, 'saved-selection.json'), 'utf8').replace(/^\uFEFF/, ''));
const inv = JSON.parse(readFileSync(join(data, 'inventory.json'), 'utf8'));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
await p.goto(pathToFileURL(page).href);
check('no page errors', errs.length === 0, JSON.stringify(errs));

await p.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__clip = t; }; });
const copyNow = async () => { await p.click('#copy'); return JSON.parse(await p.evaluate(() => window.__clip)); };
const out = await copyNow();

// pre-fill: old rows equal the saved selection, exactly
const newPaths = new Set(inv.folders.filter((f) => f.isNew).map((f) => f.path.toLowerCase()));
const oldOut = out.folders.filter((f) => !newPaths.has(f.path.toLowerCase())).map((f) => f.path).sort();
const savedF = saved.folders.map((f) => f.path).sort();
check('old folder ticks equal the saved ones', JSON.stringify(oldOut) === JSON.stringify(savedF), `${oldOut.length} vs ${savedF.length}`);
const modeDiff = saved.folders.filter((s) => !out.folders.some((o) => o.path === s.path && o.mode === s.mode));
console.log('NOTE rows whose move mode changed since the save (repos.json was refreshed after it):', modeDiff.map((f) => f.path).join(', ') || 'none');
const aKey = (a) => a.name + '|' + a.wingetId;
check('applications equal the saved ones', JSON.stringify(out.applications.map(aKey).sort()) === JSON.stringify(saved.applications.map(aKey).sort()), `${out.applications.length} vs ${saved.applications.length}`);
check('settings equal the saved ones', JSON.stringify(out.settings.map((s) => s.app).sort()) === JSON.stringify(saved.settings.map((s) => s.app).sort()), `${out.settings.length} vs ${saved.settings.length}`);
check('question answers equal the saved ones', saved.questions.every((q) => out.questions.find((o) => o.question === q.question)?.answer === q.answer));
check('comments equal the saved ones', Object.entries(saved.comments).every(([k, v]) => out.comments[k] === v) && Object.keys(out.comments).length === Object.keys(saved.comments).length);
check('every comment is labelled', Object.keys(out.comments).every((k) => out.commentLabels?.[k]), JSON.stringify(out.commentLabels));
check('same top level keys as before', ['savedAt', 'folders', 'applications', 'settings', 'questions', 'comments'].every((k) => k in out));

// new rows
const nNew = await p.locator('tr.isnew').count();
check('new rows are on the page', nNew === inv.folders.filter((f) => f.isNew).length && nNew > 0, String(nNew));
check('new rows carry the New badge', (await p.locator('tr.isnew .newb').count()) === nNew);
const newTicked = out.folders.filter((f) => newPaths.has(f.path.toLowerCase())).length;
check('new rows ticked equal the recommended ones', newTicked === inv.folders.filter((f) => f.isNew && f.rec).length, String(newTicked));
const secretRows = inv.folders.filter((f) => f.kind === 'secret-bearing' && f.isNew);
check('new secret-bearing folders are unticked', secretRows.every((f) => !out.folders.some((o) => o.path === f.path)), `${secretRows.length} rows`);
const oldSecretTicked = inv.folders.filter((f) => f.kind === 'secret-bearing' && !f.isNew && out.folders.some((o) => o.path === f.path));
console.log('NOTE old secret-bearing rows the user had ticked (kept as he saved them):', oldSecretTicked.map((f) => f.path).join(', ') || 'none');
check('secret paths listed in section 4', inv.secretFiles.some((s) => /Login Data/.test(s)) && (await p.locator('text=Login Data').count()) > 0);

// filter
await p.check('#onlynew');
const visible = await p.locator('tr:not(.hd):visible').count();
check('filter shows only new rows', visible === nNew, `${visible} visible rows`);
await p.uncheck('#onlynew');
check('filter off shows old rows again', (await p.locator('tr:not(.hd):visible').count()) > nNew);

// change a tick, an answer, add comments, then copy and save: everything is in the JSON
await p.fill('textarea[data-c="q2"]', 'comment on question two');
await p.fill('textarea[data-c="additional"]', 'additional words');
await p.fill('textarea[data-c="folders"]', 'folder section words');
const firstNew = inv.folders.find((f) => f.isNew && f.rec);
await p.uncheck(`input[data-id="${firstNew.id}"]`);
const out2 = await copyNow();
check('copy holds old and new comments', out2.comments.q1 === saved.comments.q1 && out2.comments.q2 === 'comment on question two' && out2.comments.additional === 'additional words' && out2.comments.folders === 'folder section words');
check('copy labels by section and question', /^Question 2: /.test(out2.commentLabels.q2) && /^Section 1/.test(out2.commentLabels.folders) && out2.commentLabels.additional === 'Additional comments');
check('unticked new row is gone from the copy', !out2.folders.some((f) => f.path === firstNew.path) && out2.folders.length === out.folders.length - 1);
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#save')]);
const saveText = readFileSync(await dl.path(), 'utf8');
const sv = JSON.parse(saveText);
check('Save selection file equals the copy', JSON.stringify({ ...sv, savedAt: 0 }) === JSON.stringify({ ...out2, savedAt: 0 }) && dl.suggestedFilename() === 'laptop-move-selection.json');
check('every question keeps a comment box', (await p.locator('.q textarea[data-c]').count()) === inv.questions.length);
check('Additional comments field is there', (await p.locator('textarea[data-c="additional"]').count()) === 1);
console.log('new rows', nNew, 'ticked in copy', out.folders.length, 'apps', out.applications.length, 'settings', out.settings.length);
await b.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'FAILURES: ' + results.filter((x) => !x).length);
process.exit(results.every(Boolean) ? 0 : 1);
