// The guide: its topics in reading order, grouped into parts, and the one-page printable form of all of them.
// Used by the page's server (/guide/print, images from /guide/img) and by scripts/build-guide.mjs (the self-contained file:
// the style and the pictures are inlined). The topic pages themselves are the fragments in kit\ui\guide\<topic>.html.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const w = path.win32;
export const UI_DIR = w.dirname(fileURLToPath(import.meta.url));
export const GUIDE_DIR = w.join(UI_DIR, 'guide');

/** The topics, in reading order. */
export const TOPICS = [
  { id: 'start', title: 'Getting started', part: 'Getting started' },
  { id: 'before', title: 'Before the move', part: 'Getting started' },
  { id: 'scan', title: 'Scan', part: 'Packing on the old laptop' },
  { id: 'choose', title: 'Choose what moves', part: 'Packing on the old laptop' },
  { id: 'byhand', title: 'The by-hand list', part: 'Packing on the old laptop' },
  { id: 'dryrun', title: 'The dry run', part: 'Packing on the old laptop' },
  { id: 'password', title: 'The password', part: 'Packing on the old laptop' },
  { id: 'pack', title: 'Pack', part: 'Packing on the old laptop' },
  { id: 'upload', title: 'Upload and download', part: 'Uploading' },
  { id: 'restore', title: 'Restore', part: 'Restoring on the new laptop' },
  { id: 'report', title: 'Reading the report', part: 'Restoring on the new laptop' },
  { id: 'trouble', title: 'Troubleshooting', part: 'Help' },
  { id: 'faq', title: 'Questions and answers', part: 'Help' },
  { id: 'security', title: 'Security notes for IT', part: 'Help' },
];
export const TOPIC_IDS = TOPICS.map((t) => t.id);

/** @param {string} s */
export const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** @param {string} t */
export async function readTopic(t) {
  try { return await readFile(w.join(GUIDE_DIR, `${t}.html`), 'utf8'); } catch { return `<h2>${esc(t)}</h2><p>This page of the guide comes later.</p>`; }
}

/** The links between topics, for one page of the guide. @param {string} current */
export function topicNav(current) {
  const i = TOPIC_IDS.indexOf(current);
  const prev = TOPICS[i - 1], next = TOPICS[i + 1];
  const items = TOPICS.map((t) => `<li${t.id === current ? ' class="cur" aria-current="page"' : ''}><a href="/guide/${t.id}">${esc(t.title)}</a></li>`).join('');
  return `<nav class="gnav" aria-label="Guide topics"><p><a href="/guide/print">The whole guide, to print</a></p><ol>${items}</ol></nav>`
    + `<p class="gpager">${prev ? `<a class="btn ghost sm" href="/guide/${prev.id}">Back: ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="btn sm" href="/guide/${next.id}">Next: ${esc(next.title)}</a>` : ''}</p>`;
}

/**
 * The printable form: a cover, the contents, and every topic as a numbered section under its part.
 * @param {{inline?: (src: string) => Promise<string|null>, version?: string, date?: string}} [o]
 *   inline: turns an image address (/guide/img/x.png) into a data address; without it the address is kept.
 */
export async function printableBody(o = {}) {
  const parts = [...new Set(TOPICS.map((t) => t.part))];
  const toc = parts.map((p) => `<li><strong>${esc(p)}</strong><ol>${TOPICS.filter((t) => t.part === p).map((t) => `<li><a href="#g-${t.id}">${esc(t.title)}</a></li>`).join('')}</ol></li>`).join('');
  let body = '';
  for (const p of parts) {
    body += `<h1 class="gpart">${esc(p)}</h1>`;
    for (const t of TOPICS.filter((x) => x.part === p)) {
      let html = await readTopic(t.id);
      html = html.replace(/href="\/guide\/print"/g, 'href="#g-start"').replace(/href="\/guide\/([a-z0-9-]+)"/g, 'href="#g-$1"');
      if (o.inline) {
        const found = [...new Set([...html.matchAll(/src="(\/guide\/img\/[a-z0-9-]+\.png)"/g)].map((m) => m[1]))];
        for (const src of found) { const data = await o.inline(src); if (data) html = html.split(`src="${src}"`).join(`src="${data}"`); }
      }
      body += `<section class="gsec" id="g-${t.id}">${html}</section>`;
    }
  }
  const cover = `<header class="gcover"><p class="gkicker">Accenture</p><h1>Laptop mover</h1><p class="gsub">Move your work to a new laptop: tutorials, detailed instructions, FAQ and security notes</p>${o.version ? `<p class="gver">Version ${esc(o.version)}${o.date ? `, ${esc(o.date)}` : ''}</p>` : ''}</header>`;
  return `${cover}<nav class="gtoc" aria-label="Contents"><h2>Contents</h2><ol>${toc}</ol></nav>${body}`;
}
