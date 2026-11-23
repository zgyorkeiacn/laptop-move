# LAPTOP.MOVE.RESEARCH: moving to a new laptop

Method, comparison, recommendation and open questions. This page is generic: the concrete folders, repositories, applications and files of this machine are in `data/inventory.json` and the selection form `data/select.html` (both kept out of git).

## 1. What was measured (read only)

- Walk with `scripts/walk.mjs`: size and file count per folder, with node_modules and cache-like folders (dist, build, out, .cache, .temp, target, .gradle, venv and similar) counted apart. Junctions and symlinks are never followed: they are listed to be recreated.
- `scripts/repos.mjs`: per repository the remote, branch, uncommitted files, unpushed commits, branches without upstream, stashes and worktrees, with `GIT_OPTIONAL_LOCKS=0`, never fetch, pull or push.
- `scripts/deps.mjs`: which runtimes the repositories declare (.nvmrc, engines, Volta, packageManager, Playwright, Maven, Gradle, .NET, Python, Flutter).
- `scripts/secrets.mjs`: lists secret-bearing files by path only. It never opens a file.
- Applications: winget export, registry Uninstall keys, Appx packages, editor extension lists, global npm packages.

## 2. Findings that shape the plan

1. About 100 repositories sit in several root folders. Most are fetchable. A handful have no remote and must be copied whole. About a quarter have uncommitted files, about a tenth have unpushed commits, and many have local branches without an upstream: those need a bundle.
2. The movable bytes are far smaller than the disk use. node_modules and caches are roughly a third of the repository folders, and many folders are regenerable git worktrees, exports and temp copies.
3. One root holds more than ten thousand junctions (a pnpm-like layout inside repositories): they come back with `npm install` or `pnpm install`, not by copying.
4. The user folder is dominated by regenerable tool caches (Android SDK, Gradle, Maven, JDKs). The parts that are local only: Desktop, Documents, Pictures, tool settings, the Claude Code folder (transcripts are the bulk) and a few app data folders.
5. Company-managed software (endpoint security, privilege management, remote access, device management) comes from company provisioning and must not be installed by the mover.
6. Secret-bearing files (.env, .npmrc, Maven settings.xml, credential files, browser profiles, broker tokens) are left out by default.

## 3. Comparison

| Choice | Option | Pro | Con |
|---|---|---|---|
| Medium | Direct network copy | fastest, no extra device, no encrypted drive needed | needs both laptops on one network, policy may block SMB between laptops |
| | External drive | works offline | company data-loss tools may block or log removable media; encryption needed |
| | Company network share | no new device | slow, quota, and still logged |
| | OneDrive | automatic | only for small parts (quota, sync of many small files is slow) |
| Copy tool | robocopy /XJ /COPY:DAT | resumable, fast, built in, skips junctions | many small files are slow; no compression |
| | 7-Zip 26.03 or newer archives | fewer files, compression, one file to verify | needs 7-Zip on both sides |
| Repositories | Clone again plus git bundle plus dirty files | about 1 to 3 percent of the bytes, clean state | more steps; no-remote repos still copied whole |
| | Copy whole | simplest | copies node_modules and caches; junctions need care |
| Applications | winget import | one command | fails on packages not in winget, versions drift, may be blocked |
| | Installers one by one, from a list | works for every source, can skip or fail without stopping | slower, needs pages and ids kept up to date |

## 4. Recommendation

1. **First step on the new laptop:** one winget command that the user pastes (OpenJS.NodeJS). Nothing else runs before it.
2. **The mover is one node .mjs script**, no .ps1, .sh, .bat or .cmd file. It reads the saved selection file (`laptop-move-selection.json`) and does the rest.
3. **Applications:** installs from winget ids one by one, continues after a failure and prints a list of what needs the Company Portal or a download page. Company-managed software is only checked, never installed.
4. **Repositories:** clone again; apply a git bundle of unpushed commits and local-only branches; copy uncommitted files over the clone; copy no-remote repositories whole. Recreate worktrees on demand.
5. **Local-only folders:** robocopy /XJ for ordinary folders, 7-Zip 26.03 archives for the large ones with many small files (the Claude Code transcripts, Pictures).
6. **Junctions:** recreated from the list in the inventory.
7. **Settings:** copy editor User folders, Windows Terminal settings.json, .gitconfig, the Claude Code folder (without credentials) and the app data folders of own apps; reinstall editor extensions from the list.
8. **Secrets:** by hand, from the listed paths. Browser passwords and cookies are bound to the Windows account and the machine: sign in again and let the browser account sync.
9. **Policy:** no Defender exclusions, no scheduled tasks, no -ExecutionPolicy Bypass, no remote debugging port. Run as the normal user. If robocopy or archiving is blocked by an ASR audit on mass copy, split the copy into smaller batches and ask IT before anything else.

## 5. Estimate (recommended way)

- Pack size: see the total at the top of the selection form (it moves with the ticks). With every recommended tick it is about 31 GB (versus about 59 GB if the same folders were copied whole with their git history and local copies). The largest items are the Gemini and Claude Code folders (about 7 GB each, mostly transcripts), editor and app data folders, and a few big non-repository or no-remote folders. Unticking the Gemini folder and the editor data folders brings it near 20 GB.
- Time: over a 1 Gbit direct link about 20 to 40 minutes of copying plus about 30 to 60 minutes of cloning, npm install and application installs. A drive or a share is about 1.5 to 3 times longer. The copying is mostly waiting, not attention.
- Building the mover (LAPTOP.MOVE.KIT) is a separate item.

## 6. What company policy may block

- **Admin rights:** many installers need elevation. Privilege management may prompt per installer.
- **winget:** may be disabled or limited to the company source.
- **Software sources:** the company catalogue or Company Portal may be the only allowed route.
- **Removable media and mass copies:** data-loss tools and Defender ASR may log or block. Stay inside it: ordinary user rights, no exclusions, no scheduled tasks, copy in batches.
- **Client code:** repositories of a client may only be allowed on laptops that client approved.

## 7. What will not work after a copy

- Browser saved passwords, cookies and sessions (bound to the Windows account).
- Git Credential Manager and Windows Credential Manager entries.
- Tokens, API keys and keys held by apps in their own stores.
- Anything protected per machine (VPN profiles, device certificates, company agents).

## 8. Questions for the user

1. Which way moves the data? Direct network copy (Recommended) / external drive / network share / OneDrive for small parts.
2. Is the new laptop company managed with the same policies? Yes, same image (Recommended) / yes, different image / no.
3. Repositories: clone again plus bundle plus dirty files, whole copy only without remote (Recommended) / copy every repository whole.
4. Client repositories: move them too if the new laptop is client approved (Recommended) / clone later.
5. Editor settings route: copy the User folder and reinstall extensions (Recommended) / editor Settings Sync.
6. Claude Code transcripts: carry as a compressed archive (Recommended) / leave behind.
7. Keep the old laptop usable for at least two weeks (Recommended) / hand back at once.

The same questions, with comment boxes, are on the selection form.
