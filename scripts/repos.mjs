// Read-only git state of every repository found by walk.mjs. Never fetches, pulls or pushes.
// Usage: node scripts/repos.mjs  -> data/repos.json
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => {
  try { return execFileSync('git', a, { cwd, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch { return null; }
};
// Default: only repositories that data/repos.json lacks (keeps the load light); --all redoes every one.
// Repositories under AppData\Local\Temp are scratch clones of tools and are never listed.
const redoAll = process.argv.includes('--all');
const SCRATCH = /\\AppData\\Local\\Temp\\/i;
let known = [];
try { known = JSON.parse(readFileSync(join(dataDir, 'repos.json'), 'utf8')); } catch {}
const have = new Set(redoAll ? [] : known.map((k) => k.path.toLowerCase()));
const seen = new Set();
const repos = [];
for (const f of readdirSync(dataDir).filter((x) => x.startsWith('walk-'))) {
  const j = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
  for (const r of j.repos) if (!seen.has(r.toLowerCase()) && !have.has(r.toLowerCase()) && !SCRATCH.test(r)) { seen.add(r.toLowerCase()); repos.push(r); }
}
const out = redoAll ? [] : [...known];
for (const r of repos) {
  const remotes = git(r, 'remote', '-v');
  const origin = git(r, 'remote', 'get-url', 'origin');
  const branch = git(r, 'rev-parse', '--abbrev-ref', 'HEAD');
  const status = git(r, 'status', '--porcelain');
  const dirty = status ? status.split('\n').length : 0;
  const upstream = git(r, 'rev-parse', '--abbrev-ref', '@{u}');
  let unpushed = null;
  if (upstream) unpushed = Number(git(r, 'rev-list', '--count', '@{u}..HEAD') ?? 0);
  else if (remotes) {
    const n = git(r, 'rev-list', '--count', 'HEAD', '--not', '--remotes');
    unpushed = n === null ? null : Number(n);
  }
  const localOnlyBranches = git(r, 'for-each-ref', '--format=%(refname:short)|%(upstream:short)', 'refs/heads');
  const noUpstreamBranches = localOnlyBranches ? localOnlyBranches.split('\n').filter((l) => l && l.endsWith('|')).length : 0;
  const stash = git(r, 'stash', 'list');
  const wts = git(r, 'worktree', 'list', '--porcelain');
  const worktrees = wts ? wts.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)) : [];
  out.push({ path: r, origin: origin || null, hasRemote: !!remotes, branch, dirty, upstream: upstream || null, unpushed, noUpstreamBranches, stashes: stash ? stash.split('\n').length : 0, worktrees: worktrees.filter((w) => w.toLowerCase() !== r.toLowerCase().replace(/\\/g, '/')).length });
}
writeFileSync(join(dataDir, 'repos.json'), JSON.stringify(out, null, 1));
console.log('added', repos.length, 'repos', out.length, 'noRemote', out.filter((x) => !x.hasRemote).length, 'dirty', out.filter((x) => x.dirty).length, 'unpushed', out.filter((x) => x.unpushed).length, 'stashes', out.filter((x) => x.stashes).length);
