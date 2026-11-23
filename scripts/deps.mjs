// Read-only: which runtimes the repositories declare (top level files only). -> data/deps.json
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const seen = new Set(); const repos = [];
for (const f of readdirSync(dataDir).filter((x) => x.startsWith('walk-'))) {
  for (const r of JSON.parse(readFileSync(join(dataDir, f), 'utf8')).repos) if (!seen.has(r.toLowerCase())) { seen.add(r.toLowerCase()); repos.push(r); }
}
const rd = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
const tally = { nvmrc: {}, enginesNode: {}, volta: {}, playwright: {}, packageManager: {}, java: 0, maven: 0, gradle: 0, dotnet: 0, python: 0, flutter: 0, repos: repos.length };
const inc = (o, k) => { if (k) o[k] = (o[k] ?? 0) + 1; };
for (const r of repos) {
  inc(tally.nvmrc, rd(join(r, '.nvmrc')));
  const pj = rd(join(r, 'package.json'));
  if (pj) {
    try {
      const p = JSON.parse(pj);
      inc(tally.enginesNode, p.engines?.node);
      inc(tally.volta, p.volta?.node);
      inc(tally.packageManager, p.packageManager);
      const pw = p.devDependencies?.['@playwright/test'] ?? p.dependencies?.['@playwright/test'] ?? p.devDependencies?.playwright;
      inc(tally.playwright, pw);
    } catch {}
  }
  if (existsSync(join(r, 'pom.xml'))) tally.maven++;
  if (existsSync(join(r, 'build.gradle')) || existsSync(join(r, 'build.gradle.kts'))) tally.gradle++;
  if (existsSync(join(r, 'pom.xml')) || existsSync(join(r, 'build.gradle'))) tally.java++;
  if (readdirSync(r).some((n) => n.endsWith('.csproj') || n.endsWith('.sln'))) tally.dotnet++;
  if (existsSync(join(r, 'requirements.txt')) || existsSync(join(r, 'pyproject.toml'))) tally.python++;
  if (existsSync(join(r, 'pubspec.yaml'))) tally.flutter++;
}
writeFileSync(join(dataDir, 'deps.json'), JSON.stringify(tally, null, 1));
console.log(JSON.stringify(tally));
