// @ts-check
// What a run IS and where the live ones live: the in-memory registry, and the
// derived views every other module reads a run through. Nothing here talks to
// the DB, the WebSocket or a child process — which is what lets the relay,
// persistence, report and replay modules all import it without a cycle.
//
// The registry is the live relay only; the runs table (db.js) holds the durable
// copy, and a finished run is evicted from here after RUN_TTL_MS.
import { RUN_TTL_MS } from './config.js';

/** @type {Map<string, any>} */
const runs = new Map();

export const TERMINAL = new Set(['passed', 'failed', 'completed', 'error', 'cancelled']);

export function getRun(runId) {
  return runs.get(runId);
}

export function addRun(run) {
  runs.set(run.id, run);
}

/** Every live run, for the scans admission and the queue drain do. */
export function allRuns() {
  return runs.values();
}

// unref: an expiry timer must never hold the process open (e.g. in tests).
export function evictLater(runId) {
  setTimeout(() => runs.delete(runId), RUN_TTL_MS).unref();
}

/**
 * A run's verdict as anything outside the engine should read it — the row, the
 * report JSON, the HTTP shape (US-047).
 *
 * A stopped run has none. browser-use returns history normally out of
 * `Agent.stop()`, so a cancelled run still carries a `done` event with the
 * agent's self-report on it; passing that on is how a run somebody aborted
 * shows up as a pass in History, in the PDF, and in CI's exit code. One
 * function rather than the same ternary in three files, because the three would
 * drift and only two of them are visible from a test.
 */
export function verdictOf(run) {
  if (run.status === 'cancelled') return null;
  return run.result?.success ?? null;
}

/**
 * A run's activity in the one shape everything reads it in: the report file,
 * the PDF renderer and `GET /api/runs/:id/steps` (US-026), whether it comes
 * from the live buffer or from report_data.json. `progress` events are left
 * out — they carry no step number, and the report's step section is keyed on
 * one, so they stay live-only in the Run view's stream.
 */
export function stepsOf(run) {
  return run.events
    .filter((e) => e.type === 'step')
    .map((e) => ({
      step: e.step,
      elapsed: e.elapsed,
      next_goal: e.next_goal,
      evaluation: e.evaluation,
      url: e.url,
      screenshot_file: e.screenshot_file,
    }));
}

/**
 * Why the run failed, in the one shape everything reads it in (US-044): the
 * failed requests, console errors and uncaught exceptions the agent captured,
 * each already scrubbed, capped, deduplicated and stamped with the step it
 * happened during.
 *
 * Flat rather than nested under `stepsOf`, because a finding can arrive before
 * the first step (a page's own load errors do) and would have no step object to
 * hang off. Both renderers group by `step` themselves.
 *
 * `dropped` is the agent's run total, not a sum: each event carries the tally so
 * far, so the last one to arrive is the whole answer. Reading it as a sum would
 * multiply it by the number of steps.
 */
export function diagnosticsOf(run) {
  const events = run.events.filter((e) => e.type === 'diagnostics');
  return {
    diagnostics: events.flatMap((e) => e.entries || []),
    diagnostics_dropped: events.reduce((most, e) => Math.max(most, e.dropped || 0), 0),
  };
}

/** How many steps this run took, from the agent's own count or the buffer. */
export function stepCount(run) {
  return run.result?.steps ?? run.events.filter((e) => e.type === 'step').length;
}
