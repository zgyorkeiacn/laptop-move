// The HTML reports of pack and restore: one self-contained page, no script, no outside resources.
import { esc } from './util.mjs';

/**
 * @typedef {{title: string, intro?: string, columns: string[], rows: (string|number|null|undefined)[][], empty?: string}} Section
 */

const CSS = `
body{font:14px/1.45 "Segoe UI",system-ui,sans-serif;margin:0;background:#f5f6f4;color:#1f2a24}
header{background:#24352c;color:#eef3ee;padding:18px 28px}
header h1{margin:0;font-size:20px;font-weight:600}
header p{margin:4px 0 0;opacity:.8}
main{padding:8px 28px 40px;max-width:1400px}
section{margin-top:22px}
h2{font-size:16px;margin:0 0 6px;color:#24352c}
h2 .n{font-weight:400;color:#5d6b63}
p.intro{margin:0 0 8px;color:#45524b}
table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08)}
th,td{text-align:left;padding:5px 9px;border-bottom:1px solid #e3e7e3;vertical-align:top}
th{background:#e9eee9;font-weight:600}
td{word-break:break-word}
tr.bad td{background:#fdeceb}
tr.warn td{background:#fdf6e3}
tr.good td:first-child{border-left:3px solid #4d8a5e}
.empty{color:#6b776f;font-style:italic}
code{font-family:Consolas,monospace;font-size:13px}
`;

/** Row class from a status word. @param {unknown[]} row */
function rowClass(row) {
  const s = String(row[1] ?? '').toLowerCase();
  if (/^(failed|missing|stopped|refused|timed out)/.test(s)) return 'bad';
  if (/by hand|conflict|warning|skipped|not /.test(s)) return 'warn';
  if (/^(ok|installed|done|cloned|moved|created|restored|copied)/.test(s)) return 'good';
  return '';
}

/**
 * A full HTML page.
 * @param {string} title
 * @param {string} subtitle
 * @param {Section[]} sections
 */
export function htmlReport(title, subtitle, sections) {
  const body = sections.map((s) => {
    const head = `<h2>${esc(s.title)} <span class="n">(${s.rows.length})</span></h2>${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ''}`;
    if (!s.rows.length) return `<section>${head}<p class="empty">${esc(s.empty ?? 'none')}</p></section>`;
    const th = s.columns.map((c) => `<th>${esc(c)}</th>`).join('');
    const tr = s.rows.map((r) => `<tr class="${rowClass(r)}">${r.map((c) => `<td>${esc(c ?? '')}</td>`).join('')}</tr>`).join('\n');
    return `<section>${head}<table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table></section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head>`
    + `<body><header><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></header><main>${body}</main></body></html>\n`;
}
