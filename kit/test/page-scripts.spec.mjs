// page-scripts: every inline script of the mock and the 4 UI proposal pages must parse, so a syntax error fails the gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mock = path.join(root, 'docs', 'mock', 'laptop-mover-mock.html');
const uiDir = path.join(root, 'docs', 'proposals', 'laptop-mover-ui');

/** @param {string} html @returns {string[]} the bodies of the inline (no src) scripts */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    if (/\btype\s*=\s*["']?(?!text\/javascript|module)/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

const proposals = (await readdir(uiDir)).filter((f) => f.endsWith('.html')).map((f) => path.join(uiDir, f));

test('the mock and the 4 proposal pages are all found', () => {
  assert.equal(proposals.length, 4);
});

for (const file of [mock, ...proposals]) {
  test(`inline scripts parse: ${path.basename(file)}`, async () => {
    const scripts = inlineScripts(await readFile(file, 'utf8'));
    assert.ok(scripts.length > 0, 'the page has an inline script');
    scripts.forEach((body, i) => {
      assert.doesNotThrow(() => new vm.Script(body, { filename: `${path.basename(file)}#${i}` }));
    });
  });
}
