// Where a restore stands, for the people watching it: a log file written line by line as things happen (so a step that
// hangs is the last line), and a small status file the dashboards read (the console window and the page). Both live in
// the work folder: <work>\restore-log.txt and <work>\restore-status.json. Neither ever holds a password: the kit never
// puts one into an event, a command line or a file.
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { fmtLimit } from './util.mjs';

/** The steps of a restore, in their order, as the dashboards name them. */
export const RESTORE_PHASES = [
  { name: '7zip', label: '7-Zip', section: 'sevenzip' },
  { name: 'check', label: 'Check the parts', section: 'parts' },
  { name: 'unpack', label: 'Unpack the parts', section: 'unpack' },
  { name: 'targets', label: 'Make the target folders', section: 'targets' },
  { name: 'apps', label: 'Install the apps', section: 'apps' },
  { name: 'repos', label: 'Clone the repositories', section: 'repos' },
  { name: 'folders', label: 'Put folders and settings back', section: 'units' },
  { name: 'worktrees', label: 'Worktrees', section: 'worktrees' },
  { name: 'links', label: 'Links and junctions', section: 'links' },
  { name: 'npm', label: 'npm ci', section: 'npm' },
  { name: 'extensions', label: 'Editor extensions', section: 'extensions' },
  { name: 'report', label: 'The report', section: null },
];

/** ok, warn or bad for a result's status word. @param {unknown} status */
export function verdict(status) {
  const s = String(status ?? '').toLowerCase();
  if (/fail|damag|missing|refus|timed out|error|stopped/.test(s)) return 'bad';
  if (/hand|conflict|warn|skip|not in|later/.test(s)) return 'warn';
  return 'ok';
}

/** HH:MM:SS of a time. @param {Date|number} [t] */
export function clock(t = new Date()) {
  return new Date(t).toTimeString().slice(0, 8);
}

/** A duration in words: 45 s, 3m 05s, 1h 02m. @param {number} ms */
export function fmtSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r} s`;
}

/**
 * The log: one line per event, appended at once (never buffered), with the time in front.
 * @param {string} file
 * @param {string[]} head the first lines
 */
export function openLog(file, head) {
  /** @param {string} text */
  const line = (text) => { try { appendFileSync(file, `${clock()}  ${text}\n`, 'utf8'); } catch { /* a log never stops the restore */ } };
  try { appendFileSync(file, `${'-'.repeat(100)}\n`, 'utf8'); } catch { /* as above */ }
  for (const h of head) line(h);
  return {
    file,
    line,
    /** @param {any} e an engine event or a command event */
    event(e) {
      if (!e || typeof e !== 'object') return;
      if (e.type === 'phase') line(`== ${e.text ?? e.name}`);
      else if (e.type === 'step') line(`   ${e.text}`);
      else if (e.type === 'warn') line(`   WARNING: ${e.text}`);
      else if (e.type === 'item') line(`   [${e.section}] ${e.status}: ${e.name}${e.detail ? `  (${e.detail})` : ''}`);
      else if (e.type === 'done') line(e.text);
      else if (e.type === 'command' && e.state === 'start') line(`   > ${e.text}${e.limit ? `   (limit ${fmtLimit(e.limit)})` : ''}`);
      else if (e.type === 'command' && e.state === 'end') {
        line(e.timedOut ? `   < TIMED OUT after ${fmtLimit(e.limit ?? e.ms ?? 0)}: stopped with every process it started, skipped: ${e.text}` : `   < exit ${e.code}, ${fmtSpan(e.ms ?? 0)}`);
      }
    },
  };
}

/**
 * The tracker: takes every event of a restore and keeps a snapshot of where it stands. The snapshot is written to the
 * status file and handed to onSnapshot (the page), each at most once a second, and at once when a step starts or the
 * restore ends.
 * @param {{file?: string|null, phases?: {name: string, label: string, section: string|null}[], meta?: Record<string, any>,
 *   onSnapshot?: (s: any) => void, every?: number, now?: () => number}} o
 */
export function createStatus(o = {}) {
  const now = o.now ?? Date.now;
  const every = o.every ?? 1000;
  const phases = (o.phases ?? RESTORE_PHASES).map((p) => ({ ...p, state: 'waiting', startedAt: /** @type {number|null} */ (null), endedAt: /** @type {number|null} */ (null) }));
  const s = {
    kind: 'laptop-move-restore',
    pid: process.pid,
    ...(o.meta ?? {}),
    state: 'running',
    error: /** @type {string|null} */ (null),
    report: /** @type {string|null} */ (null),
    startedAt: now(),
    updatedAt: now(),
    finishedAt: /** @type {number|null} */ (null),
    phases,
    phase: /** @type {string|null} */ (null),
    progress: /** @type {{done: number, total: number, text: string}|null} */ (null),
    step: '',
    command: /** @type {{id: number, text: string, startedAt: number, limit: number|null}|null} */ (null),
    /** @type {Record<string, {total: number|null, counts: Record<string, number>}>} */
    sections: {},
    /** @type {{at: number, section: string, name: string, status: string, detail: string}[]} */
    recent: [],
    /** @type {{at: number, section: string, name: string, status: string, detail: string}[]} */
    problems: [],
    /** @type {{at: number, text: string, limit: number|null}[]} */
    timedOut: [],
    warnings: 0,
    lastWarning: '',
  };
  /** @type {NodeJS.Timeout|null} */ let timer = null;
  let dirty = false;

  const section = (/** @type {string} */ name) => (s.sections[name] ??= { total: null, counts: {} });
  const write = () => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    s.updatedAt = now();
    const snap = JSON.parse(JSON.stringify(s));
    if (o.file) {
      const text = JSON.stringify(snap);
      try { writeFileSync(`${o.file}.tmp`, text, 'utf8'); renameSync(`${o.file}.tmp`, o.file); } catch {
        try { writeFileSync(o.file, text, 'utf8'); } catch { /* the dashboard only misses one update */ }
      }
    }
    try { o.onSnapshot?.(snap); } catch { /* as above */ }
  };
  const touch = (/** @type {boolean} */ atOnce = false) => {
    dirty = true;
    if (atOnce) { if (timer) clearTimeout(timer); write(); return; }
    if (!timer) { timer = setTimeout(write, every); timer.unref?.(); }
  };

  return {
    /** The snapshot as it stands. */
    snapshot: () => JSON.parse(JSON.stringify(s)),
    /** How many items a section will have (for its bar). @param {string} name @param {number} total */
    setTotal(name, total) { section(name).total = total; touch(); },
    /** @param {any} e an engine event or a command event */
    apply(e) {
      if (!e || typeof e !== 'object') return;
      const t = now();
      if (e.type === 'phase') {
        for (const p of phases) if (p.state === 'running') { p.state = 'done'; p.endedAt = t; }
        const p = phases.find((x) => x.name === e.name);
        if (p) { p.state = 'running'; p.startedAt ??= t; p.endedAt = null; }
        s.phase = e.name;
        s.progress = null;
        s.step = '';
        touch(true);
        return;
      }
      if (e.type === 'progress') { s.progress = { done: Number(e.done) || 0, total: Number(e.total) || 0, text: String(e.text ?? '') }; touch(); return; }
      if (e.type === 'step') { s.step = String(e.text ?? ''); touch(); return; }
      if (e.type === 'warn') { s.warnings++; s.lastWarning = String(e.text ?? ''); touch(); return; }
      if (e.type === 'item') {
        const row = { at: t, section: String(e.section ?? ''), name: String(e.name ?? ''), status: String(e.status ?? ''), detail: String(e.detail ?? '') };
        const c = section(row.section).counts;
        c[row.status] = (c[row.status] ?? 0) + 1;
        s.recent.push(row);
        if (s.recent.length > 12) s.recent.splice(0, s.recent.length - 12);
        if (verdict(row.status) === 'bad') { s.problems.push(row); if (s.problems.length > 300) s.problems.splice(0, s.problems.length - 300); }
        touch();
        return;
      }
      if (e.type === 'command' && e.state === 'start') { s.command = { id: e.id, text: String(e.text ?? ''), startedAt: t, limit: e.limit ?? null }; touch(); return; }
      if (e.type === 'command' && e.state === 'end') {
        if (s.command?.id === e.id) s.command = null;
        if (e.timedOut) { s.timedOut.push({ at: t, text: String(e.text ?? ''), limit: e.limit ?? null }); touch(true); return; }
        touch();
      }
    },
    /** The restore has ended. @param {{ok: boolean, error?: string, report?: string|null}} r */
    finish(r) {
      const t = now();
      for (const p of phases) {
        if (p.state === 'running') { p.state = r.ok ? 'done' : 'failed'; p.endedAt = t; }
        else if (p.state === 'waiting') p.state = 'skipped';
      }
      s.state = r.ok ? 'done' : 'failed';
      s.error = r.error ?? null;
      s.report = r.report ?? null;
      s.finishedAt = t;
      s.command = null;
      s.progress = null;
      touch(true);
    },
  };
}
