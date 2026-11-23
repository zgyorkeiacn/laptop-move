// Lists secret-bearing files BY PATH ONLY. Never opens a file. -> data/secret-paths.json
import { opendir, lstat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const roots = process.argv.slice(2);
const SKIP = new Set(['node_modules', '.git', 'OneDrive', 'AppData']);
const NAME = [/^\.env(\..+)?$/i, /^\.npmrc$/i, /^\.git-credentials$/i, /^\.netrc$/i, /^id_(rsa|ed25519|ecdsa)(\.pub)?$/i, /\.(pem|pfx|p12|key|ppk)$/i, /^client_secret.*\.json$/i, /^\.credentials\.json$/i, /^credentials\.json$/i, /^accounts\.json$/i, /^pat-status\.json$/i, /^settings\.xml$/i, /^Login Data/i, /^Cookies$/i, /^Local State$/i];
const found = [];
async function walk(dir, depth) {
  let d; try { d = await opendir(dir); } catch { return; }
  for await (const e of d) {
    const p = join(dir, e.name);
    let st; try { st = await lstat(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith('OneDrive')) { if (e.name === '.ssh') found.push(p); continue; }
      if (e.name === '.ssh' || e.name === '.aws' || e.name === '.azure') { found.push(p); continue; }
      if (depth < 8) await walk(p, depth + 1);
    } else if (NAME.some((r) => r.test(e.name))) found.push(p);
  }
}
for (const r of roots) await walk(r, 0);
await writeFile(join(here, '..', 'data', 'secret-paths.json'), JSON.stringify(found.sort(), null, 1));
console.log('secret-bearing paths', found.length);
