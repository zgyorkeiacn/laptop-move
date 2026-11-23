// Builds the four laptop-mover UI proposals (self-contained HTML, sample data only).
// Usage: node scripts/build-ui-proposals.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'proposals', 'laptop-mover-ui');
mkdirSync(out, { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ---------- shared CSS (Accenture look: core purple A100FF, black, white, greys; Arial fallback) ----------
const css = `
:root{--p:#A100FF;--pd:#7500C0;--pdd:#460073;--pl:#E6DCFF;--pll:#F5EFFF;--k:#000;--g1:#1A1A1A;--g2:#4D4D4D;--g3:#6B6B6B;--g4:#D0D0D0;--g5:#F2F2F2;--ok:#0B6B2E;--warn:#8A4B00;--bad:#B00020}
*{box-sizing:border-box}
body{margin:0;font-family:Graphik,Arial,Helvetica,sans-serif;color:var(--g1);background:#fff;line-height:1.5;font-size:15px}
h1,h2,h3,h4{margin:0 0 .5em;line-height:1.2}
h1{font-size:26px}h2{font-size:21px}h3{font-size:17px}h4{font-size:15px}
a{color:var(--pd)}
:focus-visible{outline:3px solid var(--k);outline-offset:2px}
.logo-slot{display:inline-flex;align-items:center;justify-content:center;min-width:150px;height:40px;border:2px dashed currentColor;font-size:11px;text-align:center;padding:2px 8px;line-height:1.2}
.btn{display:inline-block;background:var(--p);color:#fff;border:2px solid var(--p);padding:8px 16px;font:inherit;font-weight:700;cursor:pointer;border-radius:0}
.btn:hover{background:var(--pd);border-color:var(--pd)}
.btn.ghost{background:#fff;color:var(--pdd);border-color:var(--pdd)}
.btn.ghost:hover{background:var(--pl)}
.btn.sm{padding:4px 10px;font-size:13px}
.card{border:1px solid var(--g4);background:#fff;padding:16px;margin:0 0 16px}
.card.purple{background:var(--pll);border-color:var(--pl)}
.tag{display:inline-block;padding:1px 8px;font-size:12px;font-weight:700;border:1px solid currentColor}
.tag.ok{color:var(--ok)}.tag.warn{color:var(--warn)}.tag.bad{color:var(--bad)}.tag.pp{color:var(--pdd)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--g4);vertical-align:top}
th{background:var(--g5);font-size:13px}
.num{text-align:right;white-space:nowrap}
.bar{height:16px;background:var(--g5);border:1px solid var(--g4)}.bar>i{display:block;height:100%;background:var(--p)}
code,.mono{font-family:Consolas,Menlo,monospace;font-size:13px;background:var(--g5);padding:1px 5px}
pre{background:var(--k);color:#fff;padding:12px;overflow:auto;font-size:13px;margin:0 0 12px}
.sample{font-size:12px;color:var(--g2);border-top:1px dashed var(--g4);margin-top:8px;padding-top:4px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.screen{border:2px solid var(--k);background:#fff;margin:0 0 16px}
.screen>.sbar{background:var(--k);color:#fff;font-size:12px;padding:4px 10px;display:flex;justify-content:space-between}
.screen>.sbody{padding:16px}
.hide{display:none!important}
details{border:1px solid var(--g4);padding:8px 12px;margin:0 0 8px}summary{cursor:pointer;font-weight:700}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:4px;z-index:9}
/* questions */
#questions{border-top:6px solid var(--p);margin:40px auto 0;max-width:900px;padding:24px 16px 48px}
#questions fieldset{border:1px solid var(--g4);margin:0 0 20px;padding:12px 16px}
#questions legend{font-weight:700;padding:0 6px}
#questions label.opt{display:block;margin:4px 0}
#questions .rec{color:var(--pdd);font-weight:700}
#questions textarea{width:100%;min-height:54px;font:inherit;margin-top:8px;padding:6px;border:1px solid var(--g2)}
#questions .cl{font-size:13px;color:var(--g2);display:block;margin-top:8px}
#status{margin-left:12px;font-weight:700;color:var(--pdd)}
`;

// ---------- sample data ----------
const folders = [
  ['C:\\work\\projects', '4.2 GB', 'tick'], ['C:\\work\\notes', '120 MB', 'tick'], ['C:\\tools\\scripts', '36 MB', 'tick'],
  ['C:\\Users\\sample.user\\Documents', '1.9 GB', 'tick'], ['C:\\Users\\sample.user\\AppData\\Local\\SampleApp', '310 MB', ''], ['C:\\data\\scratch', '8.7 GB', ''],
];
const apps = [
  ['Visual Studio Code', 'winget', 'Microsoft.VisualStudioCode'], ['Git', 'winget', 'Git.Git'], ['Node.js LTS', 'winget', 'OpenJS.NodeJS.LTS'],
  ['7-Zip', 'winget', '7zip.7zip'], ['SampleDraw Pro', 'vendor link (signature checked)', 'publisher: Sample Vendor Inc.'], ['Corporate VPN client', 'Software Center (listed only)', 'install by hand'],
];
const repos = [
  ['sample-api', 'has remote', 'clone again; 2 unpushed commits travel as a git bundle; 3 uncommitted files copied'],
  ['sample-ui', 'has remote', 'clone again; clean'],
  ['sample-notes', 'no remote', 'copied whole'],
  ['client-service-a', 'client, has remote', 'stays out; push first (4 commits not pushed)'],
  ['client-tools-b', 'client, no remote', 'client part only, upload to company OneDrive only'],
];
const settings = [['Git config and aliases', 'tick'], ['VS Code settings and extension list', 'tick'], ['Terminal profile', 'tick'], ['Environment variables (names only, values reviewed)', 'tick'], ['Wi-Fi profiles', ''], ['Printer list', '']];
const byhand = [
  ['.env and .env.* files', 'secrets in plain text'], ['.npmrc with tokens', 'registry tokens'], ['.ssh folder', 'private keys'],
  ['Cloud CLI credentials', 'access keys'], ['Browser saved logins', 'passwords and cookies'], ['Password manager vault', 'export it from its own app'],
];

// ---------- screens (shared building blocks) ----------
const chk = (id, label, on, extra = '') => `<label style="display:block;margin:3px 0"><input type="checkbox" ${on ? 'checked' : ''} aria-label="${esc(label)}"> ${esc(label)} ${extra}</label>`;
const sampleNote = '<div class="sample">Sample data only. No real names, paths or secrets.</div>';

const sChoose = () => `<h3>Choose what moves</h3>
<div class="grid2"><div><h4>Folders</h4>${folders.map((f) => chk('', f[0] + ' (' + f[1] + ')', f[2])).join('')}</div>
<div><h4>Applications</h4>${apps.map((a) => chk('', a[0], !a[1].startsWith('Software'), '<span class="tag pp">' + esc(a[1].split(' (')[0]) + '</span>')).join('')}</div></div>
<div class="grid2"><div><h4>Repositories</h4>${repos.map((r) => chk('', r[0], !r[1].startsWith('client'), '<span class="tag ' + (r[1].startsWith('client') ? 'warn' : 'ok') + '">' + esc(r[1]) + '</span>')).join('')}</div>
<div><h4>Settings</h4>${settings.map((s) => chk('', s[0], !!s[1])).join('')}</div></div>
<p><strong>Selected: 9.6 GB in 14 items.</strong> <button class="btn sm" type="button">Run dry run</button></p>${sampleNote}`;

const sDry = () => `<h3>Dry run (nothing is written yet)</h3>
<table><tr><th>What</th><th class="num">Size</th><th>Where it goes</th></tr>
<tr><td>Data part 1 to 3</td><td class="num">9.6 GB</td><td>encrypted 7-Zip volumes, 4 GB each</td></tr>
<tr><td>Client part</td><td class="num">0.4 GB</td><td>client-*.7z.*, company OneDrive only</td></tr>
<tr><td>Kit zip</td><td class="num">42 MB</td><td>plain zip: mover, manifest, README, signed node.exe</td></tr></table>
<p>Time: about 18 min to pack, about 25 min to restore. Upload time depends on the network.</p>
<h4>Applications, by route</h4>
<table><tr><th>App</th><th>Route</th></tr>${apps.map((a) => `<tr><td>${esc(a[0])}</td><td>${esc(a[1])}</td></tr>`).join('')}</table>
<div class="card purple" style="margin-top:12px"><strong>Push first:</strong> client-service-a has 4 commits that are not pushed. Push them, then run the dry run again.</div>${sampleNote}`;

const sPack = () => `<h3>Packing</h3>
<p>Password: typed at the 7-Zip prompt. The mover never sees or stores it.</p>
${[['Part 1 of 3', 100], ['Part 2 of 3', 64], ['Part 3 of 3', 0], ['Client part', 0], ['Checksums', 0]].map((p) => `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><span>${p[0]}</span><span>${p[1]}%</span></div><div class="bar" role="progressbar" aria-valuenow="${p[1]}" aria-valuemin="0" aria-valuemax="100" aria-label="${p[0]}"><i style="width:${p[1]}%"></i></div></div>`).join('')}
<p class="mono">elapsed 07:42 &nbsp; remaining about 10 min</p>${sampleNote}`;

const sRestore = () => `<h3>Restoring on the new laptop</h3>
<table><tr><th>Step</th><th>State</th></tr>
<tr><td>Check the checksums</td><td><span class="tag ok">passed</span></td></tr>
<tr><td>Unpack the data parts</td><td><span class="tag ok">done</span></td></tr>
<tr><td>Install applications</td><td><span class="tag pp">running 4 of 6</span></td></tr>
<tr><td>Clone repositories again</td><td>waiting</td></tr>
<tr><td>Put folders and settings back</td><td>waiting</td></tr>
<tr><td>Write the report</td><td>waiting</td></tr></table>
<div class="bar" style="margin-top:10px" role="progressbar" aria-valuenow="45" aria-valuemin="0" aria-valuemax="100" aria-label="Restore"><i style="width:45%"></i></div>
<p class="mono">An app is installed only when its signature is valid and matches the recorded publisher.</p>${sampleNote}`;

const sReport = () => `<h3>Final report</h3>
<p><span class="tag ok">11 done</span> <span class="tag warn">2 to do by hand</span> <span class="tag bad">1 failed</span></p>
<table><tr><th>Item</th><th>Result</th></tr>
<tr><td>Folders and settings</td><td><span class="tag ok">restored</span></td></tr>
<tr><td>sample-api</td><td><span class="tag ok">cloned, 2 commits restored, 3 files copied</span></td></tr>
<tr><td>SampleDraw Pro</td><td><span class="tag bad">signature did not match the recorded publisher, not run</span></td></tr>
<tr><td>Corporate VPN client</td><td><span class="tag warn">install from Software Center</span></td></tr>
<tr><td>client-service-a</td><td><span class="tag warn">clone again after you push</span></td></tr></table>
<p><button class="btn sm" type="button">Open the report as HTML</button> <button class="btn ghost sm" type="button">Print</button></p>${sampleNote}`;

const sByHand = () => `<h3>Move by hand</h3><p>These files are never copied. They hold secrets. Move each one the safe way for what it is.</p>
<table><tr><th>Item</th><th>Why</th><th>Done</th></tr>${byhand.map((b) => `<tr><td>${esc(b[0])}</td><td>${esc(b[1])}</td><td><input type="checkbox" aria-label="Done: ${esc(b[0])}"></td></tr>`).join('')}</table>${sampleNote}`;

const sTutorial = () => `<h3>Tutorial: your first move in 5 steps</h3>
<svg viewBox="0 0 640 110" width="100%" role="img" aria-label="Five steps: scan, choose, pack, upload, restore">
${['Scan', 'Choose', 'Pack', 'Upload', 'Restore'].map((t, i) => `<g><rect x="${8 + i * 126}" y="20" width="110" height="60" fill="${i < 3 ? '#A100FF' : '#460073'}"/><text x="${63 + i * 126}" y="56" fill="#fff" font-family="Arial" font-size="16" font-weight="700" text-anchor="middle">${i + 1}. ${t}</text></g>${i < 4 ? `<path d="M${120 + i * 126} 50h12" stroke="#000" stroke-width="2"/>` : ''}`).join('')}
<text x="8" y="104" font-size="12" font-family="Arial" fill="#4D4D4D">Purple: old laptop. Dark purple: moving and new laptop.</text></svg>
<ol><li><strong>Scan.</strong> The mover lists folders, applications, settings and repositories. Nothing is changed.</li>
<li><strong>Choose.</strong> Tick what moves. Client repositories with a remote stay out.</li>
<li><strong>Pack.</strong> Type a password when 7-Zip asks. Keep it safe: it is not stored.</li>
<li><strong>Upload.</strong> Put the bundle on Accenture OneDrive or Google Drive yourself.</li>
<li><strong>Restore.</strong> On the new laptop download the bundle and run one command.</li></ol>
<div class="card purple"><strong>Tip:</strong> run the dry run first. It shows size, parts, time and the route of every app.</div>${sampleNote}`;

const sInstr = () => `<h3>Detailed instructions: restore on the new laptop</h3>
<ol><li>Download the kit zip and all data parts into one new folder, for example <code>C:\\move</code>.</li>
<li>Unzip <code>laptop-move-kit.zip</code> there. It holds the mover, the manifest, a README and the signed <code>node.exe</code>.</li>
<li>Open PowerShell in that folder and run the one command shown below. Do not change the execution policy.</li>
<li>Type the password when 7-Zip asks, once per archive.</li>
<li>Read the report. Do the by-hand list. Clone the client repositories after you push them.</li></ol>
<pre>.\\node.exe kit\\kit.mjs restore --bundle C:\\move</pre>
<details><summary>If a checksum fails</summary>Download that part again. Never unpack a part that failed its check.</details>
<details><summary>If an app install is refused</summary>The signature did not match the recorded publisher. Install that app from the vendor's own page.</details>${sampleNote}`;

const faq = () => `<details><summary>Is my password stored anywhere?</summary>No. 7-Zip asks for it at its own prompt. The mover never sees, stores or logs it.</details>
<details><summary>Can I use OneDrive?</summary>Accenture OneDrive or Google Drive, yes. Never a client's OneDrive.</details>
<details><summary>What about client repositories?</summary>With a remote: they stay out, you push first and clone again. Without a remote: a separate encrypted client part for Accenture OneDrive only.</details>
<details><summary>Does it change my repositories?</summary>No. It does not push or fetch and reads git without locks.</details>`;
const sSecurity = () => `<h3>Security notes for IT</h3>
<table><tr><th>Question</th><th>Answer</th></tr>
<tr><td>Encryption</td><td>7-Zip AES-256, file names encrypted, password typed by the user, never stored</td></tr>
<tr><td>Integrity</td><td>SHA-256 per part, checked before anything is unpacked</td></tr>
<tr><td>Executables</td><td>Only the official signed portable node.exe and winget. Vendor downloads run only if the Authenticode signature is valid and matches the recorded publisher</td></tr>
<tr><td>Network</td><td>The tool listens on 127.0.0.1 only. No upload by the tool: the user uploads</td></tr>
<tr><td>Secrets</td><td>Never copied, listed for by-hand moving</td></tr>
<tr><td>Client data</td><td>Remote repositories stay out; others go in a separate part for Accenture OneDrive only</td></tr>
<tr><td>Credential stores</td><td>None used (no DPAPI, no Credential Manager, no keytar)</td></tr></table>${sampleNote}`;

const screen = (title, body) => `<section class="screen"><div class="sbar"><span>Laptop mover</span><span>${esc(title)}</span></div><div class="sbody">${body}</div></section>`;

// ---------- the questions block ----------
const Q = [
  ['Which proposal?', ['A, the step-by-step wizard', 'B, the control panel', 'C, the guide-first portal', 'D, the move-day timeline', 'A combination (say which parts in the comment)'], -1],
  ['How does the tool run?', ['A local web page that the mover\'s own node serves on 127.0.0.1 only and opens in the default browser: nothing to install, no unsigned program launched', 'A desktop app (needs code signing by IT)', 'A command-line tool with HTML pages for the instructions only'], 0],
  ['Who is it for?', ['Any Accenture employee moving to a new laptop, so nothing is tied to one user', 'The user only, shown to IT as a demo'], 0],
  ['The tutorials?', ['Step pages with screenshots and SVG diagrams, inside the tool and as a printable HTML guide', 'Screen recordings as well', 'Text only'], 0],
  ['Where does it live for IT?', ['Local for now, a zip for IT when they ask', 'A private GitHub repository under the user\'s account zgyorkeiacn', 'Wherever IT says (an internal repository)'], 0],
  ['The logo?', ['The official logo file, supplied by the user or IT, in the marked slot', 'Colors only, no logo'], 0],
];
const questions = (page) => `<form id="questions" onsubmit="return false" aria-label="Questions">
<h2>Questions</h2><p>Page: <strong>${page}</strong>. Pick one option per question. Every comment box is optional.</p>
${Q.map((q, i) => `<fieldset><legend>${i + 1}. ${q[0]}</legend>${q[1].map((o, j) => `<label class="opt"><input type="radio" name="q${i + 1}" value="${j}"> ${esc(o)}${q[2] === j ? ' <span class="rec">(Recommended)</span>' : ''}</label>`).join('')}<label class="cl" for="qc${i + 1}">Comment on question ${i + 1} (optional)</label><textarea id="qc${i + 1}" name="qc${i + 1}"></textarea></fieldset>`).join('')}
<fieldset><legend>Additional comments</legend><label class="cl" for="extra">Anything else (optional)</label><textarea id="extra" name="extra"></textarea></fieldset>
<button class="btn" id="copy" type="button">Copy answers</button> <button class="btn ghost" id="save" type="button">Save answers</button><span id="status" role="status"></span>
<script>
(function(){
var PAGE=${JSON.stringify(page)};
var Q=${JSON.stringify(Q.map((q) => ({ q: q[0], o: q[1], r: q[2] })))};
function collect(){var a={page:PAGE,answers:[],additionalComments:document.getElementById('extra').value};
Q.forEach(function(q,i){var n=i+1,c=document.querySelector('input[name="q'+n+'"]:checked');
a.answers.push({number:n,question:q.q,answer:c?q.o[+c.value]:null,recommended:q.o[q.r]||null,comment:document.getElementById('qc'+n).value});});return a;}
function text(){var a=collect(),t='Laptop mover UI proposal answers (page '+a.page+')\\n\\n';
a.answers.forEach(function(x){t+=x.number+'. '+x.question+'\\n   Answer: '+(x.answer||'(none)')+'\\n   Comment: '+(x.comment||'(none)')+'\\n';});
return t+'\\nAdditional comments: '+(a.additionalComments||'(none)')+'\\n';}
function say(m){document.getElementById('status').textContent=m;}
document.getElementById('copy').onclick=function(){var t=text();window.__copied=t;
(navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(t):Promise.reject()).then(function(){say('Copied')},function(){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');say('Copied')}catch(e){say('Copy failed, use Save')}ta.remove();});};
document.getElementById('save').onclick=function(){var b=new Blob([JSON.stringify(collect(),null,2)],{type:'application/json'});var u=URL.createObjectURL(b),l=document.createElement('a');l.href=u;l.download='laptop-mover-ui-answers-'+PAGE.split(' ')[0].toLowerCase()+'.json';document.body.appendChild(l);l.click();l.remove();say('Saved');};
})();
</script></form>`;

// small show/hide helper used by A, B, C
const nav = `<script>
(function(){function show(g,id){document.querySelectorAll('[data-g="'+g+'"]').forEach(function(e){e.classList.toggle('hide',e.id!==id)});
document.querySelectorAll('[data-t="'+g+'"]').forEach(function(b){var on=b.getAttribute('data-to')===id;b.setAttribute('aria-current',on?'true':'false');b.classList.toggle('on',on)});}
document.addEventListener('click',function(e){var b=e.target.closest('[data-to]');if(!b)return;show(b.getAttribute('data-t'),b.getAttribute('data-to'));});
document.querySelectorAll('[data-first]').forEach(function(b){show(b.getAttribute('data-t'),b.getAttribute('data-to'))});
document.querySelectorAll('[data-run]').forEach(function(b){b.addEventListener('click',function(){var s=document.getElementById(b.getAttribute('data-run'));if(s)s.textContent='Demo only: this button would run the step here.'})});
})();</script>`;

const head = (t, extraCss) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style>${css}${extraCss}</style></head><body><a class="skip" href="#main">Skip to content</a>`;
const topbar = (label) => `<header style="background:#000;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap"><span class="logo-slot" style="color:#E6DCFF" title="Place the official Accenture logo file here">LOGO SLOT: official Accenture logo file</span><strong style="font-size:18px">Laptop mover</strong><span style="color:#BE82FF">${label}</span><span style="margin-left:auto;font-size:13px;color:#D0D0D0">Local page on 127.0.0.1 (design proposal)</span></header>`;
const note = '<p style="max-width:900px;margin:12px auto;padding:0 16px;font-size:13px;color:var(--g2)">Design proposal: a clickable picture, not the working tool. The logo slot is empty on purpose: the official Accenture logo file goes there.</p>';
const wrapEnd = (page) => `${questions(page)}${nav}</body></html>`;

// ---------- A: wizard ----------
{
  const steps = [
    ['Old laptop', 'Scan', 'a1', sScanSimple(), 'The mover looks at your folders, applications, settings and git repositories. It only reads. This takes about a minute.'],
    ['Old laptop', 'Choose', 'a2', sChoose(), 'Tick what moves. Large folders show their size. Client repositories with a remote stay out; you push them first.'],
    ['Old laptop', 'Dry run', 'a3', sDry() + sByHand(), 'The dry run shows size, parts, time and the route of each app. Read the by-hand list: those files are never moved.'],
    ['Old laptop', 'Pack', 'a4', sPack(), 'Type a password when 7-Zip asks. Write it down somewhere safe, it is not stored. Do not close the window.'],
    ['Old laptop', 'Upload', 'a5', sUpload(), 'Upload the bundle yourself: Accenture OneDrive or Google Drive. The client part goes to Accenture OneDrive only.'],
    ['New laptop', 'Download', 'a6', sInstr(), 'Download every file of the bundle into one folder, then follow the numbered instructions.'],
    ['New laptop', 'Restore', 'a7', sRestore(), 'Leave it running. Apps install one by one, only with a valid signature.'],
    ['New laptop', 'Check', 'a8', sReport(), 'Read the report, finish the by-hand list, clone the client repositories after pushing them.'],
    ['Help', 'Tutorial', 'a9', sTutorial() + sSecurity(), 'The same five steps as a picture, and what IT will want to know.'],
  ];
  const extra = `.wiz{display:grid;grid-template-columns:230px 1fr;max-width:1180px;margin:0 auto;gap:0}
.stepper{list-style:none;margin:0;padding:16px;border-right:1px solid var(--g4)}
.stepper .grp{font-size:12px;font-weight:700;color:var(--g2);text-transform:uppercase;margin:14px 0 4px}
.stepper button{width:100%;text-align:left;background:#fff;border:0;border-left:4px solid var(--g4);padding:8px 10px;font:inherit;cursor:pointer;color:var(--g1)}
.stepper button.on{border-left-color:var(--p);background:var(--pll);font-weight:700;color:var(--pdd)}
.pane{padding:20px}
.inline{border-left:6px solid var(--p);background:var(--pll);padding:12px 16px;margin:0 0 16px}
.wnav{display:flex;justify-content:space-between;margin-top:16px}
@media(max-width:800px){.wiz{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}}`;
  const html = head('Laptop mover UI, proposal A: wizard', extra) + topbar('A: step-by-step wizard') + note + `<main id="main" class="wiz"><nav aria-label="Steps"><ol class="stepper" style="list-style:none">${['Old laptop', 'New laptop', 'Help'].map((g) => `<li class="grp">${g}</li>` + steps.filter((s) => s[0] === g).map((s) => `<li><button type="button" data-t="wz" data-to="${s[2]}" ${s[2] === 'a1' ? 'data-first' : ''}>${s[1]}</button></li>`).join('')).join('')}</ol></nav><div class="pane">${steps.map((s, i) => `<section id="${s[2]}" data-g="wz"><p class="tag pp">${s[0]}, step ${i + 1} of ${steps.length}</p><div class="inline"><strong>How this step works.</strong> ${s[4]}</div>${screen(s[1], s[3])}<div class="wnav">${i ? `<button class="btn ghost" type="button" data-t="wz" data-to="${steps[i - 1][2]}">Back</button>` : '<span></span>'}${i < steps.length - 1 ? `<button class="btn" type="button" data-t="wz" data-to="${steps[i + 1][2]}">Next: ${steps[i + 1][1]}</button>` : ''}</div></section>`).join('')}</div></main>` + wrapEnd('A wizard');
  writeFileSync(join(out, 'a-wizard.html'), html);
}
function sScanSimple() {
  return `<h3>Scanning this laptop</h3>${[['Folders', 100, '61 found'], ['Applications', 100, '48 found'], ['Settings', 80, ''], ['Git repositories', 35, '3 of 9 read']].map((p) => `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><span>${p[0]}</span><span>${p[2]}</span></div><div class="bar" role="progressbar" aria-valuenow="${p[1]}" aria-valuemin="0" aria-valuemax="100" aria-label="${p[0]}"><i style="width:${p[1]}%"></i></div></div>`).join('')}<p>Reading only. Nothing is changed or locked.</p>${sampleNote}`;
}
function sUpload() {
  return `<h3>Upload the bundle yourself</h3><table><tr><th>File</th><th class="num">Size</th><th>Upload to</th></tr>
<tr><td>laptop-move-kit.zip</td><td class="num">42 MB</td><td>Accenture OneDrive or Google Drive</td></tr>
<tr><td>data-1.7z.001 to 003 and checksums</td><td class="num">9.6 GB</td><td>Accenture OneDrive or Google Drive</td></tr>
<tr><td>client-1.7z.001</td><td class="num">0.4 GB</td><td><strong>Accenture OneDrive only</strong></td></tr></table>
<div class="card purple" style="margin-top:12px"><strong>Never</strong> upload to a client's OneDrive. The mover refuses an output folder inside client folders.</div>
<p><button class="btn sm" type="button">Open the bundle folder</button></p>${sampleNote}`;
}

// ---------- B: control panel ----------
{
  const secs = [['b1', 'Applications', `<h3>Applications</h3><table><tr><th>Move</th><th>App</th><th>Route</th></tr>${apps.map((a, i) => `<tr><td><input type="checkbox" ${i < 5 ? 'checked' : ''} aria-label="Move ${esc(a[0])}"></td><td>${esc(a[0])}</td><td>${esc(a[1])}<br><span class="mono">${esc(a[2])}</span></td></tr>`).join('')}</table>${sampleNote}`],
    ['b2', 'Folders', `<h3>Folders</h3><table><tr><th>Move</th><th>Path</th><th class="num">Size</th></tr>${folders.map((f) => `<tr><td><input type="checkbox" ${f[2] ? 'checked' : ''} aria-label="Move ${esc(f[0])}"></td><td class="mono">${esc(f[0])}</td><td class="num">${f[1]}</td></tr>`).join('')}</table>${sampleNote}`],
    ['b3', 'Repositories', `<h3>Repositories</h3><table><tr><th>Move</th><th>Name</th><th>Kind</th><th>What happens</th></tr>${repos.map((r) => `<tr><td><input type="checkbox" ${r[1].startsWith('client') ? '' : 'checked'} aria-label="Move ${esc(r[0])}"></td><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</table>${sampleNote}`],
    ['b4', 'Settings', `<h3>Settings</h3>${settings.map((s) => chk('', s[0], !!s[1])).join('')}${sampleNote}`],
    ['b5', 'Dry run', sDry()], ['b6', 'Progress', sPack() + sRestore()], ['b7', 'Report', sReport()], ['b8', 'By hand', sByHand()], ['b9', 'Tutorial', sTutorial()], ['b10', 'Instructions', sInstr()]];
  const checklist = ['Push client repositories', 'Close big programs', 'Run the dry run', 'Pack and note the password', 'Upload to Accenture OneDrive', 'Move the by-hand files', 'Restore on the new laptop', 'Read the report'];
  const extra = `.cp{display:grid;grid-template-columns:200px 1fr 260px;min-height:70vh}
.side{background:var(--pdd);color:#fff;padding:12px 0}
.side button{display:block;width:100%;text-align:left;background:none;border:0;border-left:4px solid transparent;color:#fff;font:inherit;padding:9px 16px;cursor:pointer}
.side button.on{background:#000;border-left-color:#BE82FF;font-weight:700}
.main{padding:20px}
.check{border-left:1px solid var(--g4);padding:16px;background:var(--g5)}
.drawer{position:fixed;top:0;right:0;width:340px;height:100%;background:#fff;border-left:6px solid var(--p);padding:20px;overflow:auto;box-shadow:-4px 0 12px rgba(0,0,0,.3);z-index:5}
.mini{display:flex;gap:12px;margin:0 0 16px;flex-wrap:wrap}.mini div{flex:1;min-width:110px;border:1px solid var(--g4);padding:8px}.mini b{display:block;font-size:20px;color:var(--pdd)}
@media(max-width:1000px){.cp{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}}`;
  const html = head('Laptop mover UI, proposal B: control panel', extra) + topbar('B: control panel') + note + `<main id="main" class="cp"><nav class="side" aria-label="Sections">${secs.map((s) => `<button type="button" data-t="cp" data-to="${s[0]}" ${s[0] === 'b1' ? 'data-first' : ''}>${s[1]}</button>`).join('')}</nav>
<div class="main"><div class="mini"><div>Selected<b>9.6 GB</b></div><div>Parts<b>3 + client</b></div><div>Pack time<b>~18 min</b></div><div>Warnings<b>1</b></div></div>
<p><button class="btn ghost" type="button" aria-expanded="false" id="hbtn" aria-controls="drawer">Help</button></p>${secs.map((s) => `<div id="${s[0]}" data-g="cp">${screen(s[1], s[2])}</div>`).join('')}</div>
<aside class="check" aria-label="Move checklist"><h3>Move checklist</h3>${checklist.map((c, i) => chk('', c, i < 2)).join('')}<p class="sample">2 of 8 done</p></aside></main>
<div class="drawer hide" id="drawer" role="dialog" aria-label="Help"><button class="btn sm ghost" type="button" id="hclose" style="float:right">Close</button><h3>Help</h3><p>Context help for the section you are in.</p>${faq()}<p><a href="#questions">Jump to the questions</a></p></div>
<script>(function(){var d=document.getElementById('drawer'),b=document.getElementById('hbtn');b.onclick=function(){d.classList.remove('hide');b.setAttribute('aria-expanded','true');document.getElementById('hclose').focus()};document.getElementById('hclose').onclick=function(){d.classList.add('hide');b.setAttribute('aria-expanded','false');b.focus()};document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!d.classList.contains('hide'))document.getElementById('hclose').click()})})();</script>` + wrapEnd('B control panel');
  writeFileSync(join(out, 'b-control-panel.html'), html);
}

// ---------- C: guide-first portal ----------
{
  const pages = [
    ['c1', 'Start here', `<h2>Move to a new laptop</h2><p>Four parts, in order. Each has a guide and a button that runs the step in the tool.</p>
<div class="grid2">${[['1 Scan and choose', 'c4'], ['2 Dry run and pack', 'c5'], ['3 Upload and download', 'c2'], ['4 Restore and check', 'c6']].map((c) => `<div class="card purple"><h3>${c[0]}</h3><button class="btn sm" type="button" data-t="cg" data-to="${c[1]}">Open</button></div>`).join('')}</div>`],
    ['c2', 'Tutorials', screen('Tutorial', sTutorial())],
    ['c3', 'Detailed instructions', screen('Instructions', sInstr())],
    ['c4', 'Choose what moves', `<p class="inline">Guide: tick folders, applications, repositories and settings. <button class="btn sm" type="button" data-run="r4">Run this step</button> <span id="r4" role="status"></span></p>${screen('Choose', sChoose())}`],
    ['c5', 'Dry run and packing', `<p class="inline">Guide: read the dry run, then pack. <button class="btn sm" type="button" data-run="r5">Run this step</button> <span id="r5" role="status"></span></p>${screen('Dry run', sDry())}${screen('Packing', sPack())}`],
    ['c6', 'Restore and report', `<p class="inline">Guide: restore on the new laptop. <button class="btn sm" type="button" data-run="r6">Run this step</button> <span id="r6" role="status"></span></p>${screen('Restore', sRestore())}${screen('Report', sReport())}`],
    ['c7', 'By-hand list', screen('By hand', sByHand())],
    ['c8', 'FAQ', `<h2>FAQ</h2>${faq()}`],
    ['c9', 'Security for IT', `<h2>Security for IT</h2>${screen('Security', sSecurity())}<p><button class="btn ghost sm" type="button">Print this page for IT</button></p>`],
  ];
  const extra = `.por{display:grid;grid-template-columns:250px 1fr;max-width:1180px;margin:0 auto}
.toc{border-right:1px solid var(--g4);padding:16px}
.toc button{display:block;width:100%;text-align:left;background:#fff;border:0;border-bottom:1px solid var(--g4);padding:9px 6px;font:inherit;cursor:pointer;color:var(--pdd)}
.toc button.on{font-weight:700;background:var(--pll);border-left:4px solid var(--p)}
.art{padding:24px;max-width:860px}
.inline{border-left:6px solid var(--p);background:var(--pll);padding:12px 16px}
.hero{background:linear-gradient(135deg,#460073,#000);color:#fff;padding:28px 24px}.hero h1{margin:0 0 6px}.hero p{margin:0;color:#E6DCFF}
@media(max-width:800px){.por{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}}`;
  const html = head('Laptop mover UI, proposal C: guide portal', extra) + topbar('C: guide-first portal') + `<div class="hero"><h1>Moving to a new laptop, the guided way</h1><p>Tutorials, instructions, FAQ and security notes first. The tool's screens are the pages.</p></div>` + note + `<div class="por"><nav class="toc" aria-label="Guide">${pages.map((p) => `<button type="button" data-t="cg" data-to="${p[0]}" ${p[0] === 'c1' ? 'data-first' : ''}>${p[1]}</button>`).join('')}</nav><main id="main" class="art">${pages.map((p) => `<article id="${p[0]}" data-g="cg">${p[2]}</article>`).join('')}</main></div>` + wrapEnd('C guide portal');
  writeFileSync(join(out, 'c-guide-portal.html'), html);
}

// ---------- D: timeline ----------
{
  const diag = (a, b, c) => `<svg viewBox="0 0 420 90" width="100%" role="img" aria-label="${a} to ${b} to ${c}"><rect x="6" y="20" width="110" height="50" fill="#A100FF"/><text x="61" y="50" fill="#fff" font-family="Arial" font-size="14" font-weight="700" text-anchor="middle">${a}</text><path d="M120 45h60" stroke="#000" stroke-width="2" stroke-dasharray="5 4"/><path d="M174 38l8 7-8 7" fill="none" stroke="#000" stroke-width="2"/><rect x="186" y="20" width="110" height="50" fill="#fff" stroke="#000" stroke-width="2"/><text x="241" y="50" font-family="Arial" font-size="14" font-weight="700" text-anchor="middle">${b}</text><path d="M300 45h60" stroke="#000" stroke-width="2" stroke-dasharray="5 4"/><rect x="304" y="20" width="0" height="0"/><rect x="364" y="20" width="52" height="50" fill="#460073"/><text x="390" y="50" fill="#fff" font-family="Arial" font-size="12" font-weight="700" text-anchor="middle">${c}</text></svg>`;
  const phases = [
    ['Before', 'The day before', `<p>Prepare. Push client repositories, close big programs, find a place to write the password.</p><ul><li>Push every client repository: the dry run lists what is not pushed.</li><li>Check free disk space for the bundle.</li><li>Decide where you will upload: Accenture OneDrive or Google Drive.</li></ul>${diag('Repos', 'Remote', 'Push')}<p><button class="btn sm" type="button">Check unpushed work</button></p>`],
    ['Old laptop', 'Scan, choose, pack', `${sChoose()}${sDry()}${sPack()}`],
    ['In transit', 'Upload and wait', `<p>The bundle moves through the cloud. You do the upload; the tool does not.</p>${diag('Old laptop', 'Cloud drive', 'New')}${sUpload()}${sByHand()}`],
    ['New laptop', 'Download and restore', `${sInstr()}${sRestore()}`],
    ['After', 'Check and finish', `${sReport()}${sTutorial()}${sSecurity()}`],
  ];
  const extra = `.tl{max-width:1000px;margin:0 auto;padding:16px;position:relative}
.tl:before{content:"";position:absolute;left:34px;top:24px;bottom:24px;width:4px;background:var(--p)}
.ph{position:relative;margin:0 0 20px 70px;border:1px solid var(--g4);background:#fff}
.ph>button{display:flex;width:100%;align-items:center;gap:12px;background:var(--pll);border:0;padding:14px 16px;font:inherit;text-align:left;cursor:pointer}
.ph>button b{font-size:18px;color:var(--pdd)}
.ph .dot{position:absolute;left:-46px;top:12px;width:32px;height:32px;border-radius:50%;background:#fff;border:4px solid var(--p);color:var(--pdd);font-weight:700;text-align:center;line-height:24px}
.ph .body{padding:16px}
@media(max-width:800px){.grid2{grid-template-columns:1fr}}`;
  const html = head('Laptop mover UI, proposal D: move-day timeline', extra) + topbar('D: timeline of the move day') + note + `<main id="main" class="tl"><p style="margin-left:70px"><button class="btn ghost sm" type="button" id="allop">Open all phases</button> <button class="btn ghost sm" type="button" id="allcl">Close all</button></p>${phases.map((p, i) => `<section class="ph"><span class="dot" aria-hidden="true">${i + 1}</span><button type="button" aria-expanded="${i === 1}" aria-controls="d${i}"><b>${p[0]}</b><span>${p[1]}</span></button><div class="body ${i === 1 ? '' : 'hide'}" id="d${i}">${p[2]}</div></section>`).join('')}</main>
<script>(function(){var bs=document.querySelectorAll('.ph>button');bs.forEach(function(b){b.onclick=function(){var d=document.getElementById(b.getAttribute('aria-controls')),h=d.classList.toggle('hide');b.setAttribute('aria-expanded',String(!h))}});function all(o){bs.forEach(function(b){document.getElementById(b.getAttribute('aria-controls')).classList.toggle('hide',!o);b.setAttribute('aria-expanded',String(o))})}document.getElementById('allop').onclick=function(){all(true)};document.getElementById('allcl').onclick=function(){all(false)};})();</script>` + wrapEnd('D timeline');
  writeFileSync(join(out, 'd-timeline.html'), html);
}
console.log('written to', out);
