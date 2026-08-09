// @ts-check
// What a run IS and where the live ones live: the in-memory registry, and the
// derived views every other module reads a run through. Nothing here talks to
// the DB, the WebSocket or a child process — which is what lets the relay,
// persistence, report and replay modules all import it without a cycle.
//
// The registry is the live relay only; the runs table (db.js) holds the durable
// copy, and a finished run is evicted from here after RUN_TTL_MS.
import { RUN_TTL_MS } from './config.js';

/**
 * @typedef {import('./runEvents.js').RunStatus} RunStatus declared on the wire,
 *   because `end` carries it; TERMINAL below is which five of them are final
 * @typedef {import('./runEvents.js').RunEvent} RunEvent
 * @typedef {'none' | 'generating' | 'ready' | 'error'} ReportStatus
 */

/**
 * A subscriber, as the relay actually uses one: read its state, write a string,
 * hear about the close. Structural rather than `import('ws').WebSocket` because
 * those four members are the entire contract `runRelay.js` has with a socket,
 * and stating it that way is what lets a test drive the relay with a socket it
 * can read back instead of a live one.
 * @typedef {{ readyState: number, OPEN: number, send: (data: string) => void,
 *             on: (event: 'close', fn: () => void) => void }} Viewer
 */

/**
 * What the engine reads off a terminal event, in one shape. Every field is
 * optional because three different things land here: the agent's `done`, its
 * `error`, and a watchdog's own `{ success: false, message }` — and every
 * reader (the row, the report, the mail, the list shape) already coalesces,
 * because a run killed at the memory cap has no `final_result` and never will.
 * @typedef {{ success?: boolean | null, message?: string,
 *             final_result?: string | null, failure_reason?: string | null,
 *             blocked_url?: string | null, steps?: number,
 *             duration_seconds?: number | null, errors?: string[] }} RunResult
 */

/**
 * One live run. The fields up to `createdAt` are set once by `createRun` and
 * describe what was asked for; everything after is the engine's own bookkeeping
 * and appears as the run moves.
 *
 * Three of these never leave this process — `secrets`, `openai_api_key` and
 * `storage_state` are handed to one spawn and are deliberately absent from the
 * row, the events and the report (US-035/US-039/US-043). Their being in this
 * typedef is what makes a new reader of them visible in a diff.
 *
 * @typedef {object} Run
 * @property {string} id
 * @property {string} goal
 * @property {string} start_url
 * @property {number} max_steps
 * @property {string | null} model
 * @property {string | null} test_id
 * @property {Record<string, string>} variables
 * @property {import('./navigationPolicy.js').Policy} policy resolved, in-memory only
 * @property {string | null} project_id owning project — the fixture whitelist alone
 * @property {Record<string, string>} secrets real values, never persisted
 * @property {boolean} har whether this run also writes a full HAR
 * @property {string | null} openai_api_key BYOK, never persisted
 * @property {string | null} storage_state decrypted session blob, never persisted
 * @property {import('./browserSession.js').SessionMaterial['verify']} session_verify
 *   the expiry check the agent runs on the first step
 * @property {string | null} capture_session_id the session a PASS here refreshes
 * @property {import('./browserSession.js').PreambleAction[]} preamble
 *   deterministic actions to run before step 1
 * @property {string | null} user_id
 * @property {string} trigger
 * @property {string | null} schedule_id set by the scheduler tick alone
 * @property {Date | null} scheduled_for
 * @property {RunStatus} status
 * @property {RunEvent[]} events the durable buffer a late viewer is replayed
 * @property {Set<Viewer>} subscribers
 * @property {RunResult | null} result
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 * @property {import('node:child_process').ChildProcess} [child] absent on a queued or replayed run
 * @property {NodeJS.Timeout} [memWatch]
 * @property {NodeJS.Timeout} [timeoutWatch]
 * @property {NodeJS.Timeout | null} [stopTimer] the stop grace window (US-047)
 * @property {boolean} [cancelling] a stop was asked for; the status follows later
 * @property {ReportStatus} [reportStatus]
 * @property {string} [reportPath]
 * @property {string} [recordingFile]
 * @property {import('./runEvents.js').FrameEvent} [lastFrame] live-only, latest wins
 * @property {import('./runEvents.js').QueuedEvent | null} [queueEvent] live-only queue position
 * @property {Promise<unknown>} [persisted] the chain every DB write for this run joins
 * @property {boolean} [notified] the one mail per finished run has been sent
 * @property {string} [demoSlug] which fixture a replay is driven from (US-036)
 * @property {boolean} [reportReady] a replay linked the fixture's PDF
 */

/** @type {Map<string, Run>} */
const runs = new Map();

export const TERMINAL = new Set(['passed', 'failed', 'completed', 'error', 'cancelled']);

/** @param {string} runId */
export function getRun(runId) {
  return runs.get(runId);
}

/** @param {Run} run */
export function addRun(run) {
  runs.set(run.id, run);
}

/** Every live run, for the scans admission and the queue drain do. */
export function allRuns() {
  return runs.values();
}

// unref: an expiry timer must never hold the process open (e.g. in tests).
/** @param {string} runId */
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
 * @param {Run} run
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
 * @param {Run} run
 */
export function stepsOf(run) {
  return run.events
    .filter((e) => e.type === 'step')
    .map((e) => ({
      step: e.step,
      elapsed: e.elapsed,
      // Where the step starts in the recording, which `elapsed` is not (US-076)
      // — undefined for a run recorded before that shipped, and the readers
      // treat that as "no seek" rather than guessing from the wall clock.
      video_seconds: e.video_seconds,
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
 * @param {Run} run
 */
export function diagnosticsOf(run) {
  const events = run.events.filter((e) => e.type === 'diagnostics');
  return {
    diagnostics: events.flatMap((e) => e.entries || []),
    diagnostics_dropped: events.reduce((most, e) => Math.max(most, e.dropped || 0), 0),
  };
}

/**
 * How many steps this run took, from the agent's own count or the buffer.
 * @param {Run} run
 */
export function stepCount(run) {
  return run.result?.steps ?? run.events.filter((e) => e.type === 'step').length;
}
