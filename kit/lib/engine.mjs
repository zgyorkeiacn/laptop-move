// The engine: module functions a CLI or a UI calls. Each long call takes an emit(event) callback:
//   {type: 'phase', name, text}   a new phase starts
//   {type: 'step', text}          one thing done or about to start
//   {type: 'progress', done, total, text}
//   {type: 'warn', text}
//   {type: 'done', text, ...}     the call's result follows as its return value
// 7-Zip asks for the password on the console it inherits, so pack and restore need a terminal (a UI opens one).
export { scan, formatPlan, totals, defaultOut, selectionCandidates } from './plan.mjs';
export { dryRun, pack, preflight } from './pack.mjs';
export { restore, restoreDryRun, appsOnly, checkParts, loadManifest, defaultWork, defaultFrom } from './restore.mjs';
export { installApps } from './apps.mjs';
export { htmlReport } from './report.mjs';
export { check7z, MIN_VERSION } from './sevenzip.mjs';
export { parseSelection, readSelection } from './selection.mjs';
