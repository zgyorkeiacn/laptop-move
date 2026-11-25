# Laptop move kit

Moves a laptop's local work to a new laptop. On the old laptop, `pack` reads the selection saved from the laptop move form and writes a bundle folder:

- encrypted 7-Zip parts (a few GB each), each with a SHA-256;
- a plain `laptop-move-kit.zip` holding the kit, the manifest, this README and the official signed `node.exe`.

You upload the bundle folder yourself (to your Accenture OneDrive only), download it on the new laptop and run one command. `restore` then:

1. checks the parts;
2. installs 7-Zip if it is missing;
3. unpacks the parts;
4. installs the apps one by one;
5. clones the repositories again and puts back their local commits, stashes and uncommitted files;
6. puts the folders and settings back at the same paths;
7. recreates the junctions;
8. writes an HTML report of what happened and what is left to do by hand.

The kit itself is in `kit\`: `kit.mjs` is the command line and `kit\lib` the engine. It needs node 20 or newer and 7-Zip 26.03 or newer, installed at `C:\Program Files\7-Zip\7z.exe`.

## The guide

The tutorials, step-by-step instructions, troubleshooting, FAQ and security notes for IT are pages of the interface (the Help links, `/guide/<topic>`) and one printable file:

```text
node scripts/build-guide.mjs
```

This writes `docs\guide\laptop-move-guide.html`: one self-contained page (style, pictures and diagrams inline, no outside script or font) in the Accenture livery. The pages are the fragments in `kit\ui\guide\`. The pictures in `kit\ui\guide\img` are taken from the running interface on made-up sample data by `scripts\guide-shots.mjs` (Playwright starts Edge itself, no debugging port).

## What never goes into the bundle

- **Secret-bearing files are never copied.** This covers `.env*`, `.npmrc`, keys, `.ssh`, cloud credentials, browser login data and similar files. They are listed under "Move by hand".
- **Regenerable folders are left out:** `node_modules`, build output, caches and `.temp`.
- **Repositories are never changed.** The kit does not push, does not fetch, and reads git without locks.
  - A repository with a remote is cloned again on the new laptop.
  - Its unpushed commits and stashes travel as a git bundle, and its uncommitted files are copied.
  - A repository without a remote is copied whole.

## Client data

Client data is marked by a small local rules file, `laptop-move-client.json`, which sits next to the selection file. The kit itself names no client.

The file looks like this (the patterns are regular expressions matched against the remote URL; `%VAR%` is expanded):

```json
{
  "clientRoots": ["C:\\client-repos"],
  "clientRemotePatterns": ["github\\.com[/:]client-org/", "dev\\.azure\\.com/client-org/"],
  "forbiddenOut": ["%USERPROFILE%\\OneDrive - Client"]
}
```

How client data is handled:

- **Client repositories with a remote** stay out of the bundle and are cloned again. Push their local work before the move: the dry run lists it under "Push first".
- **Client repositories without a remote, and client folders,** go into a separate encrypted client part, `client-*.7z.*`. Upload that part to your Accenture OneDrive only, never to a client's OneDrive.
- **`--client-data`** carries client repositories whole, still only in the client part.
- **Output folder:** the kit refuses an output folder inside a client folder or the client's OneDrive.
- **No rules file:** pack stops, unless you add `--no-client-rules` (nothing on the laptop is client data).

## Password

Every data part is encrypted with 7-Zip AES-256, file names included. Use one password for all parts and keep it somewhere safe: it cannot be recovered.

- **In the page** (`ui`): you type it twice. It needs at least 12 characters, and only letters, digits, spaces and the signs of a US keyboard, so it types the same on any keyboard. The page sends it to the mover on 127.0.0.1, and the mover pipes it to 7-Zip's input. It is never on a command line, in a file, in a log or in an address, and the mover keeps no copy after the step.
- **On the command line:** 7-Zip asks for it at its own console prompt, once per archive when packing (plus a confirmation) and again when unpacking. The kit never sees it.

## The page

The guided page runs every step: scan, choose, dry run, pack, upload, restore and the report. Each screen has a help link to the guide, and the whole guide can be printed. The mover's own node serves the page on 127.0.0.1 only, on a free port, behind a one-time link and a session key. The page opens in your default browser, and the mover stops when you close the page or press "End the mover".

On the old laptop, in the `kit` folder of this repository:

```powershell
node kit.mjs ui
```

On the new laptop, in the extracted `laptop-move-kit` folder:

```powershell
.\node.exe kit.mjs ui
```

Options:

- `--selection <file>`;
- `--scan-root "<folder>;<folder>"`;
- `--no-open` prints the link instead of opening it.

The page saves the selection in the form's own format. An existing file is kept as a dated `.bak.json` copy. The page never saves into a client's folder or a OneDrive folder.

Not moved, checked on the new laptop instead:

- **Printers:** secure print queues come from the company setup on the new laptop. Print one page to check.
- **Wi-Fi:** no Wi-Fi profile or key is packed. Check that the office network is there.

## Old laptop

Run these in PowerShell, in the `kit` folder of this repository.

1. Save the selection from the form. The kit looks for `laptop-move-selection.json` in this order:
   - the current folder;
   - `%APPDATA%\AIxOrchestrator\reports`;
   - `Downloads`.

   You can also name the file with `--selection`.
2. Write `laptop-move-client.json` next to the selection.
3. See what pack would do: sizes, parts, time, "Move by hand" and "Push first". Nothing is written.

   ```powershell
   node kit.mjs dry-run --out C:\LaptopMove\bundle
   ```

4. Pack into a new, empty local folder. It must not be a synced OneDrive folder; `--allow-onedrive` accepts your own Accenture OneDrive.

   ```powershell
   node kit.mjs pack --out C:\LaptopMove\bundle
   ```

5. Upload every file of `C:\LaptopMove\bundle` to your Accenture OneDrive (the client part too, never a client's OneDrive).

To see all options:

```powershell
node kit.mjs help
```

## New laptop

1. Download all the files into one folder, for example `C:\LaptopMove\bundle`.
2. Extract `laptop-move-kit.zip` there (right-click, Extract All).
3. In PowerShell, in the extracted `laptop-move-kit` folder, see what restore would do:

   ```powershell
   .\node.exe kit.mjs restore --from C:\LaptopMove\bundle --dry-run
   ```

4. Restore:

   ```powershell
   .\node.exe kit.mjs restore --from C:\LaptopMove\bundle
   ```

Files that already exist are kept and listed as conflicts. Add `--overwrite` to replace them; each replaced file is backed up first to `C:\LaptopMove\restore\replaced`.

Apps from Software Center or Company Portal are only listed: install them there. To run only the app installs:

```powershell
.\node.exe kit.mjs apps
```

If company policy blocks the bundled `node.exe`, install Node from Software Center or with winget. Then run the same commands with `node` instead of `.\node.exe`.

## Trial run

`--target-root` puts everything below one folder instead of the real places, so a restore can be tried on the same laptop:

```powershell
.\node.exe kit.mjs restore --from C:\LaptopMove\bundle --target-root C:\LaptopMove\trial --skip-apps
```

## Tests

From this folder:

```powershell
npm test
```

The page in Edge, on sample data only (a dry run: Pack is never pressed). It needs playwright-core, so name the folder that holds it:

```powershell
node scripts/check-ui.mjs --playwright <folder holding node_modules\playwright-core>
```

The mock page (docs/mock/laptop-mover-mock.html) in Edge: no page error, the start screen visible at load, every button showing its own screen (add `--file <html>` to check another copy):

```powershell
node scripts/check-mock.mjs --playwright <folder holding node_modules\playwright-core>
```

From this folder, the type check:

```powershell
npm run typecheck
```
