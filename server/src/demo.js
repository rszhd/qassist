// @ts-check
// Live demo replay (US-033). A canned run played back over the same event
// stream a real run uses, so a visitor with no account can watch the product
// work — with no Python process, no queue slot, no LLM call and no runs row.
//
// Fixtures are checked-in source under DEMO_DIR (`demo/<slug>/`), never
// artifacts: meta.json (card copy + verdict), events.ndjson (one event per
// line, each carrying `offset_ms` from run start) and recording.mp4 (the stage
// visual — screencast frames are never persisted, so the demo plays the video
// and fires the step events over it). This is the one unauthenticated surface;
// it is read-only and fixture-backed by construction — it creates nothing.
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_DIR, DEMO_SPEED } from './config.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const RECORDING_FILE = 'recording.mp4';
export const REPORT_FILE = 'report.pdf';

/**
 * Resolve a fixture directory, refusing anything that isn't a clean slug — the
 * slug reaches here straight off the URL, and DEMO_DIR is joined with it.
 * @param {string} slug
 * @returns {string | null}
 */
function fixtureDir(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  const dir = path.join(DEMO_DIR, slug);
  // Defence in depth over SLUG_RE: the resolved path must stay under DEMO_DIR.
  if (path.relative(DEMO_DIR, dir).startsWith('..')) return null;
  return dir;
}

/**
 * Read and parse a fixture's meta + events, or null if it isn't a usable demo
 * (missing dir, missing/broken meta or events). Never throws.
 * @param {string} slug
 */
export function loadDemo(slug) {
  const dir = fixtureDir(slug);
  if (!dir) return null;
  let meta;
  let lines;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    lines = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').split('\n');
  } catch {
    return null;
  }
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip a malformed line rather than failing the whole replay */
    }
  }
  if (!events.length) return null;
  return {
    slug,
    dir,
    name: meta.name || slug,
    description: meta.description || '',
    verdict: meta.verdict || null,
    // The test definition behind the demo, so the frontend can show a
    // read-only preview of the run form — informational, never runnable.
    goal: meta.goal || '',
    start_url: meta.start_url || '',
    hasRecording: fs.existsSync(path.join(dir, RECORDING_FILE)),
    hasReport: fs.existsSync(path.join(dir, REPORT_FILE)),
    events,
  };
}

/** Absolute path to a fixture's recording, or null if there is none. */
export function recordingPath(slug) {
  return fixtureFile(slug, RECORDING_FILE);
}

/** Absolute path to a fixture's PDF report, or null if there is none. */
export function reportPath(slug) {
  return fixtureFile(slug, REPORT_FILE);
}

/** Resolve one file inside a fixture, or null if the slug or file is bad. */
function fixtureFile(slug, name) {
  const dir = fixtureDir(slug);
  if (!dir) return null;
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

/** The card list the demo picker renders. Skips any dir that won't load. */
export function listDemos() {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(DEMO_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const demos = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const demo = loadDemo(entry.name);
    if (!demo) continue;
    demos.push({
      slug: demo.slug,
      name: demo.name,
      description: demo.description,
      verdict: demo.verdict,
      goal: demo.goal,
      start_url: demo.start_url,
      hasRecording: demo.hasRecording,
      hasReport: demo.hasReport,
    });
  }
  return demos;
}

/**
 * Play a fixture down `ws`, reusing the live event shape so the Run stage needs
 * no second code path. Each event is sent at its recorded offset (scaled by
 * DEMO_SPEED); a final `end` closes the run the way the engine's does. Returns
 * a cancel fn — call it when the socket closes so pending timers don't fire
 * into a dead socket. Sending nothing when the slug is bad is the caller's cue
 * that it already 404'd the upgrade.
 * @param {{ readyState:number, OPEN:number, send(data:string):void, close?():void }} ws
 * @param {string} slug
 * @param {(fn:()=>void, ms:number)=>any} [schedule] injectable timer, for tests
 * @returns {() => void}
 */
export function replayDemo(ws, slug, schedule = setTimeout) {
  const demo = loadDemo(slug);
  if (!demo) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'demo not found' }));
    ws.close?.();
    return () => {};
  }

  /** @type {any[]} */
  const timers = [];
  const send = (evt) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(evt));
  };

  let lastOffset = 0;
  for (const { offset_ms, ...evt } of demo.events) {
    const at = Math.max(0, Number(offset_ms) || 0) / DEMO_SPEED;
    lastOffset = Math.max(lastOffset, at);
    timers.push(schedule(() => send(evt), at));
  }
  // The engine ends a run with `end`; the fixture carries `done`/`error` but
  // not `end` (that is the relay's, not the agent's), so synthesize it here.
  timers.push(schedule(() => send({ type: 'end', status: 'completed', demo: true }), lastOffset));

  return () => {
    for (const t of timers) clearTimeout(t);
  };
}
