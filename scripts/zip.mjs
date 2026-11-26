// Zips release\Laptop Mover-win32-x64 into dist\laptop-mover-<version>-win-x64.zip, the archive to hand out.
// PowerShell's Compress-Archive: no npm zip library, and 7-Zip may not be installed on the building laptop.
//   node scripts/zip.mjs        (after node scripts/package.mjs)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const w = path.win32;
const root = w.resolve(w.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(w.join(root, 'package.json'), 'utf8'));
const packaged = w.join(root, 'release', 'Laptop Mover-win32-x64');
if (!existsSync(w.join(packaged, 'Laptop Mover.exe'))) {
  console.error(`[zip] no packaged app at ${packaged}: run npm run package first.`);
  process.exit(1);
}

mkdirSync(w.join(root, 'dist'), { recursive: true });
const archive = w.join(root, 'dist', `laptop-mover-${version}-win-x64.zip`);
rmSync(archive, { force: true });
console.log('[zip] Compressing Laptop Mover.exe and the kit...');
execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -Path '${packaged.replace(/'/g, "''")}\\*' -DestinationPath '${archive.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`,
], { stdio: 'inherit' });
console.log(`[zip] Done: ${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB)`);
console.log('[zip] Recipients: extract it, then double-click Laptop Mover.exe.');
