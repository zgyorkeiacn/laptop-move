// The engine: module functions a CLI or a UI calls. Each long call takes an emit(event) callback:
//   {type: 'phase', name, text}   a new phase starts
//   {type: 'step', text}          one thing done or about to start
//   {type: 'progress', done, total, text, part?}   part: the 7-Zip archive being packed or unpacked (done in percent)
//   {type: 'warn', text}
//   {type: 'done', text, ...}     the call's result follows as its return value
// The password: on the command line 7-Zip asks for it on the console it inherits. A UI passes getPassword (a function
// returning the typed password) to pack and restore: 7-Zip then runs without a console and reads it from a pipe, so
// no argument, file, log or event ever holds it.
export { scan, formatPlan, totals, defaultOut, selectionCandidates, defaultRulesFile, PRINTER_STEP, WIFI_STEP } from './plan.mjs';
export { dryRun, pack, preflight } from './pack.mjs';
export { restore, restoreDryRun, appsOnly, checkParts, loadManifest, defaultWork, defaultFrom } from './restore.mjs';
export { installApps } from './apps.mjs';
export { htmlReport } from './report.mjs';
export { check7z, MIN_VERSION, MIN_PASSWORD, passwordProblem } from './sevenzip.mjs';
export { parseSelection, readSelection, readSelectionRaw, normalizeSelection, saveSelection, MODE_LABELS } from './selection.mjs';
export { discover, KNOWN_SETTINGS } from './discover.mjs';
export { readRules, emptyRules } from './rules.mjs';
export { outProblem, isOneDrive } from './paths.mjs';
