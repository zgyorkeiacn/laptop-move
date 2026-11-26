// Builds release\Laptop Mover-win32-x64: Laptop Mover.exe (a Node single executable holding app\launcher.cjs), the kit
// beside it in kit\ (kit.mjs, lib, ui; pack copies these into laptop-move-kit.zip) and README.md.
//   node scripts/package.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error('Packaging needs Windows and Node 26 or newer (node --build-sea).');
}

const w = path.win32;
const root = w.resolve(w.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(w.join(root, 'package.json'), 'utf8'));
const PRODUCT = 'Laptop Mover';
const out = w.join(root, 'release', `${PRODUCT}-win32-x64`);
const staging = w.join(tmpdir(), 'laptop-mover-staging');
const exe = w.join(out, `${PRODUCT}.exe`);

rmSync(out, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(w.join(out, 'kit', 'lib'), { recursive: true });
mkdirSync(staging, { recursive: true });

cpSync(w.join(root, 'kit', 'kit.mjs'), w.join(out, 'kit', 'kit.mjs'));
for (const f of readdirSync(w.join(root, 'kit', 'lib'))) if (f.endsWith('.mjs')) cpSync(w.join(root, 'kit', 'lib', f), w.join(out, 'kit', 'lib', f));
cpSync(w.join(root, 'kit', 'ui'), w.join(out, 'kit', 'ui'), { recursive: true });
cpSync(w.join(root, 'README.md'), w.join(out, 'README.md'));

writeFileSync(w.join(staging, 'sea.json'), JSON.stringify({
  main: w.join(root, 'app', 'launcher.cjs'),
  output: exe,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}));
console.log(`[package] Building ${PRODUCT}.exe ${version} (Node ${process.versions.node} single executable)...`);
execFileSync(process.execPath, ['--build-sea', w.join(staging, 'sea.json')], { stdio: 'inherit' });
rmSync(staging, { recursive: true, force: true });

const help = execFileSync(exe, ['help'], { encoding: 'utf8', timeout: 60000 });
if (!help.includes('Laptop move kit')) throw new Error(`${PRODUCT}.exe help did not print the kit's help:\n${help}`);
console.log(`[package] Ready: ${out}`);
