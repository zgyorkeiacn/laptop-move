// Builds the printable guide as ONE self-contained HTML file: the style and the pictures are inlined, no outside script or font.
// Usage: node scripts/build-guide.mjs [out-file]     (default: docs\guide\laptop-move-guide.html)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_DIR, GUIDE_DIR, printableBody, esc } from '../kit/ui/guide-build.mjs';

const w = path.win32;
const REPO = w.dirname(w.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2] ? w.resolve(process.argv[2]) : w.join(REPO, 'docs', 'guide', 'laptop-move-guide.html');
const pkg = JSON.parse(await readFile(w.join(REPO, 'package.json'), 'utf8'));
const date = new Date().toISOString().slice(0, 10);

const css = (await readFile(w.join(UI_DIR, 'app.css'), 'utf8')) + '\n' + (await readFile(w.join(UI_DIR, 'guide.css'), 'utf8'));
/** @param {string} src */
const inline = async (src) => {
  const name = /^\/guide\/img\/([a-z0-9-]+\.png)$/.exec(src)?.[1];
  if (!name) return null;
  return `data:image/png;base64,${(await readFile(w.join(GUIDE_DIR, 'img', name))).toString('base64')}`;
};
const body = await printableBody({ inline, version: String(pkg.version), date });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc('Laptop mover guide')}</title><style>${css}</style></head><body class="plain"><main class="guide"><p class="noprint"><button class="btn" type="button" onclick="window.print()">Print the guide</button></p>${body}</main></body></html>`;
await mkdir(w.dirname(out), { recursive: true });
await writeFile(out, html, 'utf8');
console.log(out);
