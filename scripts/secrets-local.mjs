// Lists, by path only, the secret-bearing files and folders under AppData\Local (FORM-GAPS).
// Only names are read (readdir, lstat): no file is ever opened. Writes data/secret-paths-local.json.
import { readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const L = join(process.env.USERPROFILE ?? 'C:\\Users\\zoltan.gyorkei', 'AppData', 'Local');
const out = [];
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
const names = (p) => { try { return readdirSync(p); } catch { return []; } };

// Chromium based browsers: per profile Login Data, Cookies, Web Data, plus Local State at the user data root
for (const ud of [join(L, 'Microsoft', 'Edge', 'User Data'), join(L, 'Google', 'Chrome', 'User Data'), join(L, 'Google', 'Chrome Dev', 'User Data')]) {
  if (exists(join(ud, 'Local State'))) out.push(join(ud, 'Local State'));
  for (const n of names(ud)) {
    if (!(n === 'Default' || /^Profile \d+$/.test(n) || n === 'Guest Profile')) continue;
    for (const f of ['Login Data', 'Login Data For Account', 'Web Data', 'Cookies', join('Network', 'Cookies')]) if (exists(join(ud, n, f))) out.push(join(ud, n, f));
  }
}
// Windows credential stores and token caches (folders, listed whole)
for (const d of [['Microsoft', 'Credentials'], ['Microsoft', 'Vault'], ['Microsoft', 'Crypto'], ['Microsoft', 'TokenBroker'], ['Microsoft', 'OneAuth'], ['Microsoft', 'IdentityCache'], ['.IdentityService'], ['GitHub CLI'], ['claude-cli-nodejs']]) {
  const p = join(L, ...d);
  if (exists(p)) out.push(p + '\\');
}
// any file here whose name says credential, token, secret or key (names only, one level below each folder)
const SKIP = /^(Temp|npm-cache|pnpm|pnpm-cache|Packages|ms-playwright|Android|JetBrains|Pub|Microsoft|Google|Programs|flutter|dart-sdk|electron|\.dartServer)$/;
for (const top of names(L)) {
  if (SKIP.test(top)) continue;
  const tp = join(L, top);
  for (const n of names(tp)) if (/(credential|token|secret|\.pem$|\.pfx$|\.key$|\.ppk$|auth\.json|login)/i.test(n)) out.push(join(tp, n));
}
writeFileSync(join(dataDir, 'secret-paths-local.json'), JSON.stringify([...new Set(out)].sort(), null, 1));
console.log('secret paths under AppData\\Local', new Set(out).size);
