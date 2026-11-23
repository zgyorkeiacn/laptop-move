// Builds data/inventory.json and data/select.html from the other data/*.json files. Read-only on the machine.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const rj = (n, d = null) => { try { return JSON.parse(readFileSync(join(dataDir, n), 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const mb = (n) => Math.round((n ?? 0) / 1048576);
const repos = rj('repos.json', []);
const repoByPath = new Map(repos.map((r) => [r.path.toLowerCase(), r]));
const secretPaths = rj('secret-paths.json', []);

// ---------- folders ----------
const folders = [];
const NOT_WORTH = /(@|^wt-|^aao-wt|^aao-exp|^_wt|^_export|^\.temp|^\.wt|-wt-|-export|-gate-|^_lint|^_vercel)/i;
// Client-specific values are kept outside the repository, in the client rules file (never committed).
const clientRules = await (async () => { try { const { readFileSync } = await import('node:fs'); const { join } = await import('node:path'); return JSON.parse(readFileSync(join(process.env.APPDATA ?? '', 'AIxOrchestrator', 'reports', 'laptop-move-client.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
const clientGitRoots = Array.isArray(clientRules.extraGitRoots) ? clientRules.extraGitRoots : [];
const clientOneDrive = Array.isArray(clientRules.clientOneDrive) ? clientRules.clientOneDrive : [];
const gitRoots = ['git_accenture', 'git_personal', ...clientGitRoots, 'newgit', 'newnewgit', 'Git', 'work', 'flutter'];
for (const root of gitRoots) {
  const w = rj(`walk-${root}.json`);
  if (!w) continue;
  for (const c of w.children) {
    if (c.type === 'junction') continue;
    const full = join(w.root, c.name);
    const repo = repoByPath.get(full.toLowerCase());
    const sizeMB = mb(c.size);
    const common = { group: `C:\\${root}`, path: full, sizeMB, files: c.files ?? 0, nodeModulesMB: mb(c.nmSize), cachesMB: mb(c.cacheSize) };
    if (repo) {
      const bits = [];
      if (!repo.hasRemote) bits.push('NO REMOTE: copy whole');
      if (repo.unpushed) bits.push(`${repo.unpushed} unpushed commit(s): bundle`);
      if (repo.noUpstreamBranches) bits.push(`${repo.noUpstreamBranches} local branch(es) without upstream: bundle`);
      if (repo.dirty) bits.push(`${repo.dirty} uncommitted file(s): copy`);
      if (repo.stashes) bits.push(`${repo.stashes} stash(es): bundle refs/stash`);
      if (repo.worktrees) bits.push(`${repo.worktrees} linked worktree(s)`);
      const whole = !repo.hasRemote;
      folders.push({ ...common, id: 'f' + folders.length, kind: whole ? 'local-only' : 'fetchable', mode: whole ? 'copy whole' : 'clone again' + (bits.length ? ' + bundle/dirty' : ''), how: bits.join('; ') || 'clean and pushed: clone again', packMB: whole ? sizeMB : 1, rec: true, origin: repo.origin });
    } else if (NOT_WORTH.test(c.name)) {
      folders.push({ ...common, id: 'f' + folders.length, kind: 'not-worth', mode: 'skip', how: 'git worktree, export, gate copy or temp folder: recreate on demand; check its uncommitted files first', packMB: 0, rec: false });
    } else if (c.kids) {
      continue;
    } else {
      const profile = /profile|browser/i.test(c.name);
      folders.push({ ...common, id: 'f' + folders.length, kind: profile ? 'secret-bearing' : 'local-only', mode: profile ? 'by hand' : 'copy whole', how: profile ? 'browser profile: sign in again, never copy' : 'not a repository: copy whole', packMB: profile ? 0 : sizeMB, rec: !profile });
    }
  }
}
// repositories nested deeper than one level (found by the walk but not top-level children)
for (const r of repos) {
  const known = folders.some((f) => f.path.toLowerCase() === r.path.toLowerCase());
  const inside = folders.some((f) => r.path.toLowerCase().startsWith(f.path.toLowerCase() + '\\') && repoByPath.has(f.path.toLowerCase()));
  if (known || inside || /\\\.temp\\/.test(r.path)) continue;
  const whole = !r.hasRemote;
  folders.push({ group: 'nested repositories', id: 'f' + folders.length, path: r.path, sizeMB: 0, files: 0, nodeModulesMB: 0, cachesMB: 0, kind: whole ? 'local-only' : 'fetchable', mode: whole ? 'copy whole' : 'clone again', how: whole ? 'NO REMOTE: copy whole' : 'nested repository', packMB: whole ? 50 : 1, rec: true, origin: r.origin });
}

// user folder and AppData
const user = rj('walk-user.json');
const userRec = { Desktop: true, Documents: true, Downloads: false, Pictures: true, Music: false, Videos: false, Dev: true, Microsoft: false, '.claude': true, '.config': true, '.copilot': true, '.gemini': true, '.antigravity': false, '.karate': true, '.redocly': true, '.lemminx': false, '.redhat': false, '.dotnet': false, '.ms-ad': false, '.local': false, '.android': false, '.gradle': false, '.m2': false, '.jdks': false, node_modules: false, Postman: true, '.temp': false, '.scratch-notify': false, '.thumbnails': false };
const userHow = { '.android': 'Android SDK and emulator images: download again (Android Studio)', '.gradle': 'Gradle cache: downloaded again by the build', '.m2': 'Maven repository cache: downloaded again; settings.xml by hand (secret-bearing)', '.jdks': 'JDKs: install from winget or the IDE', node_modules: 'a stray node_modules in the user folder: npm install again', '.claude': 'Claude Code: settings, agents, skills link, transcripts (6 GB, mostly projects); credentials dir by hand', '.antigravity': 'editor extensions: reinstall', '.gemini': 'Gemini CLI and Antigravity data; mcp_config is a link', Downloads: 'installers and files: pick by hand', Microsoft: 'misc', Postman: 'collections: Postman cloud sync or export' };
if (user) {
  for (const c of user.children) {
    if (c.type !== 'dir') continue;
    if (/^(AppData|OneDrive|Application Data|Local Settings|My Documents|NetHood|PrintHood|Recent|SendTo|Start Menu|Templates|Cookies)/.test(c.name)) continue;
    if (!(c.name in userRec) && c.size < 5 * 1048576) continue;
    const fetch = ['.android', '.gradle', '.m2', '.jdks', 'node_modules', '.antigravity'].includes(c.name);
    const scratch = /^(skb-|relay-|scratch|aao-fix|skbtmp|amazon-group|baby-cleanup|shopcart)/.test(c.name);
    folders.push({ group: 'user folder', id: 'f' + folders.length, path: join(user.root, c.name), sizeMB: mb(c.size), files: c.files, nodeModulesMB: mb(c.nmSize), cachesMB: mb(c.cacheSize), kind: fetch ? 'fetchable' : scratch ? 'not-worth' : 'local-only', mode: fetch || scratch ? 'skip' : 'copy whole', how: userHow[c.name] ?? (scratch ? 'scratch or screenshot folder from past work: skip unless needed' : 'local only'), packMB: fetch || scratch ? 0 : mb(c.size), rec: !!userRec[c.name] && !fetch });
  }
  folders.push({ group: 'user folder', id: 'f' + folders.length, path: user.root + '\\ (loose files and .gitconfig)', sizeMB: mb(user.looseFiles.size), files: user.looseFiles.files, nodeModulesMB: 0, cachesMB: 0, kind: 'local-only', mode: 'copy whole', how: 'loose files in the user folder', packMB: mb(user.looseFiles.size), rec: true });
}
const ar = rj('walk-appdata-Roaming.json');
const appRec = new Set(['AIxOrchestrator', 'Code', 'Cursor', 'BrickBudget', 'Brick Tracker', 'blok-ai', 'SmakMal', 'lego-tracker-desktop', 'copilot-ado-figma-gherkin-agent', 'Automation Agent', 'Postman']);
const appFetch = new Set(['Cypress', 'npm', 'Electron', 'com.adobe.dunamis', 'discord', 'Google', 'Microsoft', 'Antigravity', 'JetBrains']);
if (ar) for (const c of ar.children) {
  if (c.type !== 'dir') continue;
  if (c.size < 8 * 1048576 && !appRec.has(c.name)) continue;
  if (/^AI /.test(c.name) || c.name === '@ae-tdg') continue;
  const fetch = appFetch.has(c.name);
  folders.push({ group: 'AppData\\Roaming', id: 'f' + folders.length, path: join(ar.root, c.name), sizeMB: mb(c.size), files: c.files, nodeModulesMB: mb(c.nmSize), cachesMB: mb(c.cacheSize), kind: fetch ? 'fetchable' : 'local-only', mode: fetch ? 'skip' : 'copy whole', how: fetch ? 'app data that the app rebuilds or syncs after sign-in' : 'an app keeps its own data here: copy with the app closed', packMB: fetch ? 0 : mb(c.size), rec: appRec.has(c.name) });
}
const synced = ['C:\\Users\\zoltan.gyorkei\\OneDrive - Accenture', ...clientOneDrive, 'C:\\Users\\zoltan.gyorkei\\OneDrive'];
for (const p of synced) folders.push({ group: 'synced by OneDrive', id: 'f' + folders.length, path: p, sizeMB: 0, files: 0, nodeModulesMB: 0, cachesMB: 0, kind: 'synced', mode: 'sync', how: 'syncs by itself after sign-in: never copied, never written to', packMB: 0, rec: false, locked: true });

// ---------- applications ----------
const wg = rj('winget-export.json');
const wgIds = wg ? wg.Sources.flatMap((s) => s.Packages.map((p) => p.PackageIdentifier)) : [];
const LIB = /^(Microsoft\.(UI\.Xaml|VCLibs|WindowsAppRuntime|VCRedist|DotNet\.Native|AppInstaller|LAPS|DotNet\.DesktopRuntime)|Nvidia\.PhysX|Python\.(Launcher|PythonInstallManager))/;
const nice = { '7zip.7zip': ['7-Zip (26.03 or newer only)', true], 'Anysphere.Cursor': ['Cursor', true], 'DenoLand.Deno': ['Deno', false], 'Ghisler.TotalCommander': ['Total Commander', false], 'GitHub.cli': ['GitHub CLI (gh)', true], 'Google.AntigravityIDE': ['Antigravity IDE', false], 'Google.Chrome': ['Google Chrome', true], 'Microsoft.365Copilot': ['Microsoft 365 Copilot', false], 'Microsoft.Edge': ['Microsoft Edge', true], 'Microsoft.Office': ['Microsoft 365 Apps', true], 'Microsoft.OneDrive': ['OneDrive', true], 'Microsoft.Outlook': ['Outlook', false], 'Microsoft.PowerShell': ['PowerShell 7', true], 'Microsoft.Teams': ['Microsoft Teams', true], 'Microsoft.Teams.Classic': ['Teams Classic', false], 'Microsoft.VisualStudio.2022.BuildTools': ['Visual Studio Build Tools 2022', false], 'Microsoft.VisualStudioCode': ['Visual Studio Code', true], 'Microsoft.WindowsTerminal': ['Windows Terminal', true], 'Notepad++.Notepad++': ['Notepad++', true], 'OpenJS.NodeJS.24': ['Node.js 24', true], 'Python.Python.3.14': ['Python 3.14', true], 'yt-dlp.FFmpeg': ['FFmpeg (for yt-dlp)', false], 'yt-dlp.yt-dlp': ['yt-dlp', false] };
const apps = [];
const version = (id) => { const p = wg?.Sources.flatMap((s) => s.Packages).find((x) => x.PackageIdentifier === id); return p?.Version ?? ''; };
for (const id of wgIds) {
  if (LIB.test(id)) continue;
  const [name, rec] = nice[id] ?? [id, false];
  const managed = /^Microsoft\.(Office|Teams|Outlook|Edge|OneDrive|365Copilot)/.test(id);
  apps.push({ id: 'a' + apps.length, name, version: version(id), source: 'winget', wingetId: id, page: '', rec: rec && !managed, note: managed ? 'usually pre-installed or pushed by the company on a managed laptop: check first' : '' });
}
const more = [
  ['Git for Windows (and Git Credential Manager)', '2.50.1', 'winget', 'Git.Git', '', true, 'git is installed here but not from winget; the Credential Manager ships with it and signs in again'],
  ['Node.js 22 (the repositories pin 22.22.0)', '22.22.0', 'winget', 'OpenJS.NodeJS.22', '', true, 'two repositories pin 22.22.0 in .nvmrc and Volta; Node 24 is the machine default'],
  ['pnpm (packageManager pnpm@10.33.0 in two repositories)', '10.33.0', 'winget', 'pnpm.pnpm', '', false, 'or npm install -g pnpm after Node; unverified id'],
  ['Playwright browsers', 'Playwright 1.64.1 pinned in most repositories', 'npx', '', 'https://playwright.dev/docs/browsers', true, 'run npx playwright install in a repository after npm install; about 25 cached browser builds here are from older versions and need not move'],
  ['Eclipse Temurin JDK 17', '17.0.17', 'winget', 'EclipseAdoptium.Temurin.17.JDK', '', true, 'Maven projects (about 38 repositories have a pom.xml); five JDKs sit in the user folder .jdks'],
  ['Amazon Corretto JDK 11', '11.0.22', 'winget', 'Amazon.Corretto.11.JDK', '', false, 'only if an old project needs it'],
  ['Apache Maven', '', 'download', '', 'https://maven.apache.org/download.cgi', true, 'not on PATH here (a wrapper or an IDE may supply it: unverified); settings.xml is secret-bearing, by hand'],
  ['Python 3.14', '3.14.3', 'winget', 'Python.Python.3.14', '', true, 'two repositories use it'],
  ['.NET SDK 9', '9.0.x', 'winget', 'Microsoft.DotNet.SDK.9', '', false, 'dotnet 9 is installed; no repository here has a .csproj or .sln'],
  ['Android Studio', '2024.2', 'winget', 'Google.AndroidStudio', '', false, 'Android SDK in the user folder is 10 GB and downloads again'],
  ['IntelliJ IDEA Community', '2023.2', 'winget', 'JetBrains.IntelliJIDEA.Community', '', true, 'settings through Settings Sync inside the IDE, or copy the config folder'],
  ['Claude Code (global npm package)', '2.1.294', 'npm', '', 'npm install -g @anthropic-ai/claude-code', true, 'sign in again on the new laptop'],
  ['CLI for Microsoft 365 (global npm package)', '12.0.0', 'npm', '', 'npm install -g @pnp/cli-microsoft365', false, ''],
  ['Postman', '10.24.26', 'winget', 'Postman.Postman', '', true, 'collections sync through the Postman account'],
  ['Discord', '', 'winget', 'Discord.Discord', '', false, ''],
  ['Blender (portable, used by the brick art tool)', '4.5.15', 'download', '', 'https://www.blender.org/download/lts/', false, 'portable copy sits in AppData\\Local\\BrickBudgetArt: copy the folder instead'],
  ['Citrix Workspace', '2511', 'company', '', '', false, 'company software: use the Company Portal or the IT-provided installer'],
  ['PSI Bridge Secure Browser', '10.3.0', 'company', '', '', false, 'company or client provided'],
];
for (const m of more) apps.push({ id: 'a' + apps.length, name: m[0], version: m[1], source: m[2], wingetId: m[3], page: m[4], rec: m[5], note: m[6] });
const companyManaged = ['BeyondTrust Privilege Management', 'Citrix Workspace and plug-ins', 'Digital Guardian Agent', 'Forcepoint One Endpoint', 'Tanium Client', 'Nexthink Collector', 'Microsoft Intune Management Extension', 'Configuration Manager Client', 'Microsoft Purview Information Protection', 'deviceTRUST', 'Pharos Print Scout', 'Protect myTech', 'ACN Hello for Business Utility', 'Local Administrator Password Solution'];
for (const n of companyManaged) apps.push({ id: 'a' + apps.length, name: n, version: '', source: 'company', wingetId: '', page: '', rec: false, locked: true, note: 'company managed: expect it on the new laptop, do not install it yourself' });
// own apps built here
for (const n of ['M, the AI Agent Orchestrator', 'Skuggbyrån (SKB desktop app)', 'BrickBudget', 'Brick Tracker', 'BLOK.AI', 'SmakMal']) apps.push({ id: 'a' + apps.length, name: n, version: '', source: 'own', wingetId: '', page: '', rec: true, note: 'built from the repositories in git_accenture and git_personal: build or reinstall from the repository after cloning (a signed installer, if any, comes from its build)' });

// ---------- settings ----------
const settings = [
  { id: 's0', app: 'VS Code', what: 'settings.json, keybindings.json, snippets, extension list (15 extensions, data/vscode-extensions.txt)', how: 'copy %APPDATA%\\Code\\User (without globalStorage and workspaceStorage) and run code --install-extension for each id, or use the editor\'s Settings Sync after sign-in', rec: true },
  { id: 's1', app: 'Cursor', what: 'settings.json, keybindings.json, snippets, extension list (2 extensions)', how: 'copy %APPDATA%\\Cursor\\User and reinstall extensions with cursor --install-extension; sign in again', rec: true },
  { id: 's2', app: 'Windows Terminal', what: 'settings.json', how: 'copy LocalState\\settings.json from the Packages\\Microsoft.WindowsTerminal_* folder', rec: true },
  { id: 's3', app: 'Git', what: '.gitconfig (name, email, aliases, credential helper line)', how: 'copy the file; credentials are re-entered through the Credential Manager sign-in, never copied', rec: true },
  { id: 's4', app: 'PowerShell', what: 'profile files (none exist here for the current user)', how: 'nothing to carry', rec: false },
  { id: 's5', app: 'Claude Code', what: 'settings.json, CLAUDE.md, agents, plugins, skills link target, projects transcripts (6 GB)', how: 'copy with 7-Zip; recreate the skills junction to its target repository; the credentials folder and .credentials.json stay behind: sign in again', rec: true },
  { id: 's6', app: 'M, the orchestrator (AppData\\Roaming\\AIxOrchestrator)', what: 'items, ideas, history, settings, reports', how: 'copy the folder with the app closed; the file named token is secret-bearing and is not copied: the new broker makes its own', rec: true },
  { id: 's7', app: 'SKB desktop app and other own apps', what: 'their folders under AppData\\Roaming', how: 'copy with the app closed; keys stored by the app are bound to this Windows account and must be entered again', rec: true },
  { id: 's8', app: 'Edge and Chrome', what: 'bookmarks, saved passwords, extensions', how: 'sign in to the browser account and let it sync; never copy the profile (Login Data, Cookies and Local State are bound to this machine)', rec: true },
  { id: 's9', app: 'Windows', what: 'wallpaper, taskbar, regional settings, installed fonts', how: 'Windows backup through the Microsoft account may be blocked on a managed laptop; set by hand', rec: false },
  { id: 's10', app: 'Postman', what: 'collections and environments', how: 'sign in to the Postman account; or export collections (environments can hold secrets)', rec: true },
  { id: 's11', app: 'npm and Maven', what: '.npmrc, .m2\\settings.xml', how: 'secret-bearing: create again with a new token or copy by hand yourself', rec: false },
];

// ---------- questions ----------
const questions = [
  { id: 'q1', text: 'Which way moves the data between the laptops?', options: [['Direct network copy, both laptops on the same network, robocopy to a share on the new laptop', true], ['External drive, encrypted, if the company allows it', false], ['A network share on the company network', false], ['Accenture OneDrive for the small parts only', false]], why: 'Digital Guardian and Forcepoint agents are installed here, so writes to removable media may be blocked or logged (inferred, not verified): test with one small file first.' },
  { id: 'q2', text: 'Is the new laptop company managed with the same policies as this one?', options: [['Yes, same company image', true], ['Yes, but a different company or client image', false], ['No, a personal or freshly installed laptop', false]], why: 'It decides whether winget, admin rights and the company software catalogue are available.' },
  { id: 'q3', text: 'Repositories: how do they move?', options: [['Clone again, plus a git bundle of unpushed commits and a copy of uncommitted files; copy whole only where there is no remote', true], ['Copy every repository whole, with its .git', false]], why: 'The first moves about 1 percent of the bytes and drops node_modules and caches; the second is simpler but copies about 25 GB of regenerable data.' },
  { id: 'q4', text: 'Client repositories: move them to the new laptop as well?', options: [['Yes, if the new laptop is client approved', true], ['No, clone them later when needed', false]], why: 'Client code on a laptop follows the client\'s rules.' },
  { id: 'q5', text: 'VS Code and Cursor settings: which route?', options: [['Copy the User folder and reinstall extensions from the list', true], ['The editors\' own Settings Sync', false]], why: 'Settings Sync needs a sign-in the company policy may not allow.' },
  { id: 'q6', text: 'Claude Code transcripts (6 GB under .claude\\projects): carry them?', options: [['Yes, as a compressed archive', true], ['No, leave them on the old laptop', false]], why: 'Transcripts compress well; they let you search past work on the new laptop.' },
  { id: 'q7', text: 'How long stays the old laptop usable after the move?', options: [['At least two weeks', true], ['Handed back at once', false]], why: 'Secrets and anything forgotten are moved by hand from it.' },
];

const inventory = { generatedAt: new Date().toISOString(), machine: 'this laptop', folders, apps, settings, questions, secretFiles: secretPaths };
writeFileSync(join(dataDir, 'inventory.json'), JSON.stringify(inventory, null, 1));

// ---------- the form ----------
const css = 'body{font:14px/1.45 Segoe UI,Arial,sans-serif;max-width:1150px;margin:20px auto;padding:0 14px;background:#f6f7f9;color:#1d2330}h1{font-size:22px}h2{margin-top:26px;border-bottom:2px solid #d5d9e0;padding-bottom:3px}h3{margin:14px 0 4px;font-size:15px}table{border-collapse:collapse;width:100%;background:#fff;font-size:12.5px}td,th{border:1px solid #d5d9e0;padding:3px 6px;text-align:left;vertical-align:top}th{background:#e8ebf1}textarea{width:100%;box-sizing:border-box;min-height:44px;margin:4px 0 8px;font:inherit}.k-local-only{background:#e3f6e5}.k-fetchable{background:#eef3fb}.k-not-worth{background:#f1f1f1;color:#555}.k-secret-bearing,.k-synced{background:#fff4d6}.bar{position:sticky;top:0;background:#1d2330;color:#fff;padding:8px 12px;z-index:5;display:flex;gap:12px;align-items:center}.bar button{padding:5px 12px;cursor:pointer}.rec{color:#17692a;font-weight:700}.small{color:#555;font-size:12px}details{background:#fff;border:1px solid #d5d9e0;padding:6px 10px;margin:8px 0}.q{background:#fff;border-left:5px solid #2b6cb0;padding:6px 12px;margin:10px 0}';
const js = `
const INV=__INV__;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el=id=>document.getElementById(id);
function rows(list,cols,cls){return list.map(x=>'<tr class="'+(cls?cls(x):'')+'"><td>'+(x.locked?'':'<input type="checkbox" data-id="'+x.id+'"'+(x.rec?' checked':'')+'>')+'</td>'+cols(x).map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')}
function foldersHtml(){const groups={};INV.folders.forEach(f=>(groups[f.group]=groups[f.group]||[]).push(f));let h='';for(const g of Object.keys(groups)){h+='<details'+(g.startsWith('C:')&&g!=='C:\\\\git_accenture'?'':' open')+'><summary><b>'+esc(g)+'</b> ('+groups[g].length+')</summary><table><tr><th></th><th>Path</th><th>Size MB</th><th>Files</th><th>Kind</th><th>Move how</th><th>Node modules / caches MB (not moved)</th></tr>'+rows(groups[g],f=>[esc(f.path),f.sizeMB,f.files,esc(f.kind),esc(f.mode)+'<br><span class="small">'+esc(f.how)+'</span>',f.nodeModulesMB+' / '+f.cachesMB],f=>'k-'+f.kind)+'</table></details>'}return h}
function appsHtml(){return '<table><tr><th></th><th>Name</th><th>Version</th><th>Source</th><th>winget id or page</th><th>Note</th></tr>'+rows(INV.apps,a=>[esc(a.name),esc(a.version),esc(a.source),esc(a.wingetId||a.page),esc(a.note)],a=>a.source==='company'?'k-synced':'')+'</table>'}
function settingsHtml(){return '<table><tr><th></th><th>App</th><th>What</th><th>How</th></tr>'+rows(INV.settings,s=>[esc(s.app),esc(s.what),esc(s.how)])+'</table>'}
function secretsHtml(){const g={};INV.secretFiles.forEach(p=>{const n=p.split('\\\\').pop();const k=/^\\.env/.test(n)?'.env files':/\\.npmrc$/.test(n)?'.npmrc':/credentials/i.test(n)||/\\.credentials/.test(n)?'credentials files':/settings\\.xml$/.test(n)?'Maven settings.xml':/accounts|pat-status/.test(n)?'git-manager account files':/\\.(pem|pfx|p12|key|ppk)$/i.test(n)?'certificates and keys':n.startsWith('client_secret')?'client_secret files':'other ('+n+')';(g[k]=g[k]||[]).push(p)});return Object.keys(g).sort().map(k=>'<details><summary><b>'+esc(k)+'</b>: '+g[k].length+' path(s), listed by path only</summary><div class="small">'+g[k].map(esc).join('<br>')+'</div></details>').join('')}
function qHtml(){return INV.questions.map((q,i)=>'<div class="q"><b>'+(i+1)+'. '+esc(q.text)+'</b><br>'+q.options.map((o,j)=>'<label><input type="radio" name="'+q.id+'" value="'+j+'"'+(o[1]?' checked':'')+'> '+esc(o[0])+(o[1]?' <span class="rec">(Recommended)</span>':'')+'</label><br>').join('')+'<span class="small">'+esc(q.why)+'</span><textarea data-c="'+q.id+'" placeholder="Comment (optional)"></textarea></div>').join('')}
function section(id,title,html){return '<h2>'+title+'</h2>'+html+'<textarea data-c="'+id+'" placeholder="Comment on this section (optional)"></textarea>'}
document.body.insertAdjacentHTML('beforeend',
 section('folders','1. Folders and repositories',foldersHtml())+
 section('apps','2. Applications',appsHtml())+
 section('settings','3. Settings that can travel',settingsHtml())+
 '<h2>4. Secret-bearing files: move by hand</h2><p>Never ticked, never packed. Sign in again, make a new token, or copy them yourself.</p>'+secretsHtml()+'<textarea data-c="secrets" placeholder="Comment on the secret-bearing files (optional)"></textarea>'+
 '<h2>5. Questions</h2>'+qHtml()+
 '<h2>Additional comments</h2><textarea data-c="additional" placeholder="Anything else (optional)"></textarea>');
function total(){let t=0;document.querySelectorAll('input[data-id^=f]:checked').forEach(c=>{const f=INV.folders.find(x=>x.id===c.dataset.id);t+=f?.packMB||0});el('tot').textContent=(t/1024).toFixed(1)+' GB to pack (recommended way)'}
function collect(){const out={savedAt:new Date().toISOString(),folders:[],applications:[],settings:[],questions:[],comments:{}};
 document.querySelectorAll('input[data-id]:checked').forEach(c=>{const id=c.dataset.id;const f=INV.folders.find(x=>x.id===id);if(f)return out.folders.push({path:f.path,mode:f.mode});const a=INV.apps.find(x=>x.id===id);if(a)return out.applications.push({name:a.name,wingetId:a.wingetId,source:a.source});const s=INV.settings.find(x=>x.id===id);if(s)out.settings.push({app:s.app,how:s.how})});
 INV.questions.forEach((q,i)=>{const r=document.querySelector('input[name='+q.id+']:checked');out.questions.push({n:i+1,question:q.text,answer:r?q.options[+r.value][0]:null})});
 document.querySelectorAll('textarea[data-c]').forEach(t=>{if(t.value.trim())out.comments[t.dataset.c]=t.value.trim()});return out}
el('save').onclick=()=>{const b=new Blob([JSON.stringify(collect(),null,1)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='laptop-move-selection.json';a.click()};
el('copy').onclick=async()=>{const t=JSON.stringify(collect(),null,1);try{await navigator.clipboard.writeText(t);el('msg').textContent='copied'}catch{const x=document.createElement('textarea');document.body.appendChild(x);x.value=t;x.select();document.execCommand('copy');x.remove();el('msg').textContent='copied'}};
document.addEventListener('change',total);total();`;
const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Laptop move: selection</title><style>${css}</style></head><body><div class="bar"><b>Laptop move selection</b><span id="tot"></span><button id="save">Save selection</button><button id="copy">Copy answers</button><span id="msg"></span></div><h1>Laptop move: what to take</h1><p>Ticks are the recommendation. Untick what you do not want. Every section and question has a comment box. Saving downloads laptop-move-selection.json; Copy answers copies the same text. Nothing leaves this page.</p><script>${js.replace('__INV__', JSON.stringify(inventory).replace(/</g, '\\u003c'))}</script></body></html>`;
writeFileSync(join(dataDir, 'select.html'), html);
const sum = (k) => folders.filter((f) => f.rec).reduce((a, f) => a + (f[k] ?? 0), 0);
console.log('folders', folders.length, 'apps', apps.length, 'recommended pack GB', (sum('packMB') / 1024).toFixed(1));
console.log('whole-copy of ticked folders GB (no nm/caches)', (folders.filter((f) => f.rec).reduce((a, f) => a + f.sizeMB, 0) / 1024).toFixed(1));
