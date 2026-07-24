// @ts-check
// Demo fixtures (US-033 engine, now driven by the US-036 sandbox interceptor).
// A checked-in fixture is a recorded run the interceptor replays over the same
// event stream a real run uses, so a demo tenant's run plays out for real with
// no Python process, no queue slot and no LLM call. This module only reads and
// matches fixtures; `runs.js` (`startReplay`) does the replaying over the relay.
//
// Fixtures are checked-in source under DEMO_DIR (`demo/<slug>/`), never
// artifacts: meta.json (card copy + verdict), events.ndjson (one event per
// line, each carrying `offset_ms` from run start) and recording.mp4 (the stage
// visual — screencast frames are never persisted, so the replay plays the video
// and fires the step events over it).
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_DIR } from './config.js';

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
    // The test definition behind the fixture — how fixtureForRun matches a
    // demo tenant's run to the clip it should replay (goal + start_url).
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

// The fixture a run replays when its test matches none — a real pass, so an
// arbitrary/edited test in the sandbox still plays out as a plausible success
// rather than an alarming failure. The two seeded fixture tests match exactly
// (below) and never fall here.
export const DEFAULT_FIXTURE = 'register-account';

/**
 * Pick the fixture slug a demo run replays: the one whose meta goal+start_url
 * matches the test exactly (the two seeded fixture tests do), else a goal-only
 * match, else DEFAULT_FIXTURE. Matching is trimmed/case-insensitive so trivial
 * edits don't drop a test to the default.
 * @param {{ goal?: string, start_url?: string }} run
 */
export function fixtureForRun({ goal = '', start_url = '' }) {
  const norm = (/** @type {string} */ s) => (s || '').trim().toLowerCase();
  const g = norm(goal);
  const u = norm(start_url);
  const demos = listDemos();
  const exact = demos.find((d) => norm(d.goal) === g && norm(d.start_url) === u);
  const byGoal = exact || demos.find((d) => norm(d.goal) === g);
  return byGoal?.slug || DEFAULT_FIXTURE;
}
