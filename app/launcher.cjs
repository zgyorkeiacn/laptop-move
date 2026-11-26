'use strict';
// Laptop Mover.exe: the entry point written into the Node single executable (scripts\package.mjs). The kit stays as
// files in kit\ next to the exe, because pack copies them into laptop-move-kit.zip. With no command the exe starts the
// guided page in a Chrome/Edge app window; with one it is the command line (Laptop Mover.exe pack --out ..., help).
// Inside the executable import() reaches built-in modules only, so the kit is loaded with require() of its ES module.
const path = require('node:path');
const { createRequire } = require('node:module');

const appDir = path.dirname(process.execPath);
const kitFile = path.join(appDir, 'kit', 'kit.mjs');
let args = process.argv.slice(2);
// The restore's dashboard window starts process.execPath with kit.mjs first, as it would node.exe.
if (args[0] && /(^|[\\/])kit\.mjs$/i.test(args[0])) args = args.slice(1);
const doubleClicked = args.length === 0;
if (doubleClicked) args = ['ui'];

/** A double-clicked console closes at exit: keep it open until Enter so the message can be read. */
function pause() {
  if (!doubleClicked || !process.stdin.isTTY) return Promise.resolve();
  process.stdout.write('\nPress Enter to close this window.');
  return new Promise((resolve) => { process.stdin.resume(); process.stdin.once('data', resolve); });
}

async function start() {
  /** @type {{main: (argv: string[]) => Promise<number>}} */
  const kit = createRequire(kitFile)(kitFile);
  return kit.main(args);
}

start().then(async (code) => {
  process.exitCode = code;
  if (code) await pause();
  process.exit();
}, async (e) => {
  console.error(`\nStopped: ${e?.message ?? e}`);
  process.exitCode = 1;
  await pause();
  process.exit();
});
