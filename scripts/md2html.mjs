// Minimal markdown to HTML for the research page. Usage: node scripts/md2html.mjs <in.md> <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, out] = process.argv.slice(2);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const lines = readFileSync(inp, 'utf8').split(/\r?\n/);
let h = '', list = null, table = null;
const close = () => { if (list) { h += `</${list}>`; list = null; } if (table) { h += '</table>'; table = null; } };
for (const l of lines) {
  if (/^\|/.test(l)) {
    if (/^\|[-| ]+\|$/.test(l)) continue;
    const cells = l.split('|').slice(1, -1).map((c) => inline(c.trim()));
    if (!table) { close(); table = true; h += '<table>' + '<tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr>'; } else h += '<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>';
    continue;
  }
  const hm = l.match(/^(#{1,3}) (.*)/);
  if (hm) { close(); h += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`; continue; }
  const om = l.match(/^\d+\. (.*)/), um = l.match(/^- (.*)/);
  if (om) { if (list !== 'ol') { close(); list = 'ol'; h += '<ol>'; } h += `<li>${inline(om[1])}</li>`; continue; }
  if (um) { if (list !== 'ul') { close(); list = 'ul'; h += '<ul>'; } h += `<li>${inline(um[1])}</li>`; continue; }
  close();
  if (l.trim()) h += `<p>${inline(l)}</p>`;
}
close();
const css = 'body{font:15px/1.5 Segoe UI,Arial,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1d2330}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #d5d9e0;padding:4px 7px;text-align:left;vertical-align:top}th{background:#e8ebf1}code{background:#eef0f4;padding:1px 4px}h2{border-bottom:2px solid #d5d9e0;padding-bottom:3px;margin-top:28px}';
writeFileSync(out, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>LAPTOP.MOVE.RESEARCH</title><style>${css}</style></head><body>${h}</body></html>`);
console.log('written', out);
