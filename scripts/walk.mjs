// Read-only folder walker for LAPTOP.MOVE.RESEARCH.
// Usage: node scripts/walk.mjs <root> <outName> [childDepth]
// Writes data/walk-<outName>.json: per child of root (and per grandchild when childDepth=2):
// size, files, node_modules size apart, cache-like folders apart, junctions/symlinks, git repos found.
// Never follows junctions or symlinks, never writes outside data/.
import { opendir, lstat, readlink, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
const outName = process.argv[3];
const childDepth = Number(process.argv[4] ?? 1);
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const CACHE = new Set(['.cache', 'dist', 'out', 'build', '.next', '__pycache__', '.temp', '.tmp', 'coverage', '.turbo', '.parcel-cache', 'target', '.gradle', '.pytest_cache', '.venv', 'venv', 'test-results', 'playwright-report']);

const junctions = [];
const repos = [];

async function walk(dir, acc, state) {
  let d;
  try { d = await opendir(dir); } catch (e) { acc.errors++; return; }
  for await (const e of d) {
    const p = join(dir, e.name);
    let st;
    try { st = await lstat(p); } catch { acc.errors++; continue; }
    if (st.isSymbolicLink()) {
      let target = '';
      try { target = await readlink(p); } catch {}
      junctions.push({ path: p, target });
      continue;
    }
    if (st.isDirectory()) {
      if (e.name === '.git') { repos.push(dir); }
      if (e.name === 'node_modules') {
        const sub = { size: 0, files: 0, errors: 0 };
        await walk(p, sub, { inNm: true });
        acc.nmSize += sub.size; acc.nmFiles += sub.files;
        continue;
      }
      if (CACHE.has(e.name) && !state.inCache) {
        const sub = { size: 0, files: 0, nmSize: 0, nmFiles: 0, cacheSize: 0, errors: 0 };
        await walk(p, sub, { inCache: true });
        acc.cacheSize += sub.size + sub.nmSize; acc.cacheFiles = (acc.cacheFiles ?? 0) + sub.files;
        continue;
      }
      await walk(p, acc, state);
    } else {
      acc.size += st.size; acc.files++;
      acc.mtimeMax = Math.max(acc.mtimeMax ?? 0, st.mtimeMs);
    }
  }
}

function blank() { return { size: 0, files: 0, nmSize: 0, nmFiles: 0, cacheSize: 0, errors: 0 }; }

const out = { root, walkedAt: new Date().toISOString(), children: [], looseFiles: blank(), junctions: [], repos: [] };
let d;
try { d = await opendir(root); } catch (e) { console.error('cannot open', root, e.code); process.exit(1); }
for await (const e of d) {
  const p = join(root, e.name);
  let st;
  try { st = await lstat(p); } catch { continue; }
  if (st.isSymbolicLink()) { let t = ''; try { t = await readlink(p); } catch {} junctions.push({ path: p, target: t }); out.children.push({ name: e.name, type: 'junction', target: t }); continue; }
  if (st.isDirectory()) {
    if ((process.env.WALK_SKIP ?? '').split('|').filter(Boolean).some((s) => e.name.startsWith(s))) { out.children.push({ name: e.name, type: 'skipped' }); continue; }
    if (childDepth >= 2) {
      const kids = [];
      const own = blank();
      let dd; try { dd = await opendir(p); } catch { out.children.push({ name: e.name, type: 'dir', error: 'cannot open' }); continue; }
      for await (const k of dd) {
        const kp = join(p, k.name);
        let kst; try { kst = await lstat(kp); } catch { continue; }
        if (kst.isSymbolicLink()) { let t=''; try { t = await readlink(kp);} catch{} junctions.push({ path: kp, target: t }); kids.push({ name: k.name, type: 'junction', target: t }); continue; }
        if (kst.isDirectory()) {
          const acc = blank();
          const before = repos.length;
          await walk(kp, acc, {});
          kids.push({ name: k.name, type: 'dir', hasGit: repos.slice(before).includes(kp), ...acc });
        } else { own.size += kst.size; own.files++; }
      }
      out.children.push({ name: e.name, type: 'dir', kids, own });
    } else {
      const acc = blank();
      await walk(p, acc, {});
      out.children.push({ name: e.name, type: 'dir', ...acc });
    }
  } else { out.looseFiles.size += st.size; out.looseFiles.files++; }
}
out.junctions = junctions; out.repos = repos;
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, `walk-${outName}.json`), JSON.stringify(out, null, 1));
const mb = (n) => (n / 1048576).toFixed(0);
for (const c of out.children) {
  if (c.kids) console.log(c.name, 'kids:', c.kids.length);
  else console.log(c.name, c.type, 'MB', mb(c.size ?? 0), 'files', c.files ?? 0, 'nmMB', mb(c.nmSize ?? 0), 'cacheMB', mb(c.cacheSize ?? 0));
}
console.log('junctions', junctions.length, 'repos', repos.length);
