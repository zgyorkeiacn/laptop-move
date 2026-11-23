// Git on the old laptop: read only (GIT_OPTIONAL_LOCKS=0, never fetch, pull, push or change a ref); bundles and patches
// are written into the kit's own stage folder. Git on the new laptop: clone through Git Credential Manager (the user signs
// in when git asks; the kit never handles a token), then branches, bundle, stashes and uncommitted files.
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run, runInherit } from './util.mjs';
import { redactUrl } from './filters.mjs';

const w = path.win32;
const READ_ENV = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

/** @param {string} cwd @param {string[]} args @param {number} [timeout] */
export function gitRead(cwd, args, timeout = 120000) {
  return run('git', args, { cwd, env: READ_ENV(), timeout });
}

/**
 * Parses `git status --porcelain=v1 -z`: files to carry (changed, added, untracked) and files deleted in the work tree.
 * @param {string} out
 */
export function parseStatusZ(out) {
  /** @type {string[]} */ const changed = [];
  /** @type {string[]} */ const deleted = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0];
    const y = e[1];
    const file = e.slice(3).replace(/\//g, '\\');
    if (x === 'R' || x === 'C') i++; // the next entry is the old name
    if (x === '!') continue;
    if (y === 'D' || (x === 'D' && y === ' ')) { deleted.push(file); continue; }
    changed.push(file);
  }
  return { changed, deleted };
}

/**
 * Everything the kit records about one repository. Read only.
 * @param {string} dir
 */
export async function repoInfo(dir) {
  const top = await gitRead(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return null;
  const isRoot = w.normalize(top.stdout.trim().replace(/\//g, '\\')).toLowerCase() === w.normalize(dir).toLowerCase();
  const remotes = await remotesOf(dir);
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null;
  const sym = await gitRead(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const head = (await gitRead(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim() || null;
  const branchesOut = (await gitRead(dir, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(upstream:short)', 'refs/heads'])).stdout;
  const branches = branchesOut.split(/\r?\n/).filter(Boolean).map((l) => { const [name, sha, upstream] = l.split('\0'); return { name, sha, upstream: upstream || null }; });
  const branch = sym.code === 0 ? sym.stdout.trim() : null;
  const upstream = branches.find((b) => b.name === branch)?.upstream ?? null;
  const unpushedOut = (await gitRead(dir, ['log', '--branches', '--not', '--remotes', '--format=%h%x00%s', '-n', '200'])).stdout;
  const unpushed = unpushedOut.split(/\r?\n/).filter(Boolean).map((l) => { const [sha, subject] = l.split('\0'); return { sha, subject }; });
  const stashOut = (await gitRead(dir, ['stash', 'list', '--format=%gd%x00%H%x00%gs'])).stdout;
  const stashes = stashOut.split(/\r?\n/).filter(Boolean).map((l, i) => { const [ref, sha, message] = l.split('\0'); return { index: i, ref, sha, message }; });
  const st = await gitRead(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const dirty = st.code === 0 ? parseStatusZ(st.stdout) : { changed: [], deleted: [] };
  const wt = (await gitRead(dir, ['worktree', 'list', '--porcelain'])).stdout;
  const worktrees = wt.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => w.normalize(l.slice(9).replace(/\//g, '\\'))).slice(1);
  const isWorktree = /[\\/]worktrees[\\/][^\\/]+$/.test((await gitRead(dir, ['rev-parse', '--git-dir'])).stdout.trim());
  return { path: dir, isRoot, remotes, origin: origin?.url ?? null, branch, detached: !branch, head, upstream, branches, unpushed, stashes, dirty, worktrees, isWorktree };
}

/**
 * The remotes of a repository, cheaply (one git call), with passwords left out of the URLs.
 * @param {string} dir
 */
export async function remotesOf(dir) {
  const out = (await gitRead(dir, ['remote', '-v'])).stdout;
  /** @type {{name: string, url: string, hasPassword: boolean}[]} */
  const remotes = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) remotes.push({ name: m[1], url: redactUrl(m[2]), hasPassword: redactUrl(m[2]) !== m[2] });
  }
  return remotes;
}

/** The main working folder of a worktree's repository. @param {string} dir */
export async function mainRepoOf(dir) {
  const r = await gitRead(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) return null;
  const common = w.normalize(r.stdout.trim().replace(/\//g, '\\'));
  return w.basename(common).toLowerCase() === '.git' ? w.dirname(common) : null;
}

/**
 * Bundles the commits no remote has (all branches and tags, the detached HEAD and the stashes). Null when there is
 * nothing to bundle. Writes only the bundle file.
 * @param {string} dir
 * @param {string} file
 * @param {string[]} stashShas
 * @param {boolean} [detached]
 */
export async function makeBundle(dir, file, stashShas, detached = false) {
  await mkdir(w.dirname(file), { recursive: true });
  const hasStash = stashShas.length > 0;
  const args = ['bundle', 'create', file, '--branches', '--tags', ...(detached ? ['HEAD'] : []), ...(hasStash ? ['refs/stash', ...stashShas.slice(1)] : []), '--not', '--remotes'];
  const r = await gitRead(dir, args, 600000);
  if (r.code !== 0) {
    if (/empty bundle/i.test(r.stderr)) return { ok: true, file: null };
    return { ok: false, file: null, why: r.stderr.trim().split(/\r?\n/).pop() };
  }
  return { ok: true, file };
}

/**
 * Saves one stash as a patch, the fallback when the bundle cannot bring it back.
 * @param {string} dir
 * @param {string} ref stash@{n}
 * @param {string} file
 */
export async function stashPatch(dir, ref, file) {
  const r = await gitRead(dir, ['stash', 'show', '-p', '--binary', '--include-untracked', ref]);
  if (r.code !== 0) return false;
  await mkdir(w.dirname(file), { recursive: true });
  await writeFile(file, r.stdout);
  return true;
}

/** Git on the new laptop, its output on the user's console. @param {string} cwd @param {string[]} args */
export function gitLive(cwd, args) {
  return runInherit('git', args, { cwd });
}

/** Git on the new laptop, output captured. @param {string} cwd @param {string[]} args */
export function gitHere(cwd, args) {
  return run('git', args, { cwd, timeout: 600000 });
}

/**
 * Brings one repository back on the new laptop: branches from the bundle, the recorded branch checked out,
 * stashes stored, uncommitted files laid over the work tree. Assumes the clone exists.
 * @param {{dest: string, bundle: string|null, rec: any, patchDir: string|null, worktree?: boolean}} o
 * @returns {Promise<{notes: string[], problems: string[]}>}
 */
export async function applyRepoState(o) {
  const { dest, rec } = o;
  /** @type {string[]} */ const notes = [];
  /** @type {string[]} */ const problems = [];
  const has = async (/** @type {string} */ sha) => (await gitHere(dest, ['cat-file', '-e', `${sha}^{commit}`])).code === 0;
  if (o.bundle && existsSync(o.bundle)) {
    const f = await fetchBundle(dest, o.bundle, !!rec.detached);
    if (f.code !== 0) problems.push(`bundle not applied: ${f.stderr.trim().split(/\r?\n/).pop()}`);
    else notes.push('bundle fetched');
  }
  if (!o.worktree) {
    const head = (await gitHere(dest, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim();
    for (const b of rec.branches ?? []) {
      if (!(await has(b.sha))) { problems.push(`branch ${b.name}: commit ${b.sha.slice(0, 9)} is missing (it was not pushed and not bundled)`); continue; }
      const exists = (await gitHere(dest, ['rev-parse', '--verify', '-q', `refs/heads/${b.name}`])).code === 0;
      if (!exists) {
        await gitHere(dest, ['branch', b.name, b.sha]);
      } else {
        const cur = (await gitHere(dest, ['rev-parse', `refs/heads/${b.name}`])).stdout.trim();
        if (cur !== b.sha) {
          const behind = (await gitHere(dest, ['merge-base', '--is-ancestor', b.sha, cur])).code === 0;
          const ahead = !behind && (await gitHere(dest, ['merge-base', '--is-ancestor', cur, b.sha])).code === 0;
          if (behind) notes.push(`${b.name}: the remote is newer than the old laptop, kept the remote's`);
          else if (ahead && head === b.name) await gitHere(dest, ['merge', '--ff-only', b.sha]);
          else if (ahead) await gitHere(dest, ['branch', '-f', b.name, b.sha]);
          else {
            await gitHere(dest, ['branch', '-f', `laptop-move/${b.name}`, b.sha]);
            problems.push(`branch ${b.name}: it has moved on both sides; the old laptop's tip is the branch laptop-move/${b.name}`);
          }
        }
      }
      if (b.upstream) await gitHere(dest, ['branch', `--set-upstream-to=${b.upstream}`, b.name]);
    }
    if (rec.branch) {
      const c = await gitHere(dest, ['checkout', rec.branch]);
      if (c.code !== 0) problems.push(`checkout ${rec.branch}: ${c.stderr.trim().split(/\r?\n/).pop()}`);
    } else if (rec.head && (await has(rec.head))) {
      await gitHere(dest, ['checkout', '--detach', rec.head]);
    }
    const stashes = [...(rec.stashes ?? [])].reverse();
    for (const s of stashes) {
      if (await has(s.sha)) {
        const r = await gitHere(dest, ['stash', 'store', '-m', s.message || 'laptop-move stash', s.sha]);
        if (r.code === 0) continue;
      }
      if (o.patchDir && s.patch) problems.push(`stash "${s.message}": not restored as a stash; its patch is ${w.join(o.patchDir, s.patch)} (git apply --3way <patch>)`);
      else problems.push(`stash "${s.message}": not restored`);
    }
  }
  await dropTempRefs(dest);
  return { notes, problems };
}

/** Fetches a bundle's refs into refs/laptop-move. @param {string} dest @param {string} bundle @param {boolean} detached */
export function fetchBundle(dest, bundle, detached) {
  return gitHere(dest, ['fetch', '--no-tags', bundle, '+refs/*:refs/laptop-move/*', ...(detached ? ['+HEAD:refs/laptop-move/HEAD'] : [])]);
}

/** Removes the kit's temporary refs. @param {string} dest */
export async function dropTempRefs(dest) {
  const left = (await gitHere(dest, ['for-each-ref', '--format=%(refname)', 'refs/laptop-move/'])).stdout.split(/\r?\n/).filter(Boolean);
  for (const ref of left) await gitHere(dest, ['update-ref', '-d', ref]);
}
