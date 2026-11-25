// Research md -> self-contained HTML with a questions form. Usage: node scripts/research-page.mjs <in.md> <out.html> <questions.json>
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, out, qf] = process.argv.slice(2);
const questions = JSON.parse(readFileSync(qf, 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
let lines = readFileSync(inp, 'utf8').split(/\r?\n/);
const qi = lines.findIndex((l) => /^## \d+\. Questions/.test(l));
if (qi >= 0) lines = lines.slice(0, qi);
let h = '', list = null, table = null;
const close = () => { if (list) { h += `</${list}>`; list = null; } if (table) { h += '</table></div>'; table = null; } };
for (const l of lines) {
  if (/^\|/.test(l)) {
    if (/^\|[-| ]+\|$/.test(l)) continue;
    const cells = l.split('|').slice(1, -1).map((c) => inline(c.trim()));
    if (!table) { close(); table = true; h += '<div class="w"><table><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr>'; } else h += '<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>';
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
const form = '<h2>Your questions</h2>' + questions.map((q, i) => `<div class="q" data-q="${i}"><b>${i + 1}. ${esc(q.text)}</b><br>` + q.options.map((o, j) => `<label><input type="radio" name="q${i}" value="${j}"${o.rec ? ' checked' : ''}> ${esc(o.label)}${o.rec ? ' <span class="rec">(Recommended)</span>' : ''}</label><br>`).join('') + `<textarea id="c${i}" placeholder="Comment (optional)"></textarea></div>`).join('') + '<h2>Additional comments</h2><textarea id="extra" placeholder="Anything else (optional)"></textarea><p><button id="copy">Copy answers</button> <span id="msg"></span></p>';
const css = 'body{font:15px/1.5 Segoe UI,Arial,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1d2330}.w{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12.5px;margin:8px 0}td,th{border:1px solid #d5d9e0;padding:4px 7px;text-align:left;vertical-align:top}th{background:#e8ebf1}code{background:#eef0f4;padding:1px 4px}h2{border-bottom:2px solid #d5d9e0;padding-bottom:3px;margin-top:28px}.q{background:#f6f7f9;border-left:5px solid #2b6cb0;padding:8px 12px;margin:12px 0}textarea{width:100%;box-sizing:border-box;min-height:48px;margin-top:6px;font:inherit}.rec{color:#17692a;font-weight:700}button{padding:7px 16px;font-size:15px;cursor:pointer}';
const js = `const Q=${JSON.stringify(questions.map((q) => ({ text: q.text, options: q.options.map((o) => o.label) })))};
document.getElementById('copy').onclick=async()=>{let t='GH.MOVE.INTERNAL-HOSTING.RESEARCH answers\\n\\n';Q.forEach((q,i)=>{const r=document.querySelector('input[name=q'+i+']:checked');t+=(i+1)+'. '+q.text+'\\nAnswer: '+(r?q.options[+r.value]:'(none)')+'\\nComment: '+(document.getElementById('c'+i).value.trim()||'(none)')+'\\n\\n'});t+='Additional comments: '+(document.getElementById('extra').value.trim()||'(none)')+'\\n';let ok=true;try{await navigator.clipboard.writeText(t)}catch(e){const x=document.createElement('textarea');document.body.appendChild(x);x.value=t;x.select();ok=document.execCommand('copy');x.remove()}window.__copied=t;document.getElementById('msg').textContent=ok?'copied':'copy failed'};`;
writeFileSync(out, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(inp.split(/[\\/]/).pop().replace('.md', ''))}</title><style>${css}</style></head><body>${h}${form}<script>${js}</script></body></html>`);
console.log('written', out);
