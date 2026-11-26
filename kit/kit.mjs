#!/usr/bin/env node
// Laptop move kit: the command line over the engine (lib\engine.mjs). See README.md.
//   node kit.mjs dry-run  --selection <file> [--out <folder>]          what pack would do, nothing written
//   node kit.mjs pack     --selection <file> --out <folder>             old laptop: writes the parts and the kit zip
//   .\node.exe kit.mjs restore --from <folder> [--dry-run]               new laptop: everything back in place
//   .\node.exe kit.mjs apps [--dry-run]                                  new laptop: only the apps, one by one
//   .\node.exe kit.mjs dashboard [--work <folder>]                       new laptop: where a running restore stands
//   node kit.mjs ui                                                      the guided page on 127.0.0.1 (either laptop)
//   Laptop Mover.exe [command]                                           the same, packaged (app\launcher.cjs); no command: ui
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryRun, pack, restore, restoreDryRun, appsOnly, defaultWork } from './lib/engine.mjs';
import { parseSize, fmtBytes } from './lib/util.mjs';
import { appBrowser } from './lib/env.mjs';

const w = path.win32;
const kitDir = w.dirname(fileURLToPath(import.meta.url));

const HELP = `Laptop move kit

The guided page (either laptop; it opens in a Chrome or Edge app window, on this computer only):
  "Laptop Mover.exe"                          the packaged app: double-click it, or run it with any command below
  node kit.mjs ui [--selection <file>] [--scan-root "<folder>;<folder>"] [--no-open] [--no-app]
  .\\node.exe kit.mjs ui                      on the new laptop, in the unpacked kit folder
  It ends when you close the page, press End in it, or press Ctrl+C here.

Old laptop:
  node kit.mjs dry-run --selection <file> [--out <folder>] [--all] [--fast --inventory <file>]
  node kit.mjs pack --selection <file> --out <folder> [--volume 4g] [--client-data]

New laptop (in the unpacked laptop-move-kit folder):
  .\\node.exe kit.mjs restore --from <folder with the parts> [--dry-run]
  .\\node.exe kit.mjs apps [--dry-run]
  .\\node.exe kit.mjs dashboard [--work <folder>]   opens the dashboard of a running restore again

Pack options:
  --selection <file>     the selection saved from the form (laptop-move-selection.json)
  --rules <file>         the client rules file (default: laptop-move-client.json next to the selection)
  --no-client-rules      nothing on this laptop is client data
  --out <folder>         a new, empty local folder (default C:\\LaptopMove\\bundle-<time>)
  --volume <size>        part size, for example 4g or 500m (default 4g)
  --client-data          carry client repositories whole (still only in the encrypted client part)
  --allow-onedrive       allow an output folder synced by your own Accenture OneDrive
  --no-encrypt           trial with test data only; refused when there is client data
  --fast                 dry run without walking the folders (rough sizes)
  --inventory <file>     sizes for --fast
  --no-app-lookup        no winget lookups
  --all                  list everything in the dry run

Restore options:
  --from <folder>        the folder holding the parts and SHA256SUMS.txt (default: next to the kit)
  --work <folder>        unpack and report folder (default C:\\LaptopMove\\restore)
  --target-root <folder> trial: put everything below this folder instead of the real places
  --overwrite            replace files that are there already (they are copied to <work>\\replaced first)
  --skip-apps            no app installs
  --skip-client          leave the client part out
  --npm-ci <all|folders> run npm ci --install-links in the restored repositories
  --step-timeout <min>   time limit of one step: an install, a clone, a download (default 30; Build Tools get three
                         times as much). A step not done by then is stopped, logged and skipped; the restore goes on
  --no-dashboard         do not open the dashboard window (it shows where the restore stands; closing it never
                         stops the restore)
  --no-open              do not open the report
  --dry-run              what it would do, nothing changed
  Everything is logged to <work>\\restore-log.txt as it happens.

Page options (ui):
  --selection, --rules, --no-client-rules, --no-app-lookup, --from, --work as above
  --scan-root <folders>  where the scan looks, ;-separated (default: your user folder and the system drive)
  --no-open              print the page's link instead of opening the browser
  --no-app               open the page in a tab of the default browser, not in a Chrome or Edge app window
`;

/** Options that take a value. */
const VALUED = new Set(['selection', 'rules', 'out', 'volume', 'inventory', 'from', 'work', 'target-root', 'npm-ci', 'scan-root', 'step-timeout', 'status']);
const FLAGS = new Set(['client-data', 'allow-onedrive', 'no-client-rules', 'no-encrypt', 'fast', 'no-app-lookup', 'all', 'overwrite', 'skip-apps', 'skip-client', 'no-open', 'no-app', 'dry-run', 'no-dashboard', 'help']);

/** --step-timeout in minutes, as milliseconds. @param {string|boolean|undefined} v */
export function stepTimeout(v) {
  if (v === undefined) return undefined;
  const m = Number(v);
  if (!Number.isFinite(m) || m < 1 || m > 24 * 60) throw new Error(`--step-timeout takes minutes, 1 to 1440 (not ${v})`);
  return Math.round(m * 60 * 1000);
}

/**
 * Parses the command line. Unknown options are an error, so a typo never runs a pack with defaults.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */ const opts = {};
  /** @type {string[]} */ const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
    if (VALUED.has(key)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${key} needs a value`);
      opts[key] = v;
    } else if (FLAGS.has(key)) {
      if (eq > 0) throw new Error(`--${key} takes no value`);
      opts[key] = true;
    } else throw new Error(`unknown option --${key} (see: node kit.mjs help)`);
  }
  return { command: (rest[0] ?? 'help').toLowerCase(), extra: rest.slice(1), opts };
}

/** Prints the engine's events on the console. */
function printer() {
  const tty = !!process.stdout.isTTY;
  let open = false;
  const endLine = () => { if (open) { process.stdout.write('\n'); open = false; } };
  /** @param {any} e */
  return (e) => {
    if (e.type === 'progress') {
      if (!tty) return;
      const text = `  [${e.done}/${e.total}] ${String(e.text ?? '')}`;
      const width = (process.stdout.columns || 100) - 1;
      process.stdout.write(`\r${(text.length > width ? `${text.slice(0, width - 3)}...` : text).padEnd(width)}`);
      open = true;
      return;
    }
    endLine();
    if (e.type === 'phase') console.log(`\n== ${e.text}`);
    else if (e.type === 'step') console.log(`  ${e.text}`);
    else if (e.type === 'warn') console.log(`WARNING: ${e.text}`);
    else if (e.type === 'done') console.log(`\n${e.text}`);
  };
}

/** @param {Record<string, string|boolean>} o */
function packOptions(o) {
  return {
    kitDir,
    selection: o.selection ? w.resolve(String(o.selection)) : undefined,
    rulesFile: o.rules ? w.resolve(String(o.rules)) : undefined,
    rules: o['no-client-rules'] && !o.rules ? null : undefined,
    noClientRules: !!o['no-client-rules'],
    out: o.out ? w.resolve(String(o.out)) : undefined,
    volumeBytes: o.volume ? parseSize(String(o.volume)) : undefined,
    clientData: !!o['client-data'],
    allowOneDrive: !!o['allow-onedrive'],
    encrypt: !o['no-encrypt'],
    fast: !!o.fast,
    inventory: o.inventory ? w.resolve(String(o.inventory)) : undefined,
    appLookup: !o['no-app-lookup'],
    all: !!o.all,
  };
}

/** @param {Record<string, string|boolean>} o */
function restoreOptions(o) {
  return {
    kitDir,
    from: o.from ? w.resolve(String(o.from)) : undefined,
    work: o.work ? w.resolve(String(o.work)) : undefined,
    targetRoot: o['target-root'] ? w.resolve(String(o['target-root'])) : undefined,
    overwrite: !!o.overwrite,
    skipApps: !!o['skip-apps'],
    skipClient: !!o['skip-client'],
    npmCi: o['npm-ci'] ? String(o['npm-ci']) : undefined,
    open: !o['no-open'],
    dryRun: !!o['dry-run'],
    all: !!o.all,
    stepTimeout: stepTimeout(/** @type {string|undefined} */ (o['step-timeout'])),
    dashboard: o['no-dashboard'] ? false : 'window',
  };
}

/** @param {string[]} argv */
export async function main(argv) {
  const { command, opts } = parseArgs(argv);
  const emit = printer();
  if (command === 'help' || opts.help) { console.log(HELP); return 0; }
  if (command === 'dry-run' || (command === 'pack' && opts['dry-run'])) {
    const r = await dryRun(packOptions(opts), emit);
    console.log(`\n${r.text}`);
    return r.problems.length ? 2 : 0;
  }
  if (command === 'pack') {
    const o = packOptions(opts);
    if (!o.out) throw new Error('name the output folder: --out <new local folder>, for example --out C:\\LaptopMove\\bundle');
    const r = await pack(o, emit);
    const files = r.manifest.archives.flatMap((/** @type {any} */ a) => a.parts.map((/** @type {any} */ p) => `  ${p.file}  ${fmtBytes(p.size)}${a.group === 'client' ? '  (client part: Accenture OneDrive only)' : ''}`));
    console.log(`\nUpload every file of ${r.out}:\n${files.join('\n')}\n  laptop-move-kit.zip\n  SHA256SUMS.txt\n  manifest.json\n\nPack report: ${r.report}`);
    return 0;
  }
  if (command === 'restore') {
    const o = restoreOptions(opts);
    if (o.dryRun) {
      const r = await restoreDryRun(o);
      console.log(r.text);
      return r.problems.length ? 2 : 0;
    }
    await restore(o, emit);
    return 0;
  }
  if (command === 'apps') {
    const o = restoreOptions(opts);
    const r = await appsOnly(o, emit);
    if (o.dryRun) for (const a of r.results) console.log(`  ${a.status.padEnd(14)} ${a.name}  ${a.how}${a.detail ? ` ${a.detail}` : ''}`);
    return 0;
  }
  if (command === 'dashboard') {
    const { watchDashboard } = await import('./lib/dashboard.mjs');
    const file = opts.status ? w.resolve(String(opts.status)) : w.join(opts.work ? w.resolve(String(opts.work)) : defaultWork(), 'restore-status.json');
    await watchDashboard(file);
    return 0;
  }
  if (command === 'ui') {
    const { startServer } = await import('./ui/server.mjs');
    const roots = opts['scan-root'] ? String(opts['scan-root']).split(';').map((s) => s.trim()).filter(Boolean).map((p) => w.resolve(p)) : undefined;
    const s = await startServer({
      kitDir,
      selection: opts.selection ? w.resolve(String(opts.selection)) : undefined,
      rulesFile: opts.rules ? w.resolve(String(opts.rules)) : undefined,
      noClientRules: !!opts['no-client-rules'],
      scanRoots: roots,
      appLookup: !opts['no-app-lookup'],
      from: opts.from ? w.resolve(String(opts.from)) : undefined,
      work: opts.work ? w.resolve(String(opts.work)) : undefined,
      open: !opts['no-open'],
      app: !opts['no-app'],
      log: (t) => console.log(t),
    });
    const where = opts['no-app'] || !appBrowser() ? 'in your browser' : 'in a Chrome/Edge app window';
    console.log(opts['no-open']
      ? `Open this link in your browser (it works once, on this computer only):\n  ${s.url}`
      : `The page is open ${where} (on this computer only, port ${s.port}). If it did not open, open this link once:\n  ${s.url}`);
    console.log('Close the page, press End in it, or press Ctrl+C here to end the mover.');
    const stop = () => { console.log('\nEnding the mover.'); void s.close(); };
    process.once('SIGINT', stop);
    await s.closed;
    process.off('SIGINT', stop);
    console.log('The mover has ended.');
    return 0;
  }
  throw new Error(`unknown command ${command} (dry-run, pack, restore, apps, dashboard, ui, help)`);
}

const invoked = process.argv[1] && w.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`\nStopped: ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
